import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFiscalPeriod, refreshFiscalPeriods, readFiscalPeriod, fiscalPeriodKey } from '../../workers/pipeline/src/sec/fiscal-period.ts';
import type { SecFiling, SecFiscalPeriod } from '../../shared/analysis-contract/report.ts';
const filing = { ticker: 'ORCL', accessionNumber: 'test', form: '10-Q', reportDate: '2026-08-31', documentUrl: 'https://www.sec.gov/Archives/edgar/data/1/test.htm' } as SecFiling;
const fact = (name: string, value: string, context = 'c1') => `<ix:nonNumeric name="dei:${name}" contextRef="${context}">${value}</ix:nonNumeric>`;
const html = (year = '2027', period = 'Q1', end = filing.reportDate) => fact('DocumentFiscalYearFocus', year) + fact('DocumentFiscalPeriodFocus', period) + fact('DocumentPeriodEndDate', end);
test('reads fiscal focus for non-calendar and 53-week years without date arithmetic', () => {
  assert.equal(parseFiscalPeriod(html(), filing)?.fiscalYear, 2027);
  assert.equal(parseFiscalPeriod(html(), filing)?.fiscalPeriod, 'Q1');
  const annual = { ...filing, form: '10-K', reportDate: '2026-01-31' };
  assert.equal(parseFiscalPeriod(html('2026', 'FY', annual.reportDate), annual)?.fiscalPeriod, 'FY');
});
test('rejects conflicting, mismatched, transition, event and missing metadata', () => {
  assert.equal(parseFiscalPeriod(html() + fact('DocumentFiscalYearFocus', '2026'), filing), null);
  assert.equal(parseFiscalPeriod(html('2027', 'Q1', '2025-08-31'), filing), null);
  assert.equal(parseFiscalPeriod(html() + fact('DocumentTransitionReport', 'true'), filing), null);
  assert.equal(parseFiscalPeriod(html(), { ...filing, form: '8-K' }), null);
  assert.equal(parseFiscalPeriod('FY2027 Q1 management outlook', filing), null);
  assert.equal(parseFiscalPeriod(fact('DocumentFiscalYearFocus', '2027') + fact('DocumentFiscalPeriodFocus', 'Q1', 'other') + fact('DocumentPeriodEndDate', filing.reportDate), filing), null);
});
test('backfills once, reads cache without network, and resolves grouped periodic source', async () => {
  const cache = new Map<string, { payload: unknown; fetchedAt: string }>();
  const repository = {
    async getCache<T>(key: string) { return (cache.get(key) as { payload: T; fetchedAt: string }) ?? null; },
    async setCache<T>(key: string, payload: T, fetchedAt: string) { cache.set(key, { payload, fetchedAt }); },
  };
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response(html()); }) as typeof fetch;
  await refreshFiscalPeriods(repository, [filing], 'test', fetcher);
  await refreshFiscalPeriods(repository, [filing], 'test', fetcher);
  assert.equal(calls, 1);
  assert.equal((await readFiscalPeriod(repository, filing))?.fiscalPeriod, 'Q1');
  const event = { ...filing, form: '8-K', accessionNumber: 'event', reportDate: '2026-09-10', earningsGroup: { periodEnd: filing.reportDate, sources: [filing] } } as SecFiling;
  assert.equal((await readFiscalPeriod(repository, event))?.sourceAccession, 'test');
  const saved = cache.get(fiscalPeriodKey(filing))!.payload as SecFiscalPeriod;
  assert.equal(saved.source, 'sec_dei');
});

test('limits scan work, negatively caches missing metadata, and stops on SEC throttling', async () => {
  const cache = new Map<string, { payload: unknown; fetchedAt: string }>();
  const repository = {
    async getCache<T>(key: string) { return (cache.get(key) as { payload: T; fetchedAt: string }) ?? null; },
    async setCache<T>(key: string, payload: T, fetchedAt: string) { cache.set(key, { payload, fetchedAt }); },
  };
  const filings = Array.from({ length: 6 }, (_, i) => ({ ...filing, accessionNumber: String(i) }));
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response('No DEI facts'); }) as typeof fetch;
  await refreshFiscalPeriods(repository, filings, 'test', fetcher);
  assert.equal(calls, 4);
  await refreshFiscalPeriods(repository, filings, 'test', fetcher);
  assert.equal(calls, 6);
  await refreshFiscalPeriods(repository, filings, 'test', fetcher);
  assert.equal(calls, 6);
  cache.clear(); calls = 0;
  await refreshFiscalPeriods(repository, filings, 'test', (async () => { calls++; return new Response('', { status: 429 }); }) as typeof fetch);
  assert.equal(calls, 1);
  assert.equal(cache.size, 0);
});

test('handles nested inline facts, transformed dates and ballot-box booleans', () => {
  const nested = fact('DocumentFiscalPeriodFocus', 'Q1')
    + fact('DocumentPeriodEndDate', `August 31, ${fact('DocumentFiscalYearFocus', '2026')}`)
    + fact('DocumentTransitionReport', '&#9744;');
  assert.equal(parseFiscalPeriod(nested, filing)?.fiscalYear, 2026);
  assert.equal(parseFiscalPeriod(nested.replace('&#9744;', '&#9746;'), filing), null);
});
