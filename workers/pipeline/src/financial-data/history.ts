import type {RevenueHistory, RevenueHistoryQuarter} from '../../../../shared/analysis-contract/revenue-history.ts';
import {historyQuarterFrom, mergeHistory, readHistory, revenueHistorySchema, validHistoryQuarter} from '../../../../shared/analysis-runtime/financial-data/history.ts';
import {allowData, type FinancialPolicy} from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import {D1SecRepository} from '../sec/d1.ts';
import {extractVerifiedCurrentQuarters, readReportedFacts, type DocumentSource, type Fact} from './parser.ts';
import {readFilingDocuments, type SecReader} from './provider.ts';
import {extractRevenueHistory, REVENUE_PARSER_VERSION} from './revenue-parser.ts';

/**
 * Deterministic quarterly revenue history, independently validated from complete income statements.
 * Reads direct periods and all explicitly dated supplemental quarterly columns, including comparatives.
 * Runs only on otherwise idle data ticks and never touches the complete-snapshot pointer.
 */
export const HISTORY_VERSION = 'revenue-history.v4:' + REVENUE_PARSER_VERSION;
export const historyKey = (cik: string) => `sec:revenue-history:v1:${cik}`;
const cursorKey = (cik: string) => `sec:revenue-history-cursor:v1:${cik}`;
const REFRESH_MS = 86400000, LOOKBACK_DAYS = 1185, MAX_DOCUMENTS = 32, MAX_DOCUMENT_ATTEMPTS = 3;

type HistoryDocument = {url: string; accession: string; filedAt: string; periodEnd: string; form: string};
type HistoryCursor = {version: string; ticker: string; industry: DocumentSource['industry']; documents: HistoryDocument[]; index: number; facts: Fact[]; issues: string[]; attempts?: Record<string, number>; partial?: boolean; startedAt: string; finishedAt?: string};
export type HistoryStepResult = {ticker: string; documents: number; finished: boolean; quarters: number; issues: string[]; partial?: boolean; retry?: {accession: string; attempts: number; remaining: number}; resolvedIssues?: string[]};

const REVENUE_TAGS = new Set(['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenuesNetOfInterestExpense']);
const local = (tag: string) => tag.split(':').at(-1)!;
const span = (f: {start: string; end: string}) => (Date.parse(f.end) - Date.parse(f.start)) / 86400000;
const factKey = (f: Fact) => [f.tag, f.currency, JSON.stringify(Object.entries(f.dimensions).sort())].join('|');
const nextDay = (date: string) => new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
const validCik = (cik: string) => /^\d{10}$/.test(cik) && Number(cik) > 0;

/** Callers supply a resolved issuer CIK. Only this issuer-scoped cache may project an alias;
 * the general readHistory validator remains strict about ticker identity. Check all provenance,
 * including operands/children, so a wrong-company or mixed-company cache is never relabelled. */
