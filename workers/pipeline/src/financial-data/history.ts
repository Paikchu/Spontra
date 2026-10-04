import type {RevenueHistory, RevenueHistoryQuarter} from '../../../../shared/analysis-contract/revenue-history.ts';
import {historyQuarterFrom, mergeHistory, readHistory} from '../../../../shared/analysis-runtime/financial-data/history.ts';
import {allowData, type FinancialPolicy} from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import {D1SecRepository} from '../sec/d1.ts';
import {extractDisclosedQuarters, extractVerifiedCurrentQuarters, readReportedFacts, SEC_FLOW_PARSER_VERSION, type DocumentSource, type Fact} from './parser.ts';
import {readFilingDocuments, type SecReader} from './provider.ts';

/**
 * Deterministic quarterly revenue history for the business map trend. It reuses the complete-snapshot
 * extractor on the last two years of filings; each 10-Q also carries its year-ago comparative.
 * Runs only on otherwise idle data ticks and never touches the complete-snapshot pointer.
 */
export const HISTORY_VERSION = 'revenue-history.v1:' + SEC_FLOW_PARSER_VERSION;
export const historyKey = (cik: string) => `sec:revenue-history:v1:${cik}`;
const cursorKey = (cik: string) => `sec:revenue-history-cursor:v1:${cik}`;
const REFRESH_MS = 86400000, LOOKBACK_DAYS = 820, MAX_DOCUMENTS = 14;

type HistoryDocument = {url: string; accession: string; filedAt: string; periodEnd: string; form: string};
type HistoryCursor = {version: string; ticker: string; industry: DocumentSource['industry']; documents: HistoryDocument[]; index: number; facts: Fact[]; issues: string[]; startedAt: string; finishedAt?: string};

const REVENUE_TAGS = new Set(['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenuesNetOfInterestExpense']);
const local = (tag: string) => tag.split(':').at(-1)!;
const span = (f: {start: string; end: string}) => (Date.parse(f.end) - Date.parse(f.start)) / 86400000;
const factKey = (f: Fact) => [local(f.tag), f.currency, JSON.stringify(Object.entries(f.dimensions).sort())].join('|');
const nextDay = (date: string) => new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);

