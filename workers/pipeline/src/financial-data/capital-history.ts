import type { PublicBusinessFlow } from '../../../../shared/analysis-contract/business-flow.ts';
import type { CapitalFiling, PublicCapitalStructure } from '../../../../shared/analysis-contract/capital-structure.ts';
import { buildCapitalQuarters, CAPITAL_VERSION, extractCapitalFiling } from '../../../../shared/analysis-runtime/financial-data/capital-structure.ts';
import { DISCLOSURE_EXTRACTION_VERSION, extractFilingDisclosures, type FilingDisclosures } from '../../../../shared/analysis-runtime/financial-data/disclosure-extraction.ts';
import { extractFinancialStatements, STATEMENTS_VERSION, type FinancialStatements } from '../../../../shared/analysis-runtime/financial-data/financial-statements.ts';
import { disclosureAuditPrefix, type StoredAudit } from './disclosure-audit.ts';
import type { ReportArchive } from './report-history.ts';

const QUARTERS = 8;
/** Archives made before the current capital projection are projected on read, a few per request, until collection re-archives them.
 * Stored statement tables are cheap to project; re-parsing a source document (megabytes of HTML) is not, so it is rarer still. */
const MAX_PROJECTED = 6, MAX_REPARSED_BYTES = 8_000_000;
const projections = new Map<string, { expires: number; capital: PublicCapitalStructure | null }>();

/** Stored tables from any extractor version that located the statements are reused; only a document whose statements were
 * not located (by an older locator) is parsed again from source. */
const storedTables = (record: StoredAudit) => Boolean(record.statementsKey) && record.statements?.status === 'extracted';

async function projectArchived(record: StoredAudit, archive: ReportArchive, ticker: string): Promise<CapitalFiling | null> {
  const json = async <T>(key: string | undefined) => { const object = key ? await archive.get(key) : null; return object ? JSON.parse(await object.text()) as T : null; };
  let statements = storedTables(record) ? await json<FinancialStatements>(record.statementsKey) : null;
  if (!statements) {
    const raw = await archive.get(record.rawKey);
    if (!raw) return null;
    const html = await raw.text();
    if (new TextEncoder().encode(html).byteLength !== record.sourceBytes) return null;
    const stored = record.parserVersion === DISCLOSURE_EXTRACTION_VERSION ? await json<FilingDisclosures>(record.inventoryKey) : null;
    statements = extractFinancialStatements(html, stored ?? extractFilingDisclosures(html, record.source));
  }
  if (statements.source.ticker !== ticker || statements.source.documentUrl !== record.source.documentUrl) return null;
  const s = record.source;
  return extractCapitalFiling(statements, { accession: s.accessionNumber, url: s.documentUrl, filedAt: s.filedAt, form: s.form });
}

/**
 * Balance sheets and cash flows for the latest eight quarters, from this issuer's archived 10-Q and 10-K
 * statements. Read only: no SEC fetch, collection, model, database or R2 write. A filing without a
 * reconciled statement leaves its quarter out; nothing is estimated.
 */
export async function readArchivedCapital(db: D1Database, archive: ReportArchive, flow: PublicBusinessFlow): Promise<PublicCapitalStructure | null> {
  const latest = flow.quarters.slice().sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  const issuer = latest?.sources.map(s => s.url.match(/\/Archives\/edgar\/data\/(\d+)\//)?.[1]).find(Boolean);
  if (!latest || !issuer) return null;
  const cutoff = new Date(latest.periodEnd);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 3);
  const rows = await db.prepare('SELECT payload FROM sec_cache WHERE cache_key LIKE ? ORDER BY fetched_at DESC LIMIT 100').bind(disclosureAuditPrefix(flow.ticker) + '%').all<{ payload: string }>();
  const records: StoredAudit[] = [];
  for (const row of rows.results) {
    try {
      const r = JSON.parse(row.payload) as StoredAudit, url = new URL(r.source.documentUrl);
      const cik = url.pathname.match(/^\/Archives\/edgar\/data\/(\d+)\//)?.[1];
      // Domestic statements come from the periodic report itself, never an earnings exhibit; a foreign issuer
      // furnishes its interim statements as a 6-K exhibit. A 6-K's report date is its filing date, so the
      // window is set by filing date and each statement's own period end is checked after it is read.
      const domestic = /^10-[QK](?:\/A)?$/.test(r.source.form), foreign = /^(?:20-F|40-F|6-K)(?:\/A)?$/.test(r.source.form);
      if (r.ticker === flow.ticker && r.source.ticker === flow.ticker && (foreign || (domestic && !/ex[-_]?99/i.test(r.source.documentUrl)))
        && url.protocol === 'https:' && url.hostname === 'www.sec.gov' && cik && Number(cik) === Number(issuer)
        && Date.parse(r.source.filedAt) > cutoff.getTime() && r.rawKey?.startsWith('financial-disclosures/')) records.push(r);
    } catch { /* A malformed optional archive cannot hide the others. */ }
  }
  records.sort((a, b) => b.source.filedAt.localeCompare(a.source.filedAt));
  const key = JSON.stringify([flow.ticker, latest.periodEnd, records.map(r => [r.documentId, r.contentSha256, r.capital?.version ?? null])]);
  const cached = projections.get(key);
  if (cached && cached.expires > Date.now()) return cached.capital;
  const filings: CapitalFiling[] = [], covered = new Set<string>();
  let projected = 0, reparsed = 0;
  for (const record of records) {
    // One quarter beyond the eighth supplies the cumulative bridge for the oldest quarterly cash flow.
    if (new Set(filings.map(f => f.cashFlow?.periodEnd ?? f.balanceSheet?.asOf)).size > QUARTERS) break;
    if (covered.has(record.source.reportDate)) continue;
    let filing = record.capital?.version === CAPITAL_VERSION ? record.capital : null;
    // Documents archived without any statement section (press releases, cover letters) are not worth projecting;
    // a domestic report the previous extractor missed is retried, since the locator has since improved.
    const located = record.statements?.status !== 'not_located' || (record.statements.version !== STATEMENTS_VERSION && /^10-[QK]/.test(record.source.form));
    if (!filing && located && projected < MAX_PROJECTED && (storedTables(record) || reparsed + record.sourceBytes <= MAX_REPARSED_BYTES)) {
      projected++;
      if (!storedTables(record)) reparsed += record.sourceBytes;
      filing = await projectArchived(record, archive, flow.ticker).catch(() => null);
    }
    const end = filing?.cashFlow?.periodEnd ?? filing?.balanceSheet?.asOf;
    if (!filing || !end || end > latest.periodEnd || covered.has(end)) continue;
    filings.push(filing);
    covered.add(record.source.reportDate).add(end);
  }
  const quarters = buildCapitalQuarters(filings, QUARTERS);
  const capital: PublicCapitalStructure | null = quarters.length ? { schemaVersion: 'capital-structure.v1', ticker: flow.ticker, quarters } : null;
  if (projections.size >= 4) projections.delete(projections.keys().next().value!);
  projections.set(key, { expires: Date.now() + 60_000, capital });
  return capital;
}
