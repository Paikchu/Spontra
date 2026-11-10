import { buildPeriodIdentity } from "../sec/analysis.ts";
import type { SecFiling, SecFilingSummary } from "../sec/sec.ts";

/**
 * What a published periodic report hands to company memory (memory-workflow.ts). The report is the filing's one layer-2
 * product, so memory reads it; the sections the session read are the evidence a memory item may cite, because they are
 * the text the report was written from.
 */
export const FILING_MEMORY_SCHEMA = "filing-report-memory.v1";
export type FilingMemorySource = {
  schema: typeof FILING_MEMORY_SCHEMA;
  filing: Pick<SecFiling, "ticker" | "accessionNumber" | "form" | "filingDate" | "reportDate" | "indexUrl">;
  report: { headline: string; markdown: string; generatedAt: string };
  evidence: Array<{ id: string; path: string }>;
};

const memorySourceKey = (ticker: string, accession: string, sessionId: string) => `filing-memory/${ticker}/${accession}/${sessionId}.json`;

/** Paths of the sections read, in reading order; an id the library no longer holds is not citable and is left out. */
async function readSections(db: D1Database, ids: readonly string[]): Promise<FilingMemorySource["evidence"]> {
  if (!ids.length) return [];
  const rows = (await db.prepare("SELECT section_id id, title, path FROM sec_sections WHERE section_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([...ids])).all<{ id: string; title: string; path: string }>()).results;
  const byId = new Map(rows.map((row) => {
    let path = row.title;
    try { const parts = JSON.parse(row.path) as unknown; if (Array.isArray(parts) && parts.length) path = parts.map(String).join(" › "); } catch { /* a plain title */ }
    return [row.id, path];
  }));
  return ids.flatMap((id) => byId.has(id) ? [{ id, path: byId.get(id)! }] : []);
}

/**
 * Stores the report as a memory source in R2 and returns the statements that publish it with the report: the period the
 * filing covers, the filing's membership in it, and a pending memory job. The `memory` task (on `report.published`)
 * starts the job; the company analysis follows memory.
 */
export async function filingMemoryStatements(env: { DB?: D1Database; SEC_FILINGS: { put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown> } }, input: {
  filing: SecFiling; summary: SecFilingSummary; sessionId: string; readSectionIds: readonly string[];
}): Promise<D1PreparedStatement[]> {
  const db = env.DB!;
  const { filing, summary, sessionId } = input;
  const evidence = await readSections(db, [...new Set(input.readSectionIds)]);
  // Memory items must cite evidence; a report written without reading any section has nothing to cite.
  if (!evidence.length || !/^\d{4}-\d{2}-\d{2}$/.test(filing.reportDate)) return [];
  const { periodId, periodScope } = buildPeriodIdentity(filing.ticker, filing.form, filing.reportDate);
  const source: FilingMemorySource = {
    schema: FILING_MEMORY_SCHEMA,
    filing: { ticker: filing.ticker, accessionNumber: filing.accessionNumber, form: filing.form, filingDate: filing.filingDate, reportDate: filing.reportDate, indexUrl: filing.indexUrl },
    report: { headline: summary.headline, markdown: summary.report ?? "", generatedAt: summary.generatedAt },
    evidence,
  };
  const key = memorySourceKey(filing.ticker, filing.accessionNumber, sessionId);
  await env.SEC_FILINGS.put(key, JSON.stringify(source), { httpMetadata: { contentType: "application/json" } });
  return [
    db.prepare(`INSERT INTO sec_periods (period_id, ticker, fiscal_year, fiscal_quarter, period_scope, end_date)
      VALUES (?, ?, NULL, NULL, ?, ?) ON CONFLICT(period_id) DO NOTHING`).bind(periodId, filing.ticker, periodScope, filing.reportDate),
    db.prepare("INSERT OR IGNORE INTO sec_filing_periods (filing_id, period_id, role) VALUES (?, ?, 'primary')").bind(filing.accessionNumber, periodId),
    db.prepare(`INSERT INTO sec_memory_jobs (job_id, ticker, filing_id, period_id, status, source_r2_key, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP) ON CONFLICT(job_id) DO NOTHING`)
      .bind(`${periodId}:${sessionId}:memory`, filing.ticker, filing.accessionNumber, periodId, key),
  ];
}
