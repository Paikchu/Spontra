import { readEventsPublication } from "../../../../shared/analysis-runtime/events.ts";
import { refreshCompanyEvents, secAccessPaused } from "../events/workflow.ts";
import { eventsCacheKey } from "../events/read.ts";
import { refreshSecFundamentals } from "../fundamentals/refresh.ts";
import { scheduledAnalysisAllowed } from "../core.ts";
import { startFilingRuns } from "../filing-analysis/start.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { TaskImplementation, TaskOutcome } from "./tasks.ts";

const SECOND = 1000, MINUTE = 60 * SECOND;

export const SEC_TASKS = {
  /**
   * Re-reads Company Facts after new statements are published (fundamentals/refresh.ts): a later quarter replaces the
   * stored snapshot and emits `fundamentals.updated`; while Company Facts is behind the filing, the run comes back.
   */
  fundamentals: {
    version: "fundamentals.v1",
    async run(env, ticker, { now, causeId }): Promise<TaskOutcome> {
      const result = await refreshSecFundamentals({ DB: env.DB!, SEC_USER_AGENT: env.SEC_USER_AGENT }, ticker, fetch, now, causeId);
      return result.status === "behind" && result.retryAfterMs ? { status: "later", afterMs: result.retryAfterMs, detail: result } : { status: "done", detail: result };
    },
  },
  /**
   * Hands the company's filings to the analysis path (filing-analysis/). Each ready filing becomes a Pi session that
   * runs and publishes on its own, so this task only starts them and is done.
   */
  "filing-analysis": {
    version: "filing-analysis.v2",
    async run(env, ticker): Promise<TaskOutcome> {
      if (!scheduledAnalysisAllowed(env, { ticker, requestedBy: "scheduled" })) return { status: "done", detail: { skipped: "reports are off for this company" } };
      return { status: "done", detail: await startFilingRuns(env, ticker, { requestedBy: "scheduled" }) };
    },
  },

  /**
   * Rebuilds the company's event rail: a new filing re-reads EDGAR's list, and pending Form 4 and exhibit reads
   * continue a bounded number per run for as long as they make progress.
   */
  events: {
    // v2: the run also indexes the filings list, which a company without the report summaries had none of.
    // v3: the rail lists offerings (S-3, 424B, FWP) and proxy statements.
    // v4: a program issuer is told by its offerings' pace, not their count, so a frequent raiser's supplements are key.
    version: "events.v4-offering-pace",
    async run(env, ticker, { now, causeId }): Promise<TaskOutcome> {
      if (env.EVENTS_ENABLED === "false") return { status: "done", detail: { skipped: "events disabled" } };
      const stored = await new D1SecRepository(env.DB!).getCache<unknown>(eventsCacheKey(ticker));
      const publication = stored ? readEventsPublication(stored.payload, ticker) : null;
      // A run moments after the last one is a continuation; anything later was triggered by a new filing. Form 4
      // filings still unread are not in the stored rail, so while any are pending the list is read again too.
      const forceList = !publication || publication.pendingInsider > 0 || now.getTime() - Date.parse(publication.checkedAt) > MINUTE;
      let result: Awaited<ReturnType<typeof refreshCompanyEvents>>;
      // SEC paused this client (403/429): a wait, not a failure to retry at once and dead-letter.
      try { result = await refreshCompanyEvents(env, ticker, fetch, now, { forceList, causeId }); }
      catch (error) { if (secAccessPaused(error)) return { status: "later", afterMs: 15 * MINUTE, detail: { waiting: "SEC access paused" } }; throw error; }
      return result.pending && result.progressed ? { status: "later", afterMs: 2 * SECOND, detail: result } : { status: "done", detail: result };
    },
  },
} satisfies Record<string, TaskImplementation>;
