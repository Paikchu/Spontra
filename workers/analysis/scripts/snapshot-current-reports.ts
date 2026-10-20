/** One-time, opt-in snapshot of each company's latest existing financial report. No model calls. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const apply = process.argv.includes("--apply");
const wrangler = ["wrangler", "d1", "execute", "DB", "--config", "workers/analysis/wrangler.jsonc", "--remote", "--json"];
function query(sql: string) {
  return JSON.parse(execFileSync("npx", [...wrangler, "--command", sql], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const rows = query(`
  WITH candidates AS (
    SELECT r.rowid AS sourceRow, r.payload, r.generated_at AS generatedAt,
      s.payload AS summary, f.ticker, f.cik, f.form, f.filing_date AS filingDate,
      f.report_date AS reportDate, f.accession_number AS accessionNumber,
      f.document_url AS documentUrl, f.index_url AS indexUrl,
      ROW_NUMBER() OVER (PARTITION BY f.ticker ORDER BY f.report_date DESC, f.filing_date DESC, r.generated_at DESC, r.rowid DESC) AS rank
    FROM sec_filings f
    JOIN sec_filing_periods p ON p.filing_id = f.filing_id AND p.role = 'primary'
    JOIN sec_published_reports r ON r.ticker = f.ticker AND r.period_id = p.period_id
    JOIN sec_filing_summaries s ON s.ticker = f.ticker AND s.accession_number = f.accession_number
    WHERE r.verification_status IN ('verified', 'partial')
  ) SELECT * FROM candidates WHERE rank = 1;
`)[0].results;
for (const row of rows) {
  const report = JSON.parse(row.payload);
  const summary = JSON.parse(row.summary);
  if (report.publication) { console.log(`${row.ticker}: already has a snapshot`); continue; }
  if (!summary.report || summary.ticker !== row.ticker || summary.accessionNumber !== row.accessionNumber || summary.form !== row.form) {
    console.log(`${row.ticker}: skipped incomplete or mismatched current article`); continue;
  }
  const date = row.reportDate || row.filingDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid financial date for ${row.ticker}`);
  const schema = report.reportVersion.slice(0, report.reportVersion.lastIndexOf(":"));
  report.reportVersion = `${schema}:${date}-${randomUUID()}`;
  if (!apply) { console.log(`${row.ticker}: ready ${date} ${row.accessionNumber}`); continue; }
  // Build the snapshot inside one SQL statement, keeping large article text out of the SQL
  // command. Only the selected current version may be snapshotted; a newer generation wins.
  const result = query(`INSERT INTO sec_published_reports (ticker, period_id, report_version, payload, verification_status, generated_at)
    SELECT r.ticker, r.period_id, ${quote(report.reportVersion)},
      json_set(r.payload, '$.reportVersion', ${quote(report.reportVersion)}, '$.publication', json_object(
        'filing', json_object('ticker', f.ticker, 'cik', f.cik, 'cikNumber', CAST(f.cik AS INTEGER),
          'companyName', f.ticker, 'form', f.form, 'filingDate', f.filing_date, 'reportDate', f.report_date,
          'accessionNumber', f.accession_number, 'primaryDocument', '', 'description', f.form,
          'items', '', 'documentUrl', f.document_url, 'indexUrl', f.index_url),
        'summary', json(s.payload))), r.verification_status, r.generated_at
    FROM sec_published_reports r
    JOIN sec_filings f ON f.ticker = r.ticker AND f.accession_number = ${quote(row.accessionNumber)}
    JOIN sec_filing_summaries s ON s.ticker = f.ticker AND s.accession_number = f.accession_number
    WHERE r.rowid = ${Number(row.sourceRow)} AND r.report_version = ${quote(JSON.parse(row.payload).reportVersion)}
      AND json_extract(s.payload, '$.generatedAt') = ${quote(summary.generatedAt)}
      AND NOT EXISTS (SELECT 1 FROM sec_published_reports newer WHERE newer.ticker = r.ticker AND newer.period_id = r.period_id AND (newer.generated_at > r.generated_at OR (newer.generated_at = r.generated_at AND newer.rowid > r.rowid)))
    ON CONFLICT(ticker, period_id, report_version) DO NOTHING;`);
  if (result[0]?.meta?.changes !== 1) throw new Error(`Snapshot source changed for ${row.ticker}; inspect before retrying`);
  console.log(`${row.ticker}: saved ${report.reportVersion}`);
}
