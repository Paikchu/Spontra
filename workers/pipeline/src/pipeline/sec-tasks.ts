import { readEventsPublication } from "../../../../shared/analysis-runtime/events.ts";
import { AiRunStore, quietly } from "../ai-runs/store.ts";
import { refreshCompanyEvents, secAccessPaused } from "../events/workflow.ts";
import { eventsCacheKey } from "../events/read.ts";
import { guidanceWorkflowSuffix } from "../guidance/extract.ts";
import { GuidanceStore } from "../guidance/store.ts";
import { earningsEvents } from "../guidance/workflow.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { SecFilingFeed } from "../sec/sec.ts";
import type { TaskImplementation, TaskOutcome } from "./tasks.ts";
import { driveWorkflow, type WorkflowBindingLike } from "./workflow-task.ts";

const SECOND = 1000, MINUTE = 60 * SECOND;

export const SEC_TASKS = {
  /**
   * Runs the SEC report Workflow for an AI company with a new filing: it indexes the filing list (`filings.indexed`),
   * writes reports and 8-K summaries (`report.published`) and the SEC fundamentals (`fundamentals.updated`). A run
   * already in progress started before this filing, so the task waits for it and then starts its own (driveWorkflow
   * evaluates `start` again when the trigger moved during the run).
   */
  "sec-report": {
    version: "sec-report.v2-english",
    async run(env, ticker, { now, trigger }): Promise<TaskOutcome> {
      return driveWorkflow(env, `sec-report:${ticker}`, env.SEC_ANALYSIS_WORKFLOW as WorkflowBindingLike, async () => {
        const active = await env.DB!.prepare("SELECT job_id FROM sec_analysis_jobs WHERE ticker = ? AND status IN ('running', 'queued') AND updated_at >= ? LIMIT 1")
          .bind(ticker, new Date(now.getTime() - 2 * 60 * MINUTE).toISOString()).first();
        if (active) return { status: "later", afterMs: 10 * MINUTE, detail: { waiting: "an analysis is already running" } };
        return { id: `scheduled-${ticker}-${now.getTime()}`, params: { ticker, requestedBy: "scheduled", backfill: false } };
      }, { trigger });
    },
  },

  /**
   * Records the company's earnings 8-Ks from the indexed filing list and starts guidance extraction for those not yet
   * processed, two at a time; each Workflow publishes on its own (`guidance.published`).
   */
  guidance: {
    version: "guidance.v2",
    async run(env, ticker, { now }): Promise<TaskOutcome> {
      if (env.GUIDANCE_ENABLED !== "true" || !env.GUIDANCE_WORKFLOW) return { status: "done", detail: { skipped: "guidance disabled" } };
      const db = env.DB!, stamp = now.toISOString();
      const store = new GuidanceStore(db, env.SEC_FILINGS);
      const feed = (await new D1SecRepository(db).getCache<SecFilingFeed>(`sec:filings:${ticker}`))?.payload ?? null;
      const events = earningsEvents(feed, now.getTime());
      await store.recordEvents(ticker, events, stamp);
      const queued = await store.queuedEvents([ticker], 2);
      const started: string[] = [];
      for (const event of queued) {
        const id = `guidance-${event.ticker.replace(/[^A-Za-z0-9]/g, "-")}-${event.accession}-${guidanceWorkflowSuffix()}`;
        try {
          await env.GUIDANCE_WORKFLOW.create({ id, params: { ticker: event.ticker, accession: event.accession, eventDate: event.event_date } });
          await quietly(() => new AiRunStore(db).start({ kind: "guidance", ticker: event.ticker, runId: id, trigger: "schedule", accession: event.accession }, stamp));
        } catch (error) {
          if (!/already exists|duplicate/i.test(String(error))) throw error;
        }
        await store.updateEvent(event.ticker, event.accession, { status: "started", workflowInstanceId: id }, stamp);
        started.push(event.accession);
      }
      const detail = { recorded: events.length, started };
      return queued.length >= 2 ? { status: "later", afterMs: SECOND, detail } : { status: "done", detail };
    },
  },

  /**
   * Rebuilds the company's event rail: a new filing re-reads EDGAR's list, and pending Form 4 and exhibit reads
   * continue a bounded number per run for as long as they make progress.
   */
  events: {
    version: "events.v1",
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
