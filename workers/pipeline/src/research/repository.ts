import { RESEARCH_REPORT_SCHEMA, type ResearchReport } from "../../../../shared/analysis-runtime/research-schema.ts";
import type { FundamentalsD1Database } from "../fundamentals/fundamentals-d1.ts";

export type ResearchEvent = {
  id: string; ticker: string; kind: ResearchReport["trigger"];
  observedAt: string; sourceAt: string | null; payload: Record<string, unknown>;
};
export type ResearchCase = {
  id: string; event_id: string; ticker: string; status: string; workflow_id: string;
  attempts: number; next_attempt_at: string; lease_owner: string | null;
  lease_until: string | null; created_at: string; updated_at: string;
};

export class ResearchRepository {
  readonly db: FundamentalsD1Database;
  constructor(db: FundamentalsD1Database) { this.db = db; }

  async state<T>(key: string): Promise<T | null> {
    const row = await this.db.prepare("SELECT payload FROM research_state WHERE key = ?").bind(key).first<{ payload: string }>();
    return row ? JSON.parse(row.payload) as T : null;
  }

  async setState(key: string, value: unknown, now: string): Promise<void> {
    await this.db.prepare(`INSERT INTO research_state (key,payload,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at
      WHERE excluded.updated_at >= research_state.updated_at`).bind(key, JSON.stringify(value), now).run();
  }

