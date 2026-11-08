import type { AnalysisEnv } from "../operations.ts";
import type { TaskMessage } from "./messages.ts";
import type { TaskName } from "./registry.ts";

/**
 * The admin's project-wide switch for analysis nobody asked for. Off, SEC discovery announces no filing, a deployment
 * announces no task version, and a run queued before the switch went off is held when its turn comes; all of it goes out
 * once the switch is on again. A request made while it is off, and what that request leads to, runs as usual.
 * A failed read propagates, so an unreadable switch never counts as on.
 */
export async function scheduledAnalysisPausedAt(db: D1Database): Promise<string | null> {
  const row = await db.prepare("SELECT updated_at FROM scheduled_analysis_setting WHERE id = 'global' AND enabled = 0").first<{ updated_at: string }>();
  return row?.updated_at ?? null;
}

export const scheduledAnalysisOn = async (db: D1Database): Promise<boolean> => await scheduledAnalysisPausedAt(db) === null;

/** Whether something requested at `at` came before the switch went off at `pausedAt`, and so waits for it to come back on. */
export const beforePause = (at: string, pausedAt: string | null): boolean => pausedAt !== null && Date.parse(at) < Date.parse(pausedAt);

/** Stored only when it changes, so the time it went off stays the moment that divides held runs from requests made since. */
async function store(db: D1Database, on: boolean, at: string): Promise<void> {
  await db.prepare(`INSERT INTO scheduled_analysis_setting (id, enabled, updated_at) VALUES ('global', ?, ?)
    ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at WHERE scheduled_analysis_setting.enabled <> excluded.enabled`).bind(on ? 1 : 0, at).run();
}

/**
 * Sends every held run again. The rows move before their messages go, as a message reads its row to see whether it is
 * current, and stay marked until the messages are out, so a failed send is repeated in full by the next attempt.
 */
async function releaseHeld(env: AnalysisEnv, at: string): Promise<void> {
  const db = env.DB!;
  const held = (await db.prepare("SELECT ticker, task, cause_id FROM pipeline_due WHERE held_at IS NOT NULL").all<{ ticker: string; task: string; cause_id: string | null }>()).results;
  if (!held.length) return;
  if (!env.PIPELINE_TASKS) throw new Error("PIPELINE_TASKS binding is not configured");
  await db.prepare("UPDATE pipeline_due SET due_at = ?, first_requested_at = ? WHERE held_at IS NOT NULL").bind(at, at).run();
  const messages = held.map(row => { const id = crypto.randomUUID(); return { v: 1, kind: "task", id, causeId: row.cause_id ?? id, task: row.task as TaskName, ticker: row.ticker, dueAt: at } satisfies TaskMessage; });
  for (let i = 0; i < messages.length; i += 100) await env.PIPELINE_TASKS.sendBatch(messages.slice(i, i + 100).map(body => ({ body, contentType: "json" as const })));
  await db.prepare("UPDATE pipeline_due SET held_at = NULL WHERE held_at IS NOT NULL AND due_at = ?").bind(at).run();
}

export async function setScheduledAnalysis(env: AnalysisEnv, on: boolean, now = new Date()): Promise<void> {
  const at = now.toISOString();
  if (!on) return store(env.DB!, false, at);
  // Released before the switch moves, so a refused send leaves it off; released again for a run held in between.
  await releaseHeld(env, at);
  await store(env.DB!, true, at);
  await releaseHeld(env, at);
}
