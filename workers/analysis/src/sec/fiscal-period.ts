import type { SecFiscalPeriod, SecFiling } from '../../../../shared/analysis-contract/report.ts';
import type { SecRepository } from './types.ts';

export const fiscalPeriodKey = (filing: Pick<SecFiling, 'ticker' | 'accessionNumber'>) => `sec:fiscal-period:v1:${filing.ticker}:${filing.accessionNumber}`;
const periodic = (form: string) => /^(10-Q|10-K|20-F)(\/A)?$/.test(form);

/** A DEI focus the form can carry: an annual report the fiscal year, a quarterly report one of its first three quarters. */
function focusFits(form: string, period: string): boolean {
  if (!/^(FY|Q[1-4]|H[12]|M9)$/.test(period)) return false;
  if (/^(10-K|20-F)/.test(form)) return period === 'FY';
  return !/^10-Q/.test(form) || /^Q[1-3]$/.test(period);
}

/** Read document-focus DEI facts, never comparative metric contexts or generated prose. */
export function parseFiscalPeriod(html: string, filing: Pick<SecFiling, "form" | "reportDate" | "accessionNumber" | "documentUrl">): SecFiscalPeriod | null {
  if (!periodic(filing.form)) return null; // An 8-K document end is an event date.
  const contexts = new Map<string, Map<string, Set<string>>>();
  const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
  // Inline facts may be nested (Oracle wraps the fiscal year inside the period-end date).
  const stack: { attributes: string; start: number }[] = [];
  for (const token of html.matchAll(/<\/?ix:nonNumeric\b[^>]*>/gi)) {
    if (!token[0].startsWith('</')) { stack.push({ attributes: token[0], start: token.index! + token[0].length }); continue; }
    const opening = stack.pop();
    if (!opening) continue;
    const name = attr(opening.attributes, 'name');
    const context = attr(opening.attributes, 'contextRef');
    if (!name?.startsWith('dei:Document') || !context) continue;
    let value = html.slice(opening.start, token.index).replace(/<[^>]*>/g, '').replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) => String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n))).replace(/&nbsp;/g, ' ').trim();
    if (name === 'dei:DocumentPeriodEndDate' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const date = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})$/i.exec(value);
      if (date) {
        const month = ['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(date[1].toLowerCase()) + 1;
        value = `${date[3]}-${String(month).padStart(2, '0')}-${date[2].padStart(2, '0')}`;
      }
    }
    if (name === 'dei:DocumentTransitionReport') {
      if (value === '☐') value = 'false';
      if (value === '☒' || value === '☑') value = 'true';
    }
    const facts = contexts.get(context) ?? new Map<string, Set<string>>();
    const values = facts.get(name) ?? new Set<string>();
    values.add(value); facts.set(name, values); contexts.set(context, facts);
  }
  const found: SecFiscalPeriod[] = [];
  for (const facts of contexts.values()) {
    const one = (name: string) => { const values = facts.get(`dei:${name}`); return values?.size === 1 ? [...values][0] : undefined; };
    const year = one('DocumentFiscalYearFocus');
    const period = one('DocumentFiscalPeriodFocus');
    const end = one('DocumentPeriodEndDate');
    const transition = one('DocumentTransitionReport');
    if (!year || !/^20\d{2}$/.test(year) || !period || !focusFits(filing.form, period) || end !== filing.reportDate) continue;
    if (transition === 'true' || transition === '1' || (facts.has('dei:DocumentTransitionReport') && transition === undefined)) continue;
    found.push({ fiscalYear: Number(year), fiscalPeriod: period as SecFiscalPeriod['fiscalPeriod'], periodEnd: end, source: 'sec_dei', sourceAccession: filing.accessionNumber, sourceUrl: filing.documentUrl });
  }
  if (!found.length || found.some(value => value.fiscalYear !== found[0].fiscalYear || value.fiscalPeriod !== found[0].fiscalPeriod)) return null;
  return found[0];
}

/**
 * The fiscal focus of every periodic filing in the list, from the SEC Company Facts payload the pipeline already reads
 * for fundamentals. Each fact carries its filing's accession and the DEI focus that filing declared (`fy` is
 * DocumentFiscalYearFocus, `fp` DocumentFiscalPeriodFocus), so no filing document is fetched. A filing is labelled
 * only when all of its facts agree on the focus and one of them ends on the filing's report date.
 */
export function fiscalPeriodsFromCompanyFacts(payload: unknown, filings: SecFiling[]): SecFiscalPeriod[] {
  const wanted = new Map(filings.filter(f => periodic(f.form) && /^\d{4}-\d{2}-\d{2}$/.test(f.reportDate)).map(f => [f.accessionNumber, f]));
  const seen = new Map<string, { years: Set<unknown>; periods: Set<unknown>; endsOnReportDate: boolean }>();
  const facts = (payload as { facts?: unknown } | null)?.facts;
  for (const concepts of Object.values(facts && typeof facts === 'object' ? facts : {})) {
    for (const concept of Object.values(concepts && typeof concepts === 'object' ? concepts : {})) {
      for (const values of Object.values((concept as { units?: object } | null)?.units ?? {})) {
        if (!Array.isArray(values)) continue;
        for (const fact of values as Array<{ accn?: unknown; fy?: unknown; fp?: unknown; end?: unknown } | null>) {
          const filing = wanted.get(String(fact?.accn ?? ''));
          if (!filing || !fact) continue;
          const entry = seen.get(filing.accessionNumber) ?? { years: new Set(), periods: new Set(), endsOnReportDate: false };
          entry.years.add(fact.fy); entry.periods.add(fact.fp);
          entry.endsOnReportDate ||= fact.end === filing.reportDate;
          seen.set(filing.accessionNumber, entry);
        }
      }
    }
  }
  const found: SecFiscalPeriod[] = [];
  for (const [accession, filing] of wanted) {
    const entry = seen.get(accession);
    if (!entry) continue;
    const [year] = entry.years, [period] = entry.periods;
    if (entry.years.size !== 1 || entry.periods.size !== 1 || !entry.endsOnReportDate) continue;
    if (!Number.isInteger(year) || (year as number) < 2000 || (year as number) > 2100 || typeof period !== 'string' || !focusFits(filing.form, period)) continue;
    found.push({ fiscalYear: year as number, fiscalPeriod: period as SecFiscalPeriod['fiscalPeriod'], periodEnd: filing.reportDate, source: 'sec_dei', sourceAccession: accession, sourceUrl: filing.documentUrl });
  }
  return found;
}

export async function readFiscalPeriod(repository: Pick<SecRepository, 'getCache'>, filing: SecFiling): Promise<SecFiscalPeriod | null> {
  const end = filing.earningsGroup?.periodEnd || filing.reportDate;
  const sources = [filing, ...(filing.earningsGroup?.sources ?? [])].filter(source => periodic(source.form) && source.reportDate === end);
  for (const source of sources) {
    const cached = await repository.getCache<SecFiscalPeriod | null>(fiscalPeriodKey(source));
    if (cached?.payload?.periodEnd === end && cached.payload.sourceAccession === source.accessionNumber) return cached.payload;
  }
  return null;
}