  /** Event and work intent commit atomically; repeated observations reuse the original case. */
  async enqueue(event: ResearchEvent): Promise<void> {
    await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO research_events (id,ticker,kind,payload,observed_at,source_at)
        VALUES (?,?,?,?,?,?)`).bind(event.id, event.ticker, event.kind, JSON.stringify(event.payload), event.observedAt, event.sourceAt),
      this.db.prepare(`INSERT OR IGNORE INTO research_cases
        (id,event_id,ticker,workflow_id,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
        .bind(event.id, event.id, event.ticker, `research-${event.id}`, event.observedAt, event.observedAt, event.observedAt),
    ]);
  }

  async event(id: string): Promise<ResearchEvent | null> {
    const row = await this.db.prepare("SELECT * FROM research_events WHERE id=?").bind(id)
      .first<{ id: string; ticker: string; kind: ResearchEvent["kind"]; observed_at: string; source_at: string | null; payload: string }>();
    return row ? { id: row.id, ticker: row.ticker, kind: row.kind, observedAt: row.observed_at, sourceAt: row.source_at, payload: JSON.parse(row.payload) } : null;
  }

  async pending(now: string, limit = 4): Promise<ResearchCase[]> {
    return (await this.db.prepare(`SELECT * FROM research_cases WHERE status IN ('pending','dispatching')
      AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY created_at LIMIT ?`).bind(now, now, Math.min(10, Math.max(1, limit))).all<ResearchCase>()).results;
  }

  async claim(id: string, owner: string, now: string, until: string): Promise<ResearchCase | null> {
    return this.db.prepare(`UPDATE research_cases SET status='dispatching',lease_owner=?,lease_until=?,updated_at=?
      WHERE id=? AND status IN ('pending','dispatching') AND (lease_until IS NULL OR lease_until<=?) RETURNING *`)
      .bind(owner, until, now, id, now).first<ResearchCase>();
  }

  async dispatched(id: string, owner: string, now: string): Promise<void> {
    await this.db.prepare(`UPDATE research_cases SET status='running',lease_owner=NULL,lease_until=NULL,updated_at=?
      WHERE id=? AND lease_owner=? AND status='dispatching'`).bind(now, id, owner).run();
  }

  async dispatchFailed(id: string, owner: string, now: string): Promise<void> {
    await this.db.prepare(`UPDATE research_cases SET status='pending',lease_owner=NULL,lease_until=NULL,
      next_attempt_at=?,updated_at=?,error_code='dispatch_failed' WHERE id=? AND lease_owner=?`)
      .bind(new Date(Date.parse(now) + 60_000).toISOString(), now, id, owner).run();
  }

  /** One durable reservation per workflow attempt; concurrent reservations cannot exceed the cap. */
  async reserveBudget(day: string, cap: number): Promise<boolean> {
    if (cap < 1) return false;
    const row = await this.db.prepare(`INSERT INTO research_budget (day,investigations) VALUES (?,1)
      ON CONFLICT(day) DO UPDATE SET investigations=investigations+1
      WHERE investigations<? RETURNING investigations`).bind(day, cap).first<{ investigations: number }>();
    return !!row;
  }

  async finishWithoutReport(id: string, status: "quiet" | "failed" | "budget_exhausted", now: string): Promise<void> {
    await this.db.prepare(`UPDATE research_cases SET status=?,updated_at=?,lease_owner=NULL,lease_until=NULL
      WHERE id=? AND status!='published'`).bind(status, now, id).run();
  }

  /** Report, delivery record, and followups share a transaction. Replays never duplicate messages. */
  async publish(value: ResearchReport): Promise<void> {
    const report = RESEARCH_REPORT_SCHEMA.parse(value);
    const event = await this.event(report.caseId);
    if (!event) throw new Error("research_case_missing");
    const statements = [
      this.db.prepare(`INSERT OR IGNORE INTO research_reports (id,case_id,payload,generated_at) VALUES (?,?,?,?)`)
        .bind(report.id, report.caseId, JSON.stringify(report), report.generatedAt),
      this.db.prepare(`UPDATE research_cases SET status='published',updated_at=?,lease_owner=NULL,lease_until=NULL
        WHERE id=?`).bind(report.generatedAt, report.caseId),
      ...report.followups.map((followup, index) => this.db.prepare(`INSERT OR IGNORE INTO research_followups
        (id,case_id,ticker,question,query,due_at) VALUES (?,?,?,?,?,?)`)
        .bind(`${report.caseId}-${index}`, report.caseId, event.ticker, followup.question, followup.query, followup.dueAt)),
    ];
    await this.db.batch(statements);
  }

  async reports(before?: number, limit = 20): Promise<{ reports: ResearchReport[]; nextCursor: string | null }> {
    const bounded = Math.min(50, Math.max(1, limit));
    const rows = (await this.db.prepare(`SELECT sequence,payload FROM research_reports
      WHERE sequence < ? ORDER BY sequence DESC LIMIT ?`).bind(before ?? Number.MAX_SAFE_INTEGER, bounded + 1)
      .all<{ sequence: number; payload: string }>()).results;
    const page = rows.slice(0, bounded);
    return { reports: page.map(row => RESEARCH_REPORT_SCHEMA.parse(JSON.parse(row.payload))),
      nextCursor: rows.length > bounded ? String(page[page.length - 1].sequence) : null };
  }

  async latest(ticker: string, limit = 3): Promise<ResearchReport[]> {
    const rows = (await this.db.prepare(`SELECT r.payload FROM research_reports r JOIN research_cases c ON c.id=r.case_id
      WHERE c.ticker=? ORDER BY r.sequence DESC LIMIT ?`).bind(ticker, limit).all<{ payload: string }>()).results;
    return rows.map(row => RESEARCH_REPORT_SCHEMA.parse(JSON.parse(row.payload)));
  }

  async due(now: string): Promise<Array<{ id: string; ticker: string; question: string; query: string; due_at: string }>> {
    return (await this.db.prepare(`SELECT id,ticker,question,query,due_at FROM research_followups
      WHERE status='pending' AND due_at<=? ORDER BY due_at LIMIT 4`).bind(now)
      .all<{ id: string; ticker: string; question: string; query: string; due_at: string }>()).results;
  }

  async followupQueued(id: string): Promise<void> {
    await this.db.prepare("UPDATE research_followups SET status='queued' WHERE id=?").bind(id).run();
  }

  async recoverable(now: string): Promise<ResearchCase[]> {
    return (await this.db.prepare(`SELECT * FROM research_cases WHERE status IN ('failed','budget_exhausted','running')
      AND updated_at < ? ORDER BY updated_at LIMIT 6`).bind(new Date(Date.parse(now) - 30 * 60_000).toISOString()).all<ResearchCase>()).results;
  }

  async retry(row: ResearchCase, now: string): Promise<void> {
    const attempt = row.attempts + 1;
    await this.db.prepare(`UPDATE research_cases SET status='pending',attempts=?,workflow_id=?,next_attempt_at=?,updated_at=?,lease_owner=NULL,lease_until=NULL
      WHERE id=? AND workflow_id=? AND status!='published'`).bind(attempt, `research-${row.id}-${attempt}`, now, now, row.id, row.workflow_id).run();
  }
}

export async function researchId(parts: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
