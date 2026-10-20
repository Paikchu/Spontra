import type { PublicBusinessFlow } from '../../../../shared/analysis-contract/business-flow.ts';
import type { CapitalFiling, PublicCapitalStructure } from '../../../../shared/analysis-contract/capital-structure.ts';
import { buildCapitalQuarters } from '../../../../shared/analysis-runtime/financial-data/capital-structure.ts';
import type { StoredAudit } from './disclosure-audit.ts';

const QUARTERS = 8;

/**
 * Balance sheets and cash flows for the latest eight quarters, from the capital projection each archived
 * 10-Q and 10-K received when it was ingested. Pure: no R2 read and no parsing, so it is cheap enough to run
 * on every derivation pass. A filing whose projection predates the current version keeps its older one until
 * `refreshStaleProjections` re-archives it; a filing without a reconciled statement leaves its quarter out.
 */
export function assembleCapital(audits: StoredAudit[], flow: PublicBusinessFlow): PublicCapitalStructure | null {
  const latest = flow.quarters.slice().sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  const issuer = latest?.sources.map(s => s.url.match(/\/Archives\/edgar\/data\/(\d+)\//)?.[1]).find(Boolean);
  if (!latest || !issuer) return null;
  const cutoff = new Date(latest.periodEnd);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 3);
  const records: StoredAudit[] = [];
  for (const r of audits) {
    try {
      const url = new URL(r.source.documentUrl);
      const cik = url.pathname.match(/^\/Archives\/edgar\/data\/(\d+)\//)?.[1];
      // Domestic statements come from the periodic report itself, never an earnings exhibit; a foreign issuer
      // furnishes its interim statements as a 6-K exhibit. A 6-K's report date is its filing date, so the
      // window is set by filing date and each statement's own period end is checked after it is read.
      const domestic = /^10-[QK](?:\/A)?$/.test(r.source.form), foreign = /^(?:20-F|40-F|6-K)(?:\/A)?$/.test(r.source.form);
      if (r.ticker === flow.ticker && r.source.ticker === flow.ticker && (foreign || (domestic && !/ex[-_]?99/i.test(r.source.documentUrl)))
        && url.protocol === 'https:' && url.hostname === 'www.sec.gov' && cik && Number(cik) === Number(issuer)
        && Date.parse(r.source.filedAt) > cutoff.getTime()) records.push(r);
    } catch { /* A malformed optional archive cannot hide the others. */ }
  }
  records.sort((a, b) => b.source.filedAt.localeCompare(a.source.filedAt));
  const filings: CapitalFiling[] = [], covered = new Set<string>();
  for (const record of records) {
    // One quarter beyond the eighth supplies the cumulative bridge for the oldest quarterly cash flow.
    if (new Set(filings.map(f => f.cashFlow?.periodEnd ?? f.balanceSheet?.asOf)).size > QUARTERS) break;
    if (covered.has(record.source.reportDate)) continue;
    const filing = record.capital ?? null;
    const end = filing?.cashFlow?.periodEnd ?? filing?.balanceSheet?.asOf ?? filing?.rpo?.asOf;
    if (!filing || !end || end > latest.periodEnd || covered.has(end)) continue;
    filings.push(filing);
    covered.add(record.source.reportDate).add(end);
  }
  const quarters = buildCapitalQuarters(filings, QUARTERS);
  return quarters.length ? { schemaVersion: 'capital-structure.v1', ticker: flow.ticker, quarters } : null;
}
