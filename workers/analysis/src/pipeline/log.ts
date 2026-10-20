const RETENTION_MS = 30 * 24 * 60 * 60_000;

export type LogEntry = {
  messageId: string; causeId: string | null; kind: "event" | "task"; name: string; ticker: string;
  outcome: string; detail?: unknown;
};

/**
 * The trail of one routed event or task run, plus the deletion of that company's entries older than 30 days: the
 * log keeps itself bounded on write, so nothing has to sweep it on a schedule.
 */
export function logStatements(db: D1Database, entry: LogEntry, at = new Date().toISOString()): D1PreparedStatement[] {
  const detail = entry.detail === undefined ? null : JSON.stringify(entry.detail).slice(0, 4000);
  return [
    db.prepare("INSERT INTO pipeline_log (id, message_id, cause_id, kind, name, ticker, outcome, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), entry.messageId, entry.causeId, entry.kind, entry.name, entry.ticker, entry.outcome, detail, at),
    db.prepare("DELETE FROM pipeline_log WHERE ticker = ? AND created_at < ?").bind(entry.ticker, new Date(Date.parse(at) - RETENTION_MS).toISOString()),
  ];
}