async function listDocuments(cik: string, reader: SecReader, now: Date): Promise<{documents: HistoryDocument[]; industry: DocumentSource['industry']}> {
  const data = await (await reader.read(`https://data.sec.gov/submissions/CIK${cik}.json`)).json() as {cik: string | number; sic?: string; filings?: {recent?: {form: string[]; accessionNumber: string[]; primaryDocument: string[]; filingDate: string[]; reportDate: string[]; items?: string[]}}};
  if (String(data.cik).padStart(10, '0') !== cik) throw new Error('Issuer identity mismatch');
  const recent = data.filings?.recent;
  if (!recent) throw new Error('Missing submissions');
  const sic = Number(data.sic), industry = sic >= 6300 && sic < 6500 ? 'insurance' : sic >= 6000 && sic < 6300 ? 'financial' : 'standard';
  const cutoff = now.getTime() - LOOKBACK_DAYS * 86400000, documents: HistoryDocument[] = [];
  for (let i = 0; i < recent.form.length && documents.length < MAX_DOCUMENTS; i++) {
    const form = recent.form[i];
    if (!/^10-[QK]$/.test(form) && !(form === '8-K' && recent.items?.[i]?.includes('2.02'))) continue;
    if (Date.parse(recent.filingDate[i]) < cutoff) break;
    const accession = recent.accessionNumber[i], primary = recent.primaryDocument[i];
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession) || !/^[A-Za-z0-9_.-]+\.html?$/.test(primary)) continue;
    documents.push({url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/${primary}`, accession, filedAt: recent.filingDate[i], periodEnd: recent.reportDate[i], form});
  }
  return {documents, industry};
}

/** Fourth quarter = same-concept, same-dimension full year minus nine-month cumulative, from unflagged filings only. */
export function deriveFourthQuarters(facts: Fact[], cik: string): RevenueHistoryQuarter[] {
  const quarters: RevenueHistoryQuarter[] = [];
  const annuals = facts.filter(f => span(f) >= 330 && span(f) <= 380);
  for (const end of new Set(annuals.map(f => f.end))) {
    const derived: Fact[] = [];
    for (const annual of annuals.filter(f => f.end === end)) {
      const prior = facts.find(f => f.start === annual.start && factKey(f) === factKey(annual) && span(f) >= 230 && span(f) <= 310 && span({start: f.end, end: annual.end}) >= 70 && span({start: f.end, end: annual.end}) <= 110);
      if (prior) derived.push({...annual, start: nextDay(prior.end), context: `derived:${annual.context}-${prior.context}`, value: annual.value - prior.value, precision: Math.min(annual.precision, prior.precision), operands: [annual, prior], formula: `同一财年、币种、概念和维度的全年累计 ${annual.value} − 前九个月累计 ${prior.value} = 第四季度 ${annual.value - prior.value}`});
    }
    if (!derived.length) continue;
    const source = derived[0].source;
    for (const q of extractVerifiedCurrentQuarters({...source, cik}, derived).quarters) {
      const item = historyQuarterFrom(q, {accession: source.accession, url: source.url, filedAt: source.filedAt, form: '10-K'});
      if (item) quarters.push(item);
    }
  }
  return quarters;
}

/** One bounded step: at most `maxDocuments` filings per call; progress and partial history persist between ticks. */
export async function runHistoryStep(db: D1Database, reader: SecReader, target: {ticker: string; cik: string}, now = new Date(), maxDocuments = 3): Promise<{ticker: string; documents: number; finished: boolean; quarters: number; issues: string[]}> {
  const repository = new D1SecRepository(db);
  let cursor = (await repository.getCache<HistoryCursor>(cursorKey(target.cik)))?.payload;
  if (!cursor || cursor.version !== HISTORY_VERSION || cursor.ticker !== target.ticker || (cursor.finishedAt && now.getTime() - Date.parse(cursor.finishedAt) >= REFRESH_MS)) {
    const listing = await listDocuments(target.cik, reader, now);
    cursor = {version: HISTORY_VERSION, ticker: target.ticker, industry: listing.industry, documents: listing.documents, index: 0, facts: [], issues: [], startedAt: now.toISOString()};
  }
  const incoming: RevenueHistoryQuarter[] = [], selected = cursor.documents.slice(cursor.index, cursor.index + maxDocuments);
  for (const document of selected) {
    try {
      for (const content of await readFilingDocuments(document.url, reader)) {
        const source: DocumentSource = {url: content.url, accession: document.accession, filedAt: document.filedAt, cik: target.cik, industry: cursor.industry};
        const parsed = extractDisclosedQuarters(content.html, source);
        for (const q of parsed.quarters) {
          const item = historyQuarterFrom(q, {accession: document.accession, url: content.url, filedAt: document.filedAt, form: document.form});
          if (item) incoming.push(item);
        }
        // Cumulative facts feed fourth-quarter derivation only from filings without a restatement flag.
        if (document.form !== '8-K' && !parsed.issues.includes('RESTATEMENT_REVIEW_REQUIRED')) {
          cursor.facts.push(...readReportedFacts(content.html, source).facts.filter(f => REVENUE_TAGS.has(local(f.tag)) && span(f) >= 230 && Object.keys(f.dimensions).every(axis => ['StatementBusinessSegmentsAxis', 'ProductOrServiceAxis', 'ConsolidationItemsAxis'].includes(local(axis)))).map(f => ({...f, source: {...f.source, url: content.url}})));
        }
        if (!parsed.quarters.length && parsed.issues.length) cursor.issues = [...new Set([...cursor.issues, ...parsed.issues.map(issue => `${document.accession}:${issue}`)])].slice(-40);
      }
    } catch {
      cursor.issues = [...new Set([...cursor.issues, `${document.accession}:SOURCE_TEMPORARILY_UNAVAILABLE`])].slice(-40);
    }
  }
  cursor.index += selected.length;
  const finished = cursor.index >= cursor.documents.length;
  if (finished) { incoming.push(...deriveFourthQuarters(cursor.facts, target.cik)); cursor.finishedAt = now.toISOString(); cursor.facts = []; }
  const existing = (await repository.getCache<RevenueHistory>(historyKey(target.cik)))?.payload;
  const history = mergeHistory(target.ticker, existing?.ticker === target.ticker ? existing.quarters : [], incoming, now.toISOString());
  if (history.quarters.length) await repository.setCache(historyKey(target.cik), history, now.toISOString());
  await repository.setCache(cursorKey(target.cik), cursor, now.toISOString());
  return {ticker: target.ticker, documents: selected.length, finished, quarters: history.quarters.length, issues: cursor.issues.slice(-5)};
}

/** Picks the first allowed, already-identified issuer whose history is unfinished or older than a day. */
export async function runHistoryTick(db: D1Database, reader: SecReader, policy: FinancialPolicy, now = new Date()) {
  const rows = await db.prepare('SELECT ticker,cik FROM financial_collection_jobs j WHERE generation=(SELECT MAX(generation) FROM financial_collection_jobs WHERE ticker=j.ticker)').bind().all<{ticker: string; cik: string}>();
  const identities = new Map(rows.results.filter(r => /^\d{10}$/.test(r.cik)).map(r => [r.ticker, r.cik]));
  const repository = new D1SecRepository(db);
  for (const ticker of policy.dataTickers) {
    const cik = identities.get(ticker);
    if (!cik || !allowData(policy, ticker)) continue;
    const cursor = (await repository.getCache<HistoryCursor>(cursorKey(cik)))?.payload;
    const due = !cursor || cursor.version !== HISTORY_VERSION || !cursor.finishedAt || now.getTime() - Date.parse(cursor.finishedAt) >= REFRESH_MS;
    if (due) return runHistoryStep(db, reader, {ticker, cik}, now);
  }
  return null;
}

export async function readRevenueHistory(db: D1Database, cik: string, ticker: string): Promise<RevenueHistory | null> {
  const record = await new D1SecRepository(db).getCache<unknown>(historyKey(cik));
  return record ? readHistory(record.payload, ticker) : null;
}
