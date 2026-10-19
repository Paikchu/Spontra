import { readEventsPublication } from "../../../../shared/analysis-runtime/events.ts";
import { AiRunStore, quietly } from "../ai-runs/store.ts";
import { refreshCompanyEvents, secAccessPaused } from "../events/workflow.ts";
import { eventsCacheKey } from "../events/read.ts";
import { guidanceWorkflowSuffix } from "../guidance/extract.ts";
import { GuidanceStore } from "../guidance/store.ts";
import { earningsEvents, publishGuidance } from "../guidance/workflow.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { SecFilingFeed } from "../sec/sec.ts";
import type { TaskImplementation, TaskOutcome } from "./tasks.ts";
import { driveWorkflow, FAILED_INPUT_RETRY_WAITS_MS, failedInputKey, pendingRetryOutcome, type WorkflowBindingLike } from "./workflow-task.ts";

/** Per earnings release, how many guidance runs failed and when the next may start (null once the retries are spent). */
type GuidanceRetries = { events: Record<string, { attempts: number; retryAt: string | null; failure: string }> };

/**
 * Guidance runs that ended without finishing their event: an errored or terminated instance leaves its event `started`,
 * which nothing else picks up again. Each is marked `failed` and retried after 1, 6 and 24 hours under a new instance id
 * (`-r<n>` before the extractor suffix, so it still counts as the current version); then it is a dead letter. The
 * retry state lives under the task's failed-input key, so replaying the dead letter resets it.
 */
async function reconcileGuidance(env: Parameters<typeof driveWorkflow>[0], ticker: string, causeId: string, now: Date): Promise<{ retry: Array<{ accession: string; eventDate: string; attempt: number }>; nextAt: number | null }> {
  const db = env.DB!, repository = new D1SecRepository(db), key = failedInputKey("guidance", ticker);
  const state = (await repository.getCache<GuidanceRetries>(key))?.payload ?? { events: {} };
  let changed = false;
  if (env.GUIDANCE_WORKFLOW?.get) {
    const running = (await db.prepare("SELECT accession, workflow_instance_id FROM earnings_events WHERE ticker = ? AND status = 'started' AND workflow_instance_id IS NOT NULL")
      .bind(ticker).all<{ accession: string; workflow_instance_id: string }>()).results;
    for (const row of running) {
      let status: { status: string; error?: unknown };
      try { status = await (await env.GUIDANCE_WORKFLOW.get(row.workflow_instance_id)).status(); } catch { continue; }
      if (!["errored", "terminated"].includes(status.status)) continue;
      const failure = `Workflow ${row.workflow_instance_id} ${status.status}: ${String((status.error as { message?: string } | undefined)?.message ?? "").slice(0, 300)}`;
      const attempts = (state.events[row.accession]?.attempts ?? 0) + 1;
      const wait = FAILED_INPUT_RETRY_WAITS_MS[attempts - 1];
      state.events[row.accession] = { attempts, failure, retryAt: wait === undefined ? null : new Date(now.getTime() + wait).toISOString() };
      await new GuidanceStore(db, env.SEC_FILINGS).updateEvent(ticker, row.accession, { status: "failed" }, now.toISOString());
      changed = true;
      if (wait === undefined) {
        const id = crypto.randomUUID(), at = now.toISOString();
        console.error(JSON.stringify({ event: "pipeline-dead", task: "guidance", ticker, accession: row.accession, attempts, failure }));
        await db.prepare("INSERT INTO pipeline_dead (id, kind, name, ticker, body, attempts, created_at) VALUES (?, 'task', 'guidance', ?, ?, ?, ?)")
          .bind(id, ticker, JSON.stringify({ v: 1, kind: "task", id, causeId, task: "guidance", ticker, dueAt: at }), attempts - 1, at).run();
      } else console.warn(JSON.stringify({ event: "pipeline-retry", task: "guidance", ticker, accession: row.accession, attempts, retryAt: state.events[row.accession]!.retryAt, failure }));
    }
  }
  // A replayed dead letter removed the state: its failed events start over.
  const failed = (await db.prepare("SELECT accession, event_date FROM earnings_events WHERE ticker = ? AND status = 'failed' AND workflow_instance_id LIKE ?")
    .bind(ticker, `%-${guidanceWorkflowSuffix()}`).all<{ accession: string; event_date: string }>()).results;
  const retry: Array<{ accession: string; eventDate: string; attempt: number }> = [];
  let nextAt: number | null = null;
  for (const row of failed) {
    const entry = state.events[row.accession];
    // The instance id must be new (the old ones exist, failed): a replay is tagged with its time.
    if (!entry) { retry.push({ accession: row.accession, eventDate: row.event_date, attempt: Math.floor(now.getTime() / 1000) }); continue; }
    if (!entry.retryAt) continue;
    const at = Date.parse(entry.retryAt);
    if (at <= now.getTime()) retry.push({ accession: row.accession, eventDate: row.event_date, attempt: entry.attempts });
    else nextAt = nextAt === null ? at : Math.min(nextAt, at);
  }
  if (changed) await repository.setCache(key, state, now.toISOString());
  return { retry, nextAt };
}

/**
 * The filings a finished SEC report run failed on: the Workflow records a failed filing in `sec_analysis_jobs` and goes
 * on with the next, so its instance completes either way. A run with failures is a failed run for the task.
 */
