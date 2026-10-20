import { financialPolicy, allowData } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import { companyPolicyEnvironment } from "../financial-data/company-policy.ts";
import { deriveCompany, REPORT_QUARTERS_VERSION } from "../financial-data/derived.ts";
import { ARCHIVE_PREFIX, disclosureAuditPrefix, PRUNE_GRACE_MS, pruneSupersededArchives } from "../financial-data/disclosure-audit.ts";
import type { AnalysisEnv } from "../operations.ts";
import { logStatements } from "./log.ts";
import type { TaskMessage } from "./messages.ts";
import { delaySeconds } from "./router.ts";
import type { TaskName } from "./registry.ts";
import { FINANCIAL_TASKS } from "./financial-tasks.ts";
import { SEC_TASKS } from "./sec-tasks.ts";
import { AI_TASKS } from "./ai-tasks.ts";
import { PRESENTATION_TASKS } from "./presentation-task.ts";
import { LIBRARY_TASKS } from "./library-tasks.ts";
import { TRANSLATION_TASKS } from "./translation-tasks.ts";
import { PEERS_VERSION, publishPeers } from "../peers/projection.ts";

/** `later`: the run is not finished (budget spent, input not ready); it runs again after `afterMs`. */
export type TaskOutcome = { status: "done"; detail?: unknown } | { status: "later"; afterMs: number; detail?: unknown };
/** `trigger`: the cause of the newest trigger behind this run (the due row's `cause_id`), null for a replay without one. */
export type TaskContext = { causeId: string; now: Date; trigger: string | null };
export type TaskImplementation = {
  /** Changing it re-runs the task for every company in its scope once, on the first invocation of the new code. */
  version: string;
  run(env: AnalysisEnv, ticker: string, context: TaskContext): Promise<TaskOutcome>;
};

async function isDataCompany(env: AnalysisEnv, ticker: string): Promise<boolean> {
  const policyEnv = await companyPolicyEnvironment(env);
  return allowData(financialPolicy({ SEC_DATA_TICKERS: policyEnv.SEC_DATA_TICKERS, SEC_TRACKED_TICKERS: policyEnv.SEC_TRACKED_TICKERS, SEC_AI_ENABLED: "false" }), ticker);
}

type R2Prunable = AnalysisEnv["SEC_FILINGS"] & {
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string; uploaded: Date }>; truncated: boolean; cursor?: string }>;
  delete(keys: string[]): Promise<unknown>;
};

