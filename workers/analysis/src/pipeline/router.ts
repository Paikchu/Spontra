import { financialPolicy } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import { companyPolicyEnvironment, featureTickersFor } from "../financial-data/company-policy.ts";
import type { AnalysisEnv } from "../operations.ts";
import { logStatements } from "./log.ts";
import type { EventMessage, TaskMessage } from "./messages.ts";
import { SUBSCRIPTIONS, TASKS, type TaskName, type TaskScope } from "./registry.ts";
import { revisionStatements } from "./revisions.ts";

/** The companies a task covers, for a version change that re-runs it everywhere. */
export async function scopeTickers(env: AnalysisEnv, scope: TaskScope): Promise<string[]> {
  if (scope === "global") return ["*"];
  const policyEnv = await companyPolicyEnvironment(env);
  if (scope !== "data") return featureTickersFor(policyEnv, scope);
  return [...financialPolicy({ SEC_DATA_TICKERS: policyEnv.SEC_DATA_TICKERS, SEC_TRACKED_TICKERS: policyEnv.SEC_TRACKED_TICKERS, SEC_AI_ENABLED: "false" }).dataTickers].sort();
}

type Target = { task: TaskName; ticker: string; causeId: string };
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
    // A company task runs only for companies in its scope: the SEC report and guidance only where the reports feature is on.
    if (scope !== "global" && !(await scopes(scope)).includes(event.ticker)) continue;
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
 * map's publication revisions move in the same batches.
 * Throws when anything fails, so the queue redelivers the whole batch; re-recording a due run is harmless.
 */
export async function routeEvents(env: AnalysisEnv, events: EventMessage[], now = Date.now()): Promise<{ events: number; runs: number }> {
  const db = env.DB!;
  const wanted = new Map<string, Target>();
  const fanout = new Map<string, number>();
  const known = new Map<TaskScope, Promise<string[]>>();
  const scopes = (scope: TaskScope) => { if (!known.has(scope)) known.set(scope, scopeTickers(env, scope)); return known.get(scope)!; };
  for (const event of events) {
    const list = await targets(env, event, scopes);
    fanout.set(event.id, list.length);
    for (const target of list) wanted.set(`${target.ticker}\u0000${target.task}`, target);
  }
  const at = new Date(now).toISOString();
  const statements: D1PreparedStatement[] = [];
  const messages: TaskMessage[] = [];
  if (wanted.size) {
    const keys = [...wanted.keys()];
    const existing = new Map((await db.prepare("SELECT ticker, task, due_at, first_requested_at FROM pipeline_due WHERE ticker || char(0) || task IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(keys)).all<DueRow>()).results.map(row => [`${row.ticker}\u0000${row.task}`, row]));
    for (const [key, target] of wanted) {
      const { dueAt, first } = nextDue(target.task, existing.get(key), now);
      statements.push(db.prepare(`INSERT INTO pipeline_due (ticker, task, due_at, first_requested_at, cause_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (ticker, task) DO UPDATE SET due_at = excluded.due_at, first_requested_at = excluded.first_requested_at, cause_id = excluded.cause_id`)
        .bind(target.ticker, target.task, dueAt, first, target.causeId));
      messages.push({ v: 1, kind: "task", id: crypto.randomUUID(), causeId: target.causeId, task: target.task, ticker: target.ticker, dueAt });
    }
  }
  // The map's revisions move with the events that publish into it, so a reader learns of newer data without polling a table.
  statements.push(...revisionStatements(db, events));
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