async function failedReports(db: D1Database, instanceId: string): Promise<{ failure: string; fingerprint: string } | null> {
  const rows = (await db.prepare("SELECT accession_number, error_code FROM sec_analysis_jobs WHERE workflow_instance_id = ? AND status = 'failed' ORDER BY accession_number")
    .bind(instanceId).all<{ accession_number: string; error_code: string | null }>()).results;
  if (!rows.length) return null;
  return { failure: rows.map(r => `${r.accession_number}:${r.error_code ?? "failed"}`).join(", "), fingerprint: rows.map(r => r.accession_number).join(",") };
}

const SECOND = 1000, MINUTE = 60 * SECOND;

export const SEC_TASKS = {
  /**
   * Runs the SEC report Workflow for an AI company with a new filing: it indexes the filing list (`filings.indexed`),
   * writes reports and 8-K summaries (`report.published`) and the SEC fundamentals (`fundamentals.updated`). A run
   * already in progress started before this filing, so the task waits for it and then starts its own (driveWorkflow
   * evaluates `start` again when the trigger moved during the run). A run that failed on a filing is run again after
   * 1, 6 and 24 hours (the next run analyses the failed filings again), then becomes a dead letter.
   */
  "sec-report": {
    // v3: the run writes each periodic filing's fiscal period from Company Facts, which guidance dates its items by.
    version: "sec-report.v3-fiscal-periods",
    async run(env, ticker, { now, trigger, causeId }): Promise<TaskOutcome> {
      return driveWorkflow(env, `sec-report:${ticker}`, env.SEC_ANALYSIS_WORKFLOW as WorkflowBindingLike, async () => {
        const waiting = await pendingRetryOutcome(env, "sec-report", ticker, now);
        if (waiting) return waiting;
        const active = await env.DB!.prepare("SELECT job_id FROM sec_analysis_jobs WHERE ticker = ? AND status IN ('running', 'queued') AND updated_at >= ? LIMIT 1")
          .bind(ticker, new Date(now.getTime() - 2 * 60 * MINUTE).toISOString()).first();
        if (active) return { status: "later", afterMs: 10 * MINUTE, detail: { waiting: "an analysis is already running" } };
        return { id: `scheduled-${ticker}-${now.getTime()}`, params: { ticker, requestedBy: "scheduled", backfill: false } };
      }, { trigger, deadLetter: { task: "sec-report", ticker, causeId }, verify: id => failedReports(env.DB!, id) });
    },
  },

  /**
   * Records the company's earnings 8-Ks from the indexed filing list and starts guidance extraction for those not yet
   * processed, two at a time; each Workflow publishes on its own (`guidance.published`). With every event settled, the
   * view is published again only if a rebuild reads differently.
   */
  guidance: {
    version: "guidance.v2",
    async run(env, ticker, { now, causeId }): Promise<TaskOutcome> {
      if (env.GUIDANCE_ENABLED !== "true" || !env.GUIDANCE_WORKFLOW) return { status: "done", detail: { skipped: "guidance disabled" } };
      const db = env.DB!, stamp = now.toISOString();
      const store = new GuidanceStore(db, env.SEC_FILINGS);
      const feed = (await new D1SecRepository(db).getCache<SecFilingFeed>(`sec:filings:${ticker}`))?.payload ?? null;
      const events = earningsEvents(feed, now.getTime());
      await store.recordEvents(ticker, events, stamp);
      const reconciled = await reconcileGuidance(env, ticker, causeId, now);
      const queued = [
        ...reconciled.retry.slice(0, 2).map(r => ({ ticker, accession: r.accession, event_date: r.eventDate, attempt: r.attempt })),
        ...(await store.queuedEvents([ticker], 2)).map(e => ({ ...e, attempt: 0 })),
      ].slice(0, 2);
      const started: string[] = [];
      for (const event of queued) {
        const id = `guidance-${event.ticker.replace(/[^A-Za-z0-9]/g, "-")}-${event.accession}-${event.attempt ? `r${event.attempt}-` : ""}${guidanceWorkflowSuffix()}`;
        try {
          await env.GUIDANCE_WORKFLOW.create({ id, params: { ticker: event.ticker, accession: event.accession, eventDate: event.event_date } });
          await quietly(() => new AiRunStore(db).start({ kind: "guidance", ticker: event.ticker, runId: id, trigger: "schedule", accession: event.accession }, stamp));
        } catch (error) {
          if (!/already exists|duplicate/i.test(String(error))) throw error;
        }
        await store.updateEvent(event.ticker, event.accession, { status: "started", workflowInstanceId: id }, stamp);
        started.push(event.accession);
      }
      if (queued.length >= 2) return { status: "later", afterMs: SECOND, detail: { recorded: events.length, started, retried: reconciled.retry.length } };
      // A run still going may yet fail, and a failed one has a retry due: come back for both.
      const running = await db.prepare("SELECT 1 FROM earnings_events WHERE ticker = ? AND status = 'started' LIMIT 1").bind(ticker).first();
      // Every event settled: the view is rebuilt when an input it reads moved since it was published, such as the
      // fiscal periods a new filing list brings, which date the items.
      const republished = !started.length && !running && (await publishGuidance(env, ticker, stamp, { onlyIfChanged: true })).published;
      const detail = { recorded: events.length, started, retried: reconciled.retry.length, republished };
      const untilRetry = reconciled.nextAt === null ? null : Math.max(SECOND, reconciled.nextAt - now.getTime());
      const afterMs = running ? Math.min(untilRetry ?? Infinity, 30 * MINUTE) : untilRetry;
      return afterMs === null ? { status: "done", detail } : { status: "later", afterMs, detail };
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
