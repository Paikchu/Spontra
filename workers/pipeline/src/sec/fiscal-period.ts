import type { SecFiscalPeriod, SecFiling } from '../../../../shared/analysis-contract/report.ts';
import type { SecRepository } from './types.ts';

export const fiscalPeriodKey = (filing: Pick<SecFiling, 'ticker' | 'accessionNumber'>) => `sec:fiscal-period:v1:${filing.ticker}:${filing.accessionNumber}`;
const periodic = (form: string) => /^(10-Q|10-K|20-F)(\/A)?$/.test(form);

/** Read document-focus DEI facts, never comparative metric contexts or generated prose. */
export function parseFiscalPeriod(html: string, filing: SecFiling): SecFiscalPeriod | null {
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
    if (!year || !/^20\d{2}$/.test(year) || !period || !/^(FY|Q[1-4]|H[12]|M9)$/.test(period) || end !== filing.reportDate) continue;
    if (transition === 'true' || transition === '1' || (facts.has('dei:DocumentTransitionReport') && transition === undefined)) continue;
    if (/^(10-K|20-F)/.test(filing.form) && period !== 'FY') continue;
    if (/^10-Q/.test(filing.form) && !/^Q[1-3]$/.test(period)) continue;
    found.push({ fiscalYear: Number(year), fiscalPeriod: period as SecFiscalPeriod['fiscalPeriod'], periodEnd: end, source: 'sec_dei', sourceAccession: filing.accessionNumber, sourceUrl: filing.documentUrl });
  }
  if (!found.length || found.some(value => value.fiscalYear !== found[0].fiscalYear || value.fiscalPeriod !== found[0].fiscalPeriod)) return null;
  return found[0];
}

/** Bounded background backfill. Reads remain cache-only and do not trigger SEC requests. */
export async function refreshFiscalPeriods(repository: Pick<SecRepository, 'getCache' | 'setCache'>, filings: SecFiling[], userAgent: string, fetcher: typeof fetch = fetch, now = new Date()): Promise<void> {
  let attempted = 0;
  for (const filing of filings) {
    if (!periodic(filing.form)) continue;
    const cached = await repository.getCache<SecFiscalPeriod | null>(fiscalPeriodKey(filing));
    if (cached && (cached.payload || now.getTime() - Date.parse(cached.fetchedAt) < 86400000)) continue;
    if (attempted++ >= 4) break;
    try {
      const url = new URL(filing.documentUrl);
      if (url.origin !== 'https://www.sec.gov' || !url.pathname.startsWith('/Archives/edgar/data/')) continue;
      const response = await fetcher(url.toString(), { headers: { 'user-agent': userAgent, accept: 'text/html' }, signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) break; // Respect SEC throttling; keep existing successful metadata.
      const period = parseFiscalPeriod(await response.text(), filing);
      await repository.setCache(fiscalPeriodKey(filing), period, now.toISOString());
    } catch { break; } // A metadata failure must not interrupt discovery/publication.
  }
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
