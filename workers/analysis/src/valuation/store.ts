import type { ReportStatus, ValuationAttempt, ValuationEvidence, ValuationPublication, ValuationResponse } from "../../../../shared/analysis-contract/valuation.ts";
import { readValuationPublication } from "../../../../shared/analysis-runtime/valuation/read.ts";
import { outboxStatement } from "../pipeline/outbox.ts";

/**
 * Where valuation reports live (docs/valuation-assessment-implementation.md §7): immutable versions keyed by content hash,
 * the evidence snapshots they cite, and one row per company naming the version readers see, the newest attempt and the
 * request generation a run must still hold to publish. Nothing here is pruned with the AI run log.
 */
type VersionRow = { version_id: string; generated_at: string; research_as_of: string; report_status: ReportStatus; payload_json: string };
type CurrentRow = { version_id: string | null; latest_attempt_json: string | null; request_generation: number; last_fingerprint: string | null; updated_at: string };

export class ValuationStore {
  private readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }

  async current(ticker: string): Promise<CurrentRow | null> {
    return this.db.prepare("SELECT version_id, latest_attempt_json, request_generation, last_fingerprint, updated_at FROM valuation_current WHERE ticker = ?").bind(ticker).first<CurrentRow>();
  }

  /** The fingerprint of the input the last completed run wrote from, ready or insufficient. */
  async publishedFingerprint(ticker: string): Promise<string | null> {
    return (await this.current(ticker))?.last_fingerprint ?? null;
  }

  /** Moves the generation on: a run that started under an earlier one cannot publish any more. Returns the new generation. */
  async advance(ticker: string, now: string): Promise<number> {
    await this.db.prepare(`INSERT INTO valuation_current (ticker, version_id, latest_attempt_json, request_generation, last_fingerprint, updated_at) VALUES (?, NULL, NULL, 1, NULL, ?)
      ON CONFLICT (ticker) DO UPDATE SET request_generation = valuation_current.request_generation + 1, updated_at = excluded.updated_at`).bind(ticker, now).run();
    return (await this.current(ticker))?.request_generation ?? 1;
  }

  /** Records where the newest run stands; read beside the report so the page can say "updating" or "last attempt failed". */
  async noteAttempt(ticker: string, attempt: ValuationAttempt, now: string): Promise<void> {
    await this.db.prepare(`INSERT INTO valuation_current (ticker, version_id, latest_attempt_json, request_generation, last_fingerprint, updated_at) VALUES (?, NULL, ?, 0, NULL, ?)
      ON CONFLICT (ticker) DO UPDATE SET latest_attempt_json = excluded.latest_attempt_json, updated_at = excluded.updated_at`).bind(ticker, JSON.stringify(attempt), now).run();
  }

  /**
   * Writes a version with its evidence and, when the run still holds the generation, points readers at it: a ready report
   * always; an insufficient one only while no ready report exists. Returns whether the pointer moved. The version and its
   * evidence are kept either way, and the publication event rides in the same batch when the pointer moves.
   */
  async publish(ticker: string, publication: ValuationPublication, evidence: ValuationEvidence[], generation: number, fingerprint: string, now: string): Promise<{ current: boolean; stored: boolean }> {
    const db = this.db;
    const existing = await db.prepare("SELECT version_id FROM valuation_versions WHERE version_id = ?").bind(publication.versionId).first<{ version_id: string }>();
    const statements: D1PreparedStatement[] = [];
    if (!existing) {
      statements.push(db.prepare(`INSERT INTO valuation_versions (version_id, ticker, cik, generated_at, research_as_of, report_status, method_version, calculator_version, base_input_fingerprint, evidence_set_hash, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(publication.versionId, ticker, publication.cik, publication.generatedAt, publication.researchAsOf, publication.reportStatus, publication.methodVersion, publication.calculatorVersion, publication.baseInputFingerprint, publication.evidenceSetHash, JSON.stringify(publication)));
      for (const e of evidence) {
        statements.push(db.prepare(`INSERT INTO valuation_evidence (evidence_id, ticker, source_kind, source_url, document_id, passage_id, content_sha256, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (evidence_id) DO NOTHING`)
          .bind(e.evidenceId, ticker, e.kind, e.url, e.documentId, e.passageId, e.contentSha256, JSON.stringify(e), now));
        statements.push(db.prepare("INSERT INTO valuation_version_evidence (version_id, evidence_id) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(publication.versionId, e.evidenceId));
      }
    }
    const readyOnly = publication.reportStatus === "ready" ? "" : " AND version_id IS NULL";
    statements.push(db.prepare(`UPDATE valuation_current SET version_id = ?, last_fingerprint = ?, updated_at = ? WHERE ticker = ? AND request_generation = ?${readyOnly}`).bind(publication.versionId, fingerprint, now, ticker, generation));
    statements.push(db.prepare("UPDATE valuation_current SET last_fingerprint = ?, updated_at = ? WHERE ticker = ? AND request_generation = ?").bind(fingerprint, now, ticker, generation));
    await db.batch(statements);
    const after = await this.current(ticker);
    const current = after?.version_id === publication.versionId && after.request_generation === generation;
    if (current) await db.batch([outboxStatement(db, { type: "valuation.published", ticker: publication.ticker, cik: publication.cik }, now)]);
    return { current, stored: !existing };
  }

  async version(ticker: string, versionId: string): Promise<ValuationPublication | null> {
    const row = await this.db.prepare("SELECT version_id, generated_at, research_as_of, report_status, payload_json FROM valuation_versions WHERE version_id = ? AND ticker = ?").bind(versionId, ticker).first<VersionRow>();
    return row ? readValuationPublication(JSON.parse(row.payload_json), ticker) : null;
  }

  async versions(ticker: string, limit = 20, before?: string): Promise<ValuationResponse["versions"]> {
    const rows = await this.db.prepare(`SELECT version_id, generated_at, research_as_of, report_status, json_extract(payload_json, '$.weightedScore') score, json_extract(payload_json, '$.verdict') verdict
      FROM valuation_versions WHERE ticker = ?${before ? " AND generated_at < (SELECT generated_at FROM valuation_versions WHERE version_id = ?)" : ""} ORDER BY generated_at DESC, version_id LIMIT ?`)
      .bind(...(before ? [ticker, before, limit] : [ticker, limit])).all<{ version_id: string; generated_at: string; research_as_of: string; report_status: ReportStatus; score: number | null; verdict: ValuationPublication["verdict"] }>();
    return rows.results.map(r => ({ versionId: r.version_id, generatedAt: r.generated_at, researchAsOf: r.research_as_of, reportStatus: r.report_status, weightedScore: r.score, verdict: r.verdict }));
  }

  /** One evidence snapshot, only through a version that cites it. */
  async evidence(ticker: string, versionId: string, evidenceId: string): Promise<ValuationEvidence | null> {
    const row = await this.db.prepare(`SELECT e.payload_json FROM valuation_evidence e JOIN valuation_version_evidence v ON v.evidence_id = e.evidence_id JOIN valuation_versions s ON s.version_id = v.version_id
      WHERE e.ticker = ? AND v.version_id = ? AND e.evidence_id = ? AND s.ticker = ?`).bind(ticker, versionId, evidenceId, ticker).first<{ payload_json: string }>();
    return row ? JSON.parse(row.payload_json) as ValuationEvidence : null;
  }
}

/** The public read: current report, newest attempt and version list; `hidden` answers without any of them. */
export async function readValuationResponse(db: D1Database, rawTicker: string, options: { hidden?: boolean } = {}): Promise<ValuationResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  const empty: ValuationResponse = { schemaVersion: "valuation-response.v1", ticker, availability: "hidden", report: null, latestAttempt: null, outdated: false, versions: [] };
  if (options.hidden) return empty;
  const store = new ValuationStore(db);
  const current = await store.current(ticker);
  const report = current?.version_id ? await store.version(ticker, current.version_id) : null;
  const attempt = current?.latest_attempt_json ? JSON.parse(current.latest_attempt_json) as ValuationAttempt : null;
  const versions = await store.versions(ticker);
  const availability: ValuationResponse["availability"] = report ? report.reportStatus === "ready" ? "ready" : "insufficient" : attempt?.status === "failed" ? "failed" : attempt?.reportStatus === "insufficient" ? "insufficient" : "preparing";
  const outdated = !!report && !!attempt && attempt.status !== "succeeded" && attempt.updatedAt > report.generatedAt;
  return { ...empty, availability, report, latestAttempt: attempt, outdated, versions };
}
