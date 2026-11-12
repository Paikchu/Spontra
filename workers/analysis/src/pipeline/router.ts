import { dataTickers } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import { companyPolicyEnvironment, featureTickersFor } from "../financial-data/company-policy.ts";
import type { AnalysisEnv } from "../operations.ts";
import { logStatements } from "./log.ts";
import type { EventMessage, TaskMessage } from "./messages.ts";
import { SUBSCRIPTIONS, TASKS, type TaskName, type TaskScope } from "./registry.ts";
import { revisionStatements } from "./revisions.ts";
import { messageStatements } from "../admin/messages.ts";
import { beforePause, scheduledAnalysisPauses } from "./scheduled-analysis.ts";

/** The companies a task covers, for a version change that re-runs it everywhere. */
export async function scopeTickers(env: AnalysisEnv, scope: TaskScope): Promise<string[]> {
  if (scope === "global") return ["*"];
  if (scope === "publication") {
    const rows = await env.DB!.prepare(`SELECT DISTINCT ticker FROM (
      SELECT ticker FROM publication_revisions UNION SELECT ticker FROM analysis_artifacts WHERE published_version IS NOT NULL
    ) WHERE ticker <> '*' ORDER BY ticker`).all<{ ticker: string }>();
    return rows.results.map(row => row.ticker);
  }
  const policyEnv = await companyPolicyEnvironment(env);
  if (scope !== "map") return featureTickersFor(policyEnv, scope);
  return [...dataTickers(policyEnv)].sort();
}

/**
 * `heldSince`: when the event behind the run was written, if that was before scheduled analysis went off for the company.
 * `parked`: publication processing, or a new task version's re-run, held until scheduled analysis is on again.
 */
type Target = { task: TaskName; ticker: string; causeId: string; heldSince?: string; parked?: boolean };
type DueRow = { ticker: string; task: string; due_at: string; first_requested_at: string };

async function targets(env: AnalysisEnv, event: EventMessage, scopes: (scope: TaskScope) => Promise<string[]>): Promise<Target[]> {
  if (event.type === "task.version_changed") {
    if (!event.task) return [];
    return (await scopes(TASKS[event.task].scope)).map(ticker => ({ task: event.task!, ticker, causeId: event.id }));
  }
  const list: Target[] = [];
  for (const subscription of SUBSCRIPTIONS[event.type] ?? []) {
    if (subscription.when && !subscription.when(event)) continue;
    const scope = TASKS[subscription.task].scope;
    // A company task runs only for companies in its scope: the SEC report only where layer 2 is on.
    if (scope !== "global" && scope !== "publication" && !(await scopes(scope)).includes(event.ticker)) continue;
    list.push({ task: subscription.task, ticker: scope === "global" ? "*" : event.ticker, causeId: event.id });
  }
  return list;
}

/** When the run should happen: pushed back by each trigger, never past the task's longest wait from the first. */
export function nextDue(task: TaskName, existing: Pick<DueRow, "due_at" | "first_requested_at"> | undefined, now: number): { dueAt: string; first: string } {
  const meta = TASKS[task];
  // A row whose time has passed belongs to a run that is executing, failed or was dead-lettered: start a new window.
  const first = existing && Date.parse(existing.due_at) > now ? Date.parse(existing.first_requested_at) : now;
  const due = Math.max(now, Math.min(now + meta.debounceMs, first + meta.maxWaitMs));
  return { dueAt: new Date(due).toISOString(), first: new Date(first).toISOString() };
}

export const delaySeconds = (dueAt: string, now: number) => Math.min(86_400, Math.max(0, Math.ceil((Date.parse(dueAt) - now) / 1000)));

/**
 * Turns a batch of events into one pending run per company and task: records each in `pipeline_due`, then sends
 * one delayed task message per run. Events for the same company and task inside the batch collapse into one. The
 * map's publication revisions move in the same batches. While scheduled analysis is off for a company, an event written
 * before it went off queues a run that will be held, and a new task version leaves a held run without a message.
 * Publication processing is always held while the switch is off; other new requests open a window of their own.
 * Throws when anything fails, so the queue redelivers the whole batch; re-recording a due run is harmless.
 */