export function historyForIssuer(raw: unknown, cik: string, ticker: string): RevenueHistory | null {
  if (!validCik(cik) || !/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) return null;
  const parsed = revenueHistorySchema.safeParse(raw);
  if (!parsed.success) return null;
  const sameIssuer = (value: string) => {
    try {
      const url = new URL(value), sourceCik = url.pathname.match(/^\/Archives\/edgar\/data\/(\d{1,10})\//)?.[1];
      return url.protocol === 'https:' && ['www.sec.gov', 'sec.gov'].includes(url.hostname) && !url.username && !url.password && !url.port && !!sourceCik && Number(sourceCik) === Number(cik);
    } catch { return false; }
  };
  if (!parsed.data.quarters.every(q => sameIssuer(q.source.url) && [...(q.lineage ?? []), ...q.segments.flatMap(s => [...(s.lineage ?? []), ...(s.children ?? []).flatMap(c => c.lineage ?? [])])].every(lineage => sameIssuer(lineage.url)))) return null;
  return {...parsed.data, ticker};
}

async function listDocuments(cik: string, reader: SecReader, now: Date): Promise<{documents: HistoryDocument[]; industry: DocumentSource['industry']}> {
  const data = await (await reader.read(`https://data.sec.gov/submissions/CIK${cik}.json`)).json() as {cik: string | number; sic?: string; filings?: {recent?: {form: string[]; accessionNumber: string[]; primaryDocument: string[]; filingDate: string[]; reportDate: string[]; items?: string[]}}};
  if (String(data.cik).padStart(10, '0') !== cik) throw new Error('Issuer identity mismatch');
  const recent = data.filings?.recent;
  if (!recent) throw new Error('Missing submissions');
  const sic = Number(data.sic), industry = sic >= 6300 && sic < 6500 ? 'insurance' : sic >= 6000 && sic < 6300 ? 'financial' : 'standard';
  const cutoff = now.getTime() - LOOKBACK_DAYS * 86400000, documents: HistoryDocument[] = [];
  for (let i = 0; i < recent.form.length && documents.length < MAX_DOCUMENTS; i++) {
    const form = recent.form[i];
    if (!/^10-[QK](?:\/A)?$/.test(form) && !(form === '8-K' && recent.items?.[i]?.includes('2.02'))) continue;
    if (Date.parse(recent.filingDate[i]) < cutoff) break;
    const accession = recent.accessionNumber[i], primary = recent.primaryDocument[i];
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession) || !/^[A-Za-z0-9_.-]+\.html?$/.test(primary)) continue;
    documents.push({url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/${primary}`, accession, filedAt: recent.filingDate[i], periodEnd: recent.reportDate[i], form});
  }
  return {documents, industry};
}

/** Fourth quarter = same-concept/dimension FY minus 9M only within one filing presentation.
 * Cross-filing subtraction requires a separate verified bridge; identical tags alone do not prove
 * comparability after a recast. Direct disclosed Q4 columns take priority over this fallback. */
export function deriveFourthQuarters(facts: Fact[], cik: string): RevenueHistoryQuarter[] {
  const quarters: RevenueHistoryQuarter[] = [];
  const annuals = facts.filter(f => span(f) >= 330 && span(f) <= 380);
  for (const end of new Set(annuals.map(f => f.end))) {
    const derived: Fact[] = [];
    for (const annual of annuals.filter(f => f.end === end)) {
      const candidates = facts.filter(f => f.source.accession === annual.source.accession && f.start === annual.start && factKey(f) === factKey(annual) && span(f) >= 230 && span(f) <= 310 && span({start: f.end, end: annual.end}) >= 70 && span({start: f.end, end: annual.end}) <= 110);
      const prior = new Set(candidates.map(f => f.value)).size === 1 ? candidates[0] : undefined;
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

/** One bounded step. A failed filing stays at its checkpoint for up to three attempts;
 * exhausted documents are explicitly partial. A manual rescan deletes only the cursor, never good history. */
export async function runHistoryStep(db: D1Database, reader: SecReader, target: {ticker: string; cik: string}, now = new Date(), maxDocuments = 3): Promise<HistoryStepResult> {
  if (!validCik(target.cik) || !/^[A-Z][A-Z0-9.-]{0,11}$/.test(target.ticker)) throw new Error('Invalid issuer identity');
  const repository = new D1SecRepository(db);
  let cursor = (await repository.getCache<HistoryCursor>(cursorKey(target.cik)))?.payload;
  if (!cursor || cursor.version !== HISTORY_VERSION || cursor.ticker !== target.ticker || (cursor.finishedAt && now.getTime() - Date.parse(cursor.finishedAt) >= REFRESH_MS)) {
    const listing = await listDocuments(target.cik, reader, now);
    cursor = {version: HISTORY_VERSION, ticker: target.ticker, industry: listing.industry, documents: listing.documents, index: 0, facts: [], issues: [], startedAt: now.toISOString()};
  }
  const incoming: RevenueHistoryQuarter[] = [], selected = cursor.documents.slice(cursor.index, cursor.index + maxDocuments);
  const resolvedIssues: string[] = [];
  let attempted = 0, retry: HistoryStepResult['retry'];
  cursor.attempts ??= {};
  for (const document of selected) {
    attempted++;
    const temporaryIssue = `${document.accession}:SOURCE_TEMPORARILY_UNAVAILABLE`;
    try {
      // Commit a filing's facts only after all linked exhibits have been read and archived.
      // Otherwise a partial success followed by an R2 error would duplicate facts on retry.
      const documentQuarters: RevenueHistoryQuarter[] = [], documentFacts: Fact[] = [], documentIssues: string[] = [];
      for (const content of await readFilingDocuments(document.url, reader)) {
        const source: DocumentSource = {url: content.url, accession: document.accession, filedAt: document.filedAt, cik: target.cik, industry: cursor.industry};
        await reader.archive?.(source, content.html, {form: document.form, reportDate: document.periodEnd});
        const parsed = extractRevenueHistory(content.html, source, document.form);
        documentQuarters.push(...parsed.quarters);
        // Cumulative facts feed fourth-quarter derivation only from filings without a restatement flag.
        if (document.form !== '8-K' && !parsed.issues.includes('RESTATEMENT_REVIEW_REQUIRED')) {
          documentFacts.push(...readReportedFacts(content.html, source).facts.filter(f => REVENUE_TAGS.has(local(f.tag)) && span(f) >= 230 && Object.keys(f.dimensions).every(axis => ['StatementBusinessSegmentsAxis', 'ProductOrServiceAxis', 'ConsolidationItemsAxis'].includes(local(axis)))).map(f => ({...f, source: {...f.source, url: content.url}})));
        }
        if (!parsed.quarters.length) documentIssues.push(...parsed.issues.map(issue => `${document.accession}:${issue}`));
      }
      incoming.push(...documentQuarters);
      cursor.facts.push(...documentFacts);
      if (cursor.issues.includes(temporaryIssue)) resolvedIssues.push(temporaryIssue);
      cursor.issues = [...new Set([...cursor.issues.filter(issue => issue !== temporaryIssue), ...documentIssues])].slice(-40);
      delete cursor.attempts[document.accession];
      cursor.index++;
    } catch {
      const attempts = (cursor.attempts[document.accession] ?? 0) + 1;
      cursor.attempts[document.accession] = attempts;
      if (attempts < MAX_DOCUMENT_ATTEMPTS) {
        cursor.issues = [...new Set([...cursor.issues, temporaryIssue])].slice(-40);
        retry = {accession: document.accession, attempts, remaining: MAX_DOCUMENT_ATTEMPTS - attempts};
        break;
      }
      if (cursor.issues.includes(temporaryIssue)) resolvedIssues.push(temporaryIssue);
      cursor.issues = [...new Set([...cursor.issues.filter(issue => issue !== temporaryIssue), `${document.accession}:SOURCE_RETRY_EXHAUSTED`])].slice(-40);
      cursor.partial = true;
      cursor.index++;
    }
  }
  const finished = cursor.index >= cursor.documents.length;
  if (finished && !cursor.finishedAt) { incoming.push(...deriveFourthQuarters(cursor.facts, target.cik)); cursor.finishedAt = now.toISOString(); cursor.facts = []; }
  const existing = historyForIssuer((await repository.getCache<unknown>(historyKey(target.cik)))?.payload, target.cik, target.ticker);
  const obtainedData = incoming.some(validHistoryQuarter);
  const history = mergeHistory(target.ticker, existing?.quarters ?? [], incoming, obtainedData ? now.toISOString() : existing?.updatedAt ?? now.toISOString());
  // Retry progress belongs to the cursor. A failed/empty step must not date old data as new.
  if (obtainedData && history.quarters.length) await repository.setCache(historyKey(target.cik), history, now.toISOString());
  await repository.setCache(cursorKey(target.cik), cursor, now.toISOString());
  return {ticker: target.ticker, documents: attempted, finished, quarters: history.quarters.length, issues: cursor.issues.slice(-5), partial: cursor.partial ?? false, ...(retry ? {retry} : {}), ...(resolvedIssues.length ? {resolvedIssues} : {})};
}

/** Picks the first allowed, already-identified issuer whose history is unfinished or older than a day. */
export async function runHistoryTick(db: D1Database, reader: SecReader, policy: FinancialPolicy, now = new Date(), archive?: (ticker: string, source: DocumentSource, html: string, metadata?: {form?: string; reportDate?: string}) => Promise<void>) {
  const rows = await db.prepare('SELECT ticker,cik FROM financial_collection_jobs j WHERE generation=(SELECT MAX(generation) FROM financial_collection_jobs WHERE ticker=j.ticker)').bind().all<{ticker: string; cik: string}>();
  const identities = new Map(rows.results.filter(r => /^\d{10}$/.test(r.cik)).map(r => [r.ticker, r.cik]));
  const repository = new D1SecRepository(db);
  for (const ticker of policy.dataTickers) {
    const cik = identities.get(ticker);
    if (!cik || !allowData(policy, ticker)) continue;
    const cursor = (await repository.getCache<HistoryCursor>(cursorKey(cik)))?.payload;
    const due = !cursor || cursor.version !== HISTORY_VERSION || !cursor.finishedAt || now.getTime() - Date.parse(cursor.finishedAt) >= REFRESH_MS;
    if (due) return runHistoryStep(db, archive ? {...reader, archive: (source, html, metadata) => archive(ticker, source, html, metadata)} : reader, {ticker, cik}, now);
  }
  return null;
}

export async function readRevenueHistory(db: D1Database, cik: string, ticker: string): Promise<RevenueHistory | null> {
  if (!validCik(cik)) return null;
  const record = await new D1SecRepository(db).getCache<unknown>(historyKey(cik));
  const history = record && historyForIssuer(record.payload, cik, ticker);
  return history ? readHistory(history, ticker) : null;
}
