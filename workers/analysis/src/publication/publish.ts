import { outboxInsertMany, outboxStatement, type OutboxEvent } from "../pipeline/outbox.ts";

/** A reader publication can announce its domain result and the shared post-publication processing together. */
type PublicationEvent = OutboxEvent & { type: Exclude<OutboxEvent["type"], "content.published" | "translations.published"> };
type WriteGuard = { sql: string; binds: unknown[] };

export function contentPublishedStatement(db: D1Database, ticker: string, at = new Date().toISOString(), guard?: WriteGuard, causeId?: string): D1PreparedStatement {
  return outboxStatement(db, { type: "content.published", ticker, causeId }, at, guard);
}

export function publicationOutboxInserts(event: PublicationEvent, at = new Date().toISOString(), guard?: WriteGuard): Array<{ sql: string; values: unknown[] }> {
  return [outboxInsertMany([event, { type: "content.published", ticker: event.ticker, cik: event.cik, causeId: event.causeId }], at, guard)];
}

export function publicationOutboxStatements(db: D1Database, event: PublicationEvent, at = new Date().toISOString(), guard?: WriteGuard): D1PreparedStatement[] {
  return publicationOutboxInserts(event, at, guard).map(statement => db.prepare(statement.sql).bind(...statement.values));
}