export async function routeEvents(env: AnalysisEnv, events: EventMessage[], now = Date.now()): Promise<{ events: number; runs: number }> {
  const db = env.DB!;
  const wanted = new Map<string, Target>();
  const fanout = new Map<string, number>();
  const known = new Map<TaskScope, Promise<string[]>>();
  const scopes = (scope: TaskScope) => { if (!known.has(scope)) known.set(scope, scopeTickers(env, scope)); return known.get(scope)!; };
  const pauses = await scheduledAnalysisPauses(db);
  for (const event of events) {
    const list = await targets(env, event, scopes);
    fanout.set(event.id, list.length);
    for (const target of list) {
      const key = `${target.ticker}\u0000${target.task}`, before = wanted.get(key);
      const pausedAt = pauses.at(target.ticker);
      const parked = pausedAt !== null && (TASKS[target.task].scope === "publication" || event.type === "task.version_changed");
      // A run something else in the batch asked for stays that run: it happens on the deployed code either way.
      if (parked && before && !before.parked) continue;
      wanted.set(key, parked ? { ...target, parked } : { ...target, heldSince: beforePause(event.at, pausedAt) && (!before || before.heldSince) ? event.at : undefined });
    }
  }
  const at = new Date(now).toISOString();
  const statements: D1PreparedStatement[] = [];
  const messages: TaskMessage[] = [];
  if (wanted.size) {
    const keys = [...wanted.keys()];
    const existing = new Map((await db.prepare("SELECT ticker, task, due_at, first_requested_at FROM pipeline_due WHERE ticker || char(0) || task IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(keys)).all<DueRow>()).results.map(row => [`${row.ticker}\u0000${row.task}`, row]));
    for (const [key, target] of wanted) {
      if (target.parked) {
        // Existing publication work is held too; generation requests retain their own scheduling window.
        const conflict = TASKS[target.task].scope === "publication"
          ? "DO UPDATE SET due_at = excluded.due_at, held_at = COALESCE(pipeline_due.held_at, excluded.held_at), cause_id = excluded.cause_id"
          : "DO NOTHING";
        statements.push(db.prepare(`INSERT INTO pipeline_due (ticker, task, due_at, first_requested_at, cause_id, held_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (ticker, task) ${conflict}`)
          .bind(target.ticker, target.task, at, at, target.causeId, at));
        continue;
      }
      const paused = pauses.at(target.ticker);
      const { dueAt, first } = nextDue(target.task, paused && !target.heldSince ? undefined : existing.get(key), now);
      statements.push(db.prepare(`INSERT INTO pipeline_due (ticker, task, due_at, first_requested_at, cause_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (ticker, task) DO UPDATE SET due_at = excluded.due_at, first_requested_at = excluded.first_requested_at, cause_id = excluded.cause_id, held_at = NULL`)
        .bind(target.ticker, target.task, dueAt, target.heldSince ?? first, target.causeId));
      messages.push({ v: 1, kind: "task", id: crypto.randomUUID(), causeId: target.causeId, task: target.task, ticker: target.ticker, dueAt });
    }
  }
  // The map's revisions move with the events that publish into it, so a reader learns of newer data without polling a table.
  statements.push(...revisionStatements(db, events));
  // A feature's publication is a success in the admin's inbox.
  statements.push(...messageStatements(db, events, at));
  for (const event of events) {
    statements.push(...logStatements(db, { messageId: event.id, causeId: event.causeId, kind: "event", name: event.type, ticker: event.ticker,
      outcome: `routed:${fanout.get(event.id) ?? 0}`, detail: event.task ? { task: event.task, ...event.detail } : event.detail ?? undefined }, at));
  }
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
  if (messages.length && !env.PIPELINE_TASKS) throw new Error("PIPELINE_TASKS binding is not configured");
  for (let i = 0; i < messages.length; i += 100) {
    await env.PIPELINE_TASKS!.sendBatch(messages.slice(i, i + 100).map(body => ({ body, contentType: "json" as const, delaySeconds: delaySeconds(body.dueAt, now) })));
  }
  return { events: events.length, runs: messages.length };
}
