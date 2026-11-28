import type { SecFiling, SecFilingSummary } from "./sec.ts";
import type { D1Like } from "./d1-support.ts";

type HistoricalReport = {
  accessionNumber: string;
  form: string;
  reportDate: string;
  filingDate: string;
  documentUrl: string;
  generatedAt: string;
  reason: string;
  text: string;
};
export type ReportContinuity = {
  version: "sec-report-continuity.v1";
  asOf: string;
  reports: HistoricalReport[];
  warnings: string[];
};
type ReportRow = Omit<HistoricalReport, "reason" | "text" | "generatedAt"> & { payload: string };

// Sized for English reports (about 2.5x the characters of the Chinese ones, roughly the same tokens).
const HISTORICAL_REPORT_MAX = 40_000;
const HISTORICAL_CONTEXT_MAX = 120_000;

// Bound the database read as well as the model input. Annual/quarter/event buckets prevent
// frequent events from pushing annual context out of the candidate window.
export async function loadReportContinuity(db: D1Like, filing: SecFiling): Promise<ReportContinuity> {
  const rows = await db.prepare(`
    WITH candidates AS (
      SELECT f.accession_number AS accessionNumber, f.form, f.report_date AS reportDate,
        f.filing_date AS filingDate, f.document_url AS documentUrl, s.payload,
        ROW_NUMBER() OVER (PARTITION BY CASE
          WHEN f.form IN ('10-K','10-K/A','20-F','20-F/A') THEN 'annual'
          WHEN f.form IN ('10-Q','10-Q/A') THEN 'quarter' ELSE 'event' END
          ORDER BY f.filing_date DESC, f.accession_number DESC) AS rank
      FROM sec_filings f JOIN sec_filing_summaries s
        ON f.ticker = s.ticker AND f.accession_number = s.accession_number
      WHERE f.ticker = ? AND f.filing_date < ? AND f.accession_number != ?
        AND f.form IN ('10-K','10-K/A','20-F','20-F/A','10-Q','10-Q/A','8-K','8-K/A','6-K','6-K/A')
        AND length(s.payload) <= 250000
    ) SELECT * FROM candidates WHERE rank <= 16
  `).bind(filing.ticker, filing.filingDate, filing.accessionNumber).all<ReportRow>();
  return selectReportContinuity(filing, rows.results);
}

function selectReportContinuity(filing: SecFiling, rows: ReportRow[]): ReportContinuity {
  const context: ReportContinuity = { version: "sec-report-continuity.v1", asOf: filing.filingDate, reports: [], warnings: [] };
  const candidates = rows.flatMap((row) => {
    if (row.accessionNumber === filing.accessionNumber || row.filingDate >= filing.filingDate) return [];
    try {
      const summary = JSON.parse(row.payload) as SecFilingSummary;
      // A later regenerated report may already contain later evidence. Do not backdate it.
      if (summary.source === "error" || summary.ticker !== filing.ticker
        || summary.accessionNumber !== row.accessionNumber || !summary.generatedAt
        || !Number.isFinite(Date.parse(summary.generatedAt)) || summary.generatedAt.slice(0, 10) > filing.filingDate) return [];
      const text = [summary.headline, ...(summary.bullets ?? []).map((b) => `${b.label}: ${b.detail}`), summary.analystView, summary.report,
        ...(summary.readerVersion ? [] : summary.nodes ?? []).filter((node) => node.status === "complete" && node.id !== "historical-judgment-review")
          .map((node) => [node.title, ...node.findings.map((b) => `${b.label}: ${b.detail}`), node.narrative].join("\n")),
      ].filter(Boolean).join("\n\n");
      if (!text.trim()) return [];
      return [{ ...row, generatedAt: summary.generatedAt, text, eventCategory: summary.eventCategory }];
    } catch { return []; }
  }).sort((a, b) => b.filingDate.localeCompare(a.filingDate) || b.accessionNumber.localeCompare(a.accessionNumber));
  const periodic = candidates.filter((r) => /^(10-K|20-F|10-Q)(\/A)?$/.test(r.form) && r.reportDate < filing.reportDate);
  const annual = periodic.find((r) => /^(10-K|20-F)/.test(r.form));
  const quarter = periodic.find((r) => /^10-Q/.test(r.form));
  const yearAgo = periodic.find((r) => {
    const days = (Date.parse(filing.reportDate) - Date.parse(r.reportDate)) / 86400000;
    return /^10-Q/.test(filing.form) === /^10-Q/.test(r.form) && days >= 330 && days <= 400;
  });
  const add = (row: typeof candidates[number] | undefined, reason: string) => {
    if (!row || context.reports.some((r) => r.accessionNumber === row.accessionNumber || (r.form.replace("/A", "") === row.form.replace("/A", "") && r.reportDate === row.reportDate))) return;
    // Keep complete report prose, never silently turn an oversized report into a summary.
    if (row.text.length > HISTORICAL_REPORT_MAX || context.reports.reduce((n, r) => n + r.text.length, 0) + row.text.length > HISTORICAL_CONTEXT_MAX) {
      context.warnings.push(`Historical report ${row.accessionNumber} exceeds the context budget and was not loaded.`);
      return;
    }
    const { accessionNumber, form, reportDate, filingDate, documentUrl, generatedAt, text } = row;
    context.reports.push({ accessionNumber, form, reportDate, filingDate, documentUrl, generatedAt, text, reason });
  };
  add(annual, "latest_annual");
  add(quarter, "previous_quarter");
  add(yearAgo, "prior_year_comparable");
  const latestEarnings = periodic[0]?.filingDate;
  for (const event of candidates.filter((r) => /^(8-K|6-K)(\/A)?$/.test(r.form)
    && latestEarnings && r.filingDate >= latestEarnings
    && r.eventCategory && r.eventCategory !== "other").slice(0, 3)) add(event, "material_event_since_earnings");
  if (!context.reports.length) context.warnings.push("No historical analysis available as of this filing date was found; this period does not claim a cross-period review of prior judgments.");
  return context;
}
