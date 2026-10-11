import type { EventMessage } from "./messages.ts";
import type { PipelineEvent } from "./registry.ts";

/** Who caused the event, for the trail in `pipeline_log`; null where the write was not itself a task run. */
export type OutboxEvent = PipelineEvent & { causeId?: string | null };
type OutboxRow = { id: string; type: string; ticker: string; cik: string | null; task: string | null; detail: string | null; cause_id: string | null; created_at: string };

const COLUMNS = "id, type, ticker, cik, task, detail, cause_id, created_at";

/**
 * The event as one statement, for the same `db.batch` as the write it reports: both commit or neither does. A
 * `guard` makes the insert conditional on the batch's own write having taken effect (an SQL boolean expression).
 */
export function outboxStatement(db: D1Database, event: OutboxEvent, at = new Date().toISOString(), guard?: { sql: string; binds: unknown[] }): D1PreparedStatement {
  const values = [crypto.randomUUID(), event.type, event.ticker, event.cik ?? null, event.task ?? null,
    event.detail ? JSON.stringify(event.detail) : null, event.causeId ?? null, at];
  return guard
    ? db.prepare(`INSERT INTO pipeline_outbox (${COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`).bind(...values, ...guard.binds)
    : db.prepare(`INSERT INTO pipeline_outbox (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(...values);
}

const message = (row: OutboxRow): EventMessage => ({
  v: 1, kind: "event", id: row.id, causeId: row.cause_id, type: row.type as EventMessage["type"], ticker: row.ticker,
  cik: row.cik, task: row.task as EventMessage["task"], detail: row.detail ? JSON.parse(row.detail) as EventMessage["detail"] : null, at: row.created_at,
});

/**
 * Sends what the outbox holds to the events queue, oldest first, and deletes it once the queue has it. Called right
 * after a write, and at the start of every Cron and queue invocation, so an event left by a run that died between
 * its commit and this send goes out on the next invocation. A row sent twice is harmless: subscribers are idempotent.
 */
export async function flushOutbox(env: { DB?: D1Database; PIPELINE_EVENTS?: Queue<EventMessage> }): Promise<number> {
  if (!env.DB || !env.PIPELINE_EVENTS) return 0;
  let sent = 0;
  for (let round = 0; round < 10; round++) {
    const rows = (await env.DB.prepare(`SELECT ${COLUMNS} FROM pipeline_outbox ORDER BY created_at LIMIT 100`).bind().all<OutboxRow>()).results;
    if (!rows.length) break;
    await env.PIPELINE_EVENTS.sendBatch(rows.map(row => ({ body: message(row), contentType: "json" as const })));
    await env.DB.prepare(`DELETE FROM pipeline_outbox WHERE id IN (${rows.map(() => "?").join(", ")})`).bind(...rows.map(row => row.id)).run();
    sent += rows.length;
    if (rows.length < 100) break;
  }
  return sent;
}

/** Writes events on their own, for producers whose data write is not a D1 batch they control (admin requests). */
export async function emit(env: { DB?: D1Database; PIPELINE_EVENTS?: Queue<EventMessage> }, events: OutboxEvent[]): Promise<void> {
  if (!env.DB || !events.length) return;
  const at = new Date().toISOString();
  await env.DB.batch(events.map(event => outboxStatement(env.DB!, event, at)));
  await flushOutbox(env);
}