export const TASK_IMPLEMENTATIONS: Record<TaskName, TaskImplementation> = {
  ...FINANCIAL_TASKS,
  ...SEC_TASKS,
  ...AI_TASKS,
  ...LIBRARY_TASKS,
  ...TRANSLATION_TASKS,
  ...PRESENTATION_TASKS,

  "map-derive": {
    // Which archived filings are read changes without the parsed quarters changing: v3 reads every filing in a filing-date window.
    version: `map-derive.v3:${REPORT_QUARTERS_VERSION}`,
    async run(env, ticker, { causeId }) {
      if (!await isDataCompany(env, ticker)) return { status: "done", detail: { skipped: "not a data company" } };
      const result = await deriveCompany({ DB: env.DB!, SEC_FILINGS: env.SEC_FILINGS }, ticker, undefined, causeId);
      // Filings beyond this run's parse budget are parsed by the next run, right away.
      return result.pending ? { status: "later", afterMs: 1000, detail: result } : { status: "done", detail: result };
    },
  },

  "archive-prune": {
    version: "archive-prune.v1",
    async run(env, ticker, { now }) {
      const db = env.DB!;
      const rows = (await db.prepare("SELECT key, superseded_at FROM pipeline_superseded WHERE ticker = ? ORDER BY superseded_at").bind(ticker).all<{ key: string; superseded_at: string }>()).results;
      const cutoff = now.getTime() - PRUNE_GRACE_MS;
      const ripe = rows.filter(row => Date.parse(row.superseded_at) <= cutoff).slice(0, 300);
      let deleted = 0;
      if (ripe.length) {
        // A copy is kept if a current pointer or a transcript still names it.
        const prefix = disclosureAuditPrefix(ticker);
        const pointers = (await db.prepare("SELECT json_extract(payload, '$.rawKey') raw, json_extract(payload, '$.inventoryKey') inventory, json_extract(payload, '$.statementsKey') statements FROM sec_cache WHERE cache_key >= ? AND cache_key < ?")
          .bind(prefix, prefix.slice(0, -1) + ";").all<{ raw: string | null; inventory: string | null; statements: string | null }>()).results;
        const transcripts = (await db.prepare("SELECT raw_key FROM company_transcripts WHERE raw_key IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ripe.map(r => r.key))).all<{ raw_key: string }>()).results;
        const kept = new Set([...pointers.flatMap(p => [p.raw, p.inventory, p.statements]), ...transcripts.map(t => t.raw_key)]);
        const doomed = ripe.map(r => r.key).filter(key => key.startsWith(ARCHIVE_PREFIX) && !kept.has(key));
        if (doomed.length) await (env.SEC_FILINGS as R2Prunable).delete(doomed);
        deleted = doomed.length;
        await db.prepare("DELETE FROM pipeline_superseded WHERE key IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ripe.map(r => r.key))).run();
      }
      const waiting = rows.filter(row => !ripe.includes(row));
      const detail = { deleted, kept: ripe.length - deleted, waiting: waiting.length };
      if (!waiting.length) return { status: "done", detail };
      // More than a batch was ripe, or the rest is still inside its grace period.
      const oldest = Date.parse(waiting[0]!.superseded_at);
      return { status: "later", afterMs: Math.max(1000, oldest + PRUNE_GRACE_MS - now.getTime()), detail };
    },
  },

  // Every data company's comparable figures in one record, rebuilt from stored projections whenever a map snapshot
  // or the SEC fundamentals change; the debounce folds a burst of companies into one rebuild.
  "peers": {
    version: PEERS_VERSION,
    async run(env, _ticker, { now }) {
      return { status: "done", detail: await publishPeers(env, now) };
    },
  },

  "archive-prune-scan": {
    version: "archive-prune-scan.v1",
    async run(env, _ticker, { now }) {
      const result = await pruneSupersededArchives({ DB: env.DB!, SEC_FILINGS: env.SEC_FILINGS as R2Prunable }, now);
      return result.finished ? { status: "done", detail: result } : { status: "later", afterMs: 1000, detail: result };
    },
  },
};

type DueRow = { due_at: string; first_requested_at: string; cause_id: string | null };

/**
 * Runs one task message if it is still the current one for its company and task. A message is stale when
 * `pipeline_due` moved on (a newer trigger pushed the run back) or is gone (the run already happened). A message
 * that arrives early, because a queue delay is capped at a day, is sent on again for the remainder.
 * The due row is deleted only after the run succeeds, so a failure leaves it for the queue's retry.
 */
export async function runTaskMessage(env: AnalysisEnv, message: TaskMessage, now = new Date()): Promise<{ outcome: string; detail?: unknown }> {
  const db = env.DB!;
  const row = await db.prepare("SELECT due_at, first_requested_at, cause_id FROM pipeline_due WHERE ticker = ? AND task = ?").bind(message.ticker, message.task).first<DueRow>();
  if (!row || row.due_at !== message.dueAt) return { outcome: "superseded" };
  if (Date.parse(row.due_at) > now.getTime() + 1000) {
    await env.PIPELINE_TASKS!.send(message, { contentType: "json", delaySeconds: delaySeconds(row.due_at, now.getTime()) });
    return { outcome: "deferred" };
  }
  const started = Date.now();
  let outcome: TaskOutcome;
  try {
    outcome = await TASK_IMPLEMENTATIONS[message.task].run(env, message.ticker, { causeId: message.id, now, trigger: row.cause_id ?? null });
  } catch (error) {
    await db.batch(logStatements(db, { messageId: message.id, causeId: message.causeId, kind: "task", name: message.task, ticker: message.ticker,
      outcome: "failed", detail: { error: error instanceof Error ? error.message : String(error) } }));
    throw error;
  }
  const at = new Date().toISOString();
  const log = logStatements(db, { messageId: message.id, causeId: message.causeId, kind: "task", name: message.task, ticker: message.ticker,
    outcome: outcome.status, detail: { ...(typeof outcome.detail === "object" && outcome.detail ? outcome.detail : { value: outcome.detail }), ms: Date.now() - started } }, at);
  if (outcome.status === "done") {
    // A trigger that arrived during the run moved due_at; its row and message stay for the next run.
    await db.batch([db.prepare("DELETE FROM pipeline_due WHERE ticker = ? AND task = ? AND due_at = ?").bind(message.ticker, message.task, row.due_at), ...log]);
    return { outcome: "done", detail: outcome.detail };
  }
  const dueAt = new Date(Date.now() + outcome.afterMs).toISOString();
  // The continuation is sent before the due row moves to it. Sent first, a failed send leaves the row where this message
  // can run again on the queue's retry; moved first, the retry would find the row moved, call itself superseded, and the
  // task would never run again. A message whose row did not move (a newer trigger did) arrives superseded: harmless.
  await env.PIPELINE_TASKS!.send({ ...message, id: crypto.randomUUID(), causeId: message.id, dueAt }, { contentType: "json", delaySeconds: delaySeconds(dueAt, Date.now()) });
  await db.batch([
    db.prepare("UPDATE pipeline_due SET due_at = ?, first_requested_at = ? WHERE ticker = ? AND task = ? AND due_at = ?").bind(dueAt, at, message.ticker, message.task, row.due_at),
    ...log,
  ]);
  return { outcome: "later", detail: outcome.detail };
}
