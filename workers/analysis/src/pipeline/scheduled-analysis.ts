import type { AnalysisEnv } from "../operations.ts";
import type { TaskMessage } from "./messages.ts";
import type { TaskName } from "./registry.ts";

/**
 * The admin's switches for analysis nobody asked for: one for the project, and one a company may have of its own, which
 * decides for that company whatever the project's says (only Cloudflare on, or everything but Cloudflare). Off for a
 * company, SEC discovery announces none of its filings, a deployment's new task version queues no re-run for it, and a run
 * of its queued before the switch went off is held when its turn comes; all of it goes out once the company is on again.
 * A request made while it is off, and what that request leads to, runs as usual. A task that belongs to no company
 * (`*`) follows the project's switch. A failed read propagates, so an unreadable switch never counts as on.
 */
export type ScheduledAnalysisPauses = {
  /** When the project's switch went off; null while it is on. */
  global: string | null;
  /** The companies with a switch of their own, and whether it is on. */
  companies: Map<string, boolean>;
  /** When scheduled analysis went off for the company (`*`: for the project); null while it is on. */
  at(ticker: string): string | null;
};

export async function scheduledAnalysisPauses(db: D1Database): Promise<ScheduledAnalysisPauses> {
  const rows = (await db.prepare(`SELECT '*' ticker, enabled, updated_at FROM scheduled_analysis_setting WHERE id = 'global'
    UNION ALL SELECT ticker, enabled, updated_at FROM scheduled_analysis_company`).all<{ ticker: string; enabled: number; updated_at: string }>()).results;
  const own = new Map(rows.map(row => [row.ticker, row.enabled ? null : row.updated_at]));
  const global = own.get("*") ?? null;
  own.delete("*");
  return { global, companies: new Map([...own].map(([ticker, pausedAt]) => [ticker, pausedAt === null])), at: ticker => own.has(ticker) ? own.get(ticker)! : global };
}

/** Whether something requested at `at` came before the switch went off at `pausedAt`, and so waits for it to come back on. */
export const beforePause = (at: string, pausedAt: string | null): boolean => pausedAt !== null && Date.parse(at) < Date.parse(pausedAt);

/**
 * Sends the held runs of the companies named by `released` again. The rows move before their messages go, as a message
 * reads its row to see whether it is current, and stay marked until the messages are out, so a failed send is repeated
 * in full by the next attempt.
 */
async function releaseHeld(env: AnalysisEnv, at: string, released: (ticker: string) => boolean): Promise<void> {
  const db = env.DB!;
  const held = (await db.prepare("SELECT ticker, task, cause_id FROM pipeline_due WHERE held_at IS NOT NULL").all<{ ticker: string; task: string; cause_id: string | null }>()).results.filter(row => released(row.ticker));
  if (!held.length) return;
  if (!env.PIPELINE_TASKS) throw new Error("PIPELINE_TASKS binding is not configured");
  const tickers = JSON.stringify([...new Set(held.map(row => row.ticker))]);
  await db.prepare("UPDATE pipeline_due SET due_at = ?, first_requested_at = ? WHERE held_at IS NOT NULL AND ticker IN (SELECT value FROM json_each(?))").bind(at, at, tickers).run();
  const messages = held.map(row => { const id = crypto.randomUUID(); return { v: 1, kind: "task", id, causeId: row.cause_id ?? id, task: row.task as TaskName, ticker: row.ticker, dueAt: at } satisfies TaskMessage; });
  for (let i = 0; i < messages.length; i += 100) await env.PIPELINE_TASKS.sendBatch(messages.slice(i, i + 100).map(body => ({ body, contentType: "json" as const })));
  await db.prepare("UPDATE pipeline_due SET held_at = NULL WHERE held_at IS NOT NULL AND due_at = ? AND ticker IN (SELECT value FROM json_each(?))").bind(at, tickers).run();
}

/**
 * Moves the project's switch, or one company's when `ticker` is given. The project's switch leaves the companies' own
 * switches as they are. A company's is stored only while it differs from the project's, so a company switched back to
 * what the project says follows the project again. Either is written only when it changes, so the time it went off
 * stays the moment that divides held runs from requests made since.
 */
export async function setScheduledAnalysis(env: AnalysisEnv, on: boolean, ticker?: string, now = new Date()): Promise<void> {
  const db = env.DB!;
  const at = now.toISOString();
  const pauses = await scheduledAnalysisPauses(db);
  const store = ticker === undefined
    ? db.prepare(`INSERT INTO scheduled_analysis_setting (id, enabled, updated_at) VALUES ('global', ?, ?)
        ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at WHERE scheduled_analysis_setting.enabled <> excluded.enabled`).bind(on ? 1 : 0, at)
    : on === (pauses.global === null)
      ? db.prepare("DELETE FROM scheduled_analysis_company WHERE ticker = ?").bind(ticker)
      : db.prepare(`INSERT INTO scheduled_analysis_company (ticker, enabled, updated_at) VALUES (?, ?, ?)
        ON CONFLICT (ticker) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at WHERE scheduled_analysis_company.enabled <> excluded.enabled`).bind(ticker, on ? 1 : 0, at);
  if (!on) { await store.run(); return; }
  // The project's switch releases every company that has not switched itself off, and the tasks of no company.
  const released = (held: string) => ticker === undefined ? pauses.companies.get(held) !== false : held === ticker;
  // Released before the switch moves, so a refused send leaves it off; released again for a run held in between.
  await releaseHeld(env, at, released);
  await store.run();
  await releaseHeld(env, at, released);
}
