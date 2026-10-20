import type {RevenueHistory, RevenueHistoryQuarter} from '../../../../shared/analysis-contract/revenue-history.ts';
import {historyQuarterFrom, mergeHistory, readHistory, revenueHistorySchema, validHistoryQuarter} from '../../../../shared/analysis-runtime/financial-data/history.ts';
import {D1SecRepository} from '../sec/d1.ts';
import {extractVerifiedCurrentQuarters, readReportedFacts, type DocumentSource, type Fact} from './parser.ts';
import {readFilingDocuments, reportsFinancials, type SecReader} from './provider.ts';
import {extractRevenueHistory, REVENUE_PARSER_VERSION} from './revenue-parser.ts';

/**
 * Deterministic quarterly revenue history, independently validated from complete income statements.
 * Reads direct periods and all explicitly dated supplemental quarterly columns, including comparatives.
 * Run by the `history` task after each publication; it never touches the complete-snapshot pointer.
 */
export const HISTORY_VERSION = 'revenue-history.v6:' + REVENUE_PARSER_VERSION;
export const historyKey = (cik: string) => `sec:revenue-history:v1:${cik}`;
const cursorKey = (cik: string) => `sec:revenue-history-cursor:v1:${cik}`;
const REFRESH_MS = 86400000, LOOKBACK_DAYS = 1185, MAX_DOCUMENTS = 32, MAX_LISTED = 400, NOTICES_PER_STEP = 12, MAX_DOCUMENT_ATTEMPTS = 3;
/** Cumulative facts kept across scans for the fourth-quarter bridge: a 10-K's nine months come from the same fiscal
 * year's third-quarter report, filed up to about a year earlier. */
const FACT_RETENTION_DAYS = 450;

type HistoryDocument = {url: string; accession: string; filedAt: string; periodEnd: string; form: string};
/** `read`: accessions this history already read (or passed over as notices); a later scan reads only what is new. */
type HistoryCursor = {version: string; ticker: string; industry: DocumentSource['industry']; documents: HistoryDocument[]; index: number; reports?: number; facts: Fact[]; issues: string[]; attempts?: Record<string, number>; partial?: boolean; startedAt: string; finishedAt?: string; read?: string[]};
export type HistoryStepResult = {ticker: string; documents: number; finished: boolean; quarters: number; issues: string[]; partial?: boolean; retry?: {accession: string; attempts: number; remaining: number}; resolvedIssues?: string[]};

const REVENUE_TAGS = new Set(['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenuesNetOfInterestExpense', 'Revenue', 'RevenueFromContractsWithCustomers']);
const local = (tag: string) => tag.split(':').at(-1)!;
const span = (f: {start: string; end: string}) => (Date.parse(f.end) - Date.parse(f.start)) / 86400000;
/** Dimensions compared exactly: an operating-segments total (ConsolidationItemsAxis = OperatingSegmentsMember) is not the
 * consolidated amount (BRK.B nine months 2025: 274,998 against 277,212 USD millions), so no axis is dropped. */
const dimensionKey = (dimensions: Record<string, string>) => JSON.stringify(Object.entries(dimensions).sort());
const factKey = (f: Fact) => [f.tag, f.currency, dimensionKey(f.dimensions)].join('|');
const near = (a: number, b: number, tolerance = 1) => Math.abs(a - b) <= tolerance;
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
  if (!parsed.data.quarters.every(q => sameIssuer(q.source.url) && [...(q.lineage ?? []), ...(q.revenueAdjustments??[]).flatMap(a=>a.lineage??[]), ...q.segments.flatMap(s => [...(s.lineage ?? []), ...(s.children ?? []).flatMap(c => c.lineage ?? [])])].every(lineage => sameIssuer(lineage.url)))) return null;
  return {...parsed.data, ticker};
}

type SubmissionColumns = {form: string[]; accessionNumber: string[]; primaryDocument: string[]; filingDate: string[]; reportDate: string[]; items?: string[]};
/** At most this many older EDGAR submission pages are read per listing: an issuer that files thousands of prospectuses
 * a year (JPM: ~2,000 a month) pushes its periodic reports out of the `recent` block within a year. */
const MAX_SUBMISSION_PAGES = 48;

async function listDocuments(cik: string, reader: SecReader, now: Date): Promise<{documents: HistoryDocument[]; industry: DocumentSource['industry']}> {
  const data = await (await reader.read(`https://data.sec.gov/submissions/CIK${cik}.json`)).json() as {cik: string | number; sic?: string; filings?: {recent?: SubmissionColumns; files?: Array<{name?: string; filingFrom?: string; filingTo?: string}>}};
  if (String(data.cik).padStart(10, '0') !== cik) throw new Error('Issuer identity mismatch');
  const recent = data.filings?.recent;
  if (!recent) throw new Error('Missing submissions');
  const sic = Number(data.sic), industry = sic >= 6300 && sic < 6500 ? 'insurance' : sic >= 6000 && sic < 6300 ? 'financial' : 'standard';
  // 6-Ks are listed by date alone: most are notices, which the scan passes over without counting (reportsFinancials).
  const cutoff = now.getTime() - LOOKBACK_DAYS * 86400000, documents: HistoryDocument[] = [];
  let counted = 0, reachedCutoff = false;
  const full = () => counted >= MAX_DOCUMENTS || documents.length >= MAX_LISTED;
  const scan = (block: SubmissionColumns) => {
    for (let i = 0; i < block.form.length && !full(); i++) {
      if (Date.parse(block.filingDate[i]) < cutoff) { reachedCutoff = true; return; }
      const form = block.form[i];
      if (!/^(?:10-[QK]|20-F|6-K)(?:\/A)?$/.test(form) && !(form === '8-K' && block.items?.[i]?.includes('2.02'))) continue;
      const accession = block.accessionNumber[i], primary = block.primaryDocument[i];
      if (!/^\d{10}-\d{2}-\d{6}$/.test(accession) || !/^[A-Za-z0-9_.-]+\.html?$/.test(primary)) continue;
      documents.push({url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/${primary}`, accession, filedAt: block.filingDate[i], periodEnd: block.reportDate[i], form});
      if (!/^6-K/.test(form)) counted++;
    }
  };
  scan(recent);
  // The lookback reaches past `recent`: continue through the older pages EDGAR lists, newest first, until the cutoff.
  const pages = (data.filings?.files ?? []).filter(page => new RegExp(`^CIK${cik}-submissions-\\d{3}\\.json$`).test(page.name ?? '') && Date.parse(page.filingTo ?? '') >= cutoff)
    .sort((a, b) => (b.filingTo ?? '').localeCompare(a.filingTo ?? '')).slice(0, MAX_SUBMISSION_PAGES);
  for (const page of pages) {
    if (reachedCutoff || full()) break;
    const block = await (await reader.read(`https://data.sec.gov/submissions/${page.name}`)).json() as SubmissionColumns;
    if (!Array.isArray(block.form)) throw new Error('Missing submissions');
    scan(block);
  }
  return {documents, industry};
}

/** The amount the history holds for one concept and dimensions in one quarter: the revenue total, a segment or a
 * child whose every lineage entry names that concept and those dimensions. */
function historyAmount(quarter: RevenueHistoryQuarter, tag: string, dimensions: Fact['dimensions']): number | undefined {
  const key = dimensionKey(dimensions);
  const nodes = [{value: quarter.revenue, lineage: quarter.lineage}, ...quarter.segments.flatMap(s => [s, ...(s.children ?? [])])];
  const match = nodes.find(node => node.lineage?.length && node.lineage.every(l => l.concept === tag && dimensionKey(l.dimensions) === key));
  return match ? Number(match.value) : undefined;
}

/** The three quarters the history holds from `start` through `end`, back to back, or undefined. */
function firstThreeQuarters(history: RevenueHistoryQuarter[], start: string, end: string): RevenueHistoryQuarter[] | undefined {
  const chain: RevenueHistoryQuarter[] = [];
  for (let from = start; chain.length < 3;) {
    const next = history.find(q => q.periodStart === from && span({start: q.periodStart, end: q.periodEnd}) >= 80 && span({start: q.periodStart, end: q.periodEnd}) <= 100);
    if (!next) return undefined;
    chain.push(next); from = nextDay(next.periodEnd);
  }
  return chain[2].periodEnd === end ? chain : undefined;
}

/**
 * Fourth quarter = same-concept/dimension FY minus 9M. Within one filing presentation the subtraction stands as printed.
 * Across filings (a 10-K never prints the nine months; the same fiscal year's 10-Q does), the bridge must be shown to hold:
 * - the 10-Q's nine months and the 10-K's year share concept, currency and dimensions, and come from filings without a
 *   restatement flag (only those reach `facts`);
 * - every filing that reports either period, or any period the 10-K or 10-Q also report, reports the same amount, so
 *   neither presentation was recast after the other;
 * - the nine months equal the sum of the first three quarters already in the history, same concept and dimensions.
 * Identical tags alone do not prove comparability. Direct disclosed Q4 columns take priority over this fallback.
 */
export function deriveFourthQuarters(facts: Fact[], cik: string, history: RevenueHistoryQuarter[] = []): RevenueHistoryQuarter[] {
  const quarters: RevenueHistoryQuarter[] = [];
  const annuals = facts.filter(f => span(f) >= 330 && span(f) <= 380);
  const nineMonths = (f: Fact, annual: Fact) => f.start === annual.start && factKey(f) === factKey(annual) && span(f) >= 230 && span(f) <= 310 && span({start: f.end, end: annual.end}) >= 70 && span({start: f.end, end: annual.end}) <= 110;
  const single = (candidates: Fact[]) => new Set(candidates.map(f => f.value)).size === 1 ? candidates[0] : undefined;
  // A line was recast when another filing reports it (same concept and dimensions) differently for a period this filing
  // also reports. Only the bridged line counts: a prior year's regrouped sub-line elsewhere in the filing does not change it.
  const consistent = (line: Fact) => facts.filter(f => f.source.accession === line.source.accession && factKey(f) === factKey(line)).every(f => facts.every(g => g.source.accession === f.source.accession || factKey(g) !== factKey(f) || g.start !== f.start || g.end !== f.end || near(g.value, f.value)));
  for (const end of new Set(annuals.map(f => f.end))) {
    const derived: Fact[] = [];
    for (const annual of annuals.filter(f => f.end === end)) {
      let prior = single(facts.filter(f => f.source.accession === annual.source.accession && nineMonths(f, annual)));
      let bridge = 'same fiscal year, currency, concept and dimensions';
      if (!prior) {
        const candidate = single(facts.filter(f => f.source.accession !== annual.source.accession && f.source.filedAt <= annual.source.filedAt && nineMonths(f, annual)));
        const chain = candidate && firstThreeQuarters(history, candidate.start, candidate.end);
        const amounts = chain?.map(q => historyAmount(q, candidate!.tag, candidate!.dimensions));
        if (candidate && amounts?.every(a => a !== undefined) && near(amounts.reduce((sum, a) => sum + a!, 0), candidate.value, Math.max(1, 10 ** -candidate.precision)) && consistent(annual) && consistent(candidate)) {
          prior = candidate;
          bridge = `same fiscal year, currency, concept and dimensions across the annual report and the third-quarter report (${candidate.source.accession}), whose nine months equal the three quarters already reported`;
        }
      }
      if (prior) derived.push({...annual, start: nextDay(prior.end), context: `derived:${annual.context}-${prior.context}`, value: annual.value - prior.value, precision: Math.min(annual.precision, prior.precision), operands: [annual, prior], formula: `Fourth quarter ${annual.value - prior.value} = full fiscal year ${annual.value} − first nine months ${prior.value}, ${bridge}`});
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

/** One filing's documents read for the history: the quarters it discloses, the cumulative facts that feed
 * fourth-quarter derivation, and its issues. Each document is archived before it is read. */
async function readHistoryContents(contents: Awaited<ReturnType<typeof readFilingDocuments>>, document: HistoryDocument, reader: SecReader, cik: string, industry: DocumentSource['industry']) {
  const quarters: RevenueHistoryQuarter[] = [], facts: Fact[] = [], issues: string[] = [];
  for (const content of contents) {
    const revenueStructure = /<ix:nonFraction/i.test(content.html) ? await reader.revenueStructure?.(content.url, document.accession) ?? null : null;
    const source: DocumentSource = {url: content.url, accession: document.accession, filedAt: document.filedAt, cik, industry, ...(content.memberLabels ? {memberLabels: content.memberLabels} : {}), ...(revenueStructure ? {revenueStructure} : {})};
    await reader.archive?.(source, content.html, {form: document.form, reportDate: document.periodEnd});
    const parsed = extractRevenueHistory(content.html, source, document.form);
    quarters.push(...parsed.quarters);
    // Cumulative facts feed fourth-quarter derivation only from filings without a restatement flag.
    if (document.form !== '8-K' && !parsed.issues.includes('RESTATEMENT_REVIEW_REQUIRED')) {
      facts.push(...readReportedFacts(content.html, source).facts.filter(f => REVENUE_TAGS.has(local(f.tag)) && span(f) >= 230 && Object.keys(f.dimensions).every(axis => ['StatementBusinessSegmentsAxis', 'ProductOrServiceAxis', 'ConsolidationItemsAxis'].includes(local(axis)))).map(f => ({...f, source: {...f.source, url: content.url}})));
    }
    if (!parsed.quarters.length) issues.push(...parsed.issues.map(issue => `${document.accession}:${issue}`));
  }
  return {quarters, facts, issues};
}

/** One bounded step. A failed filing stays at its checkpoint for up to three attempts;
 * exhausted documents are explicitly partial. A manual rescan deletes only the cursor, never good history.
 * `restartFinished`: a finished scan continues now (a new publication), rather than after a day. A scan after a
 * finished one lists EDGAR again but reads only the filings the history has not read yet (a new 10-Q, an amendment,
 * a filing whose reads were exhausted); a new parser version or a deleted cursor reads everything again. */
export async function runHistoryStep(db: D1Database, reader: SecReader, target: {ticker: string; cik: string}, now = new Date(), maxDocuments = 3, options: {restartFinished?: boolean} = {}): Promise<HistoryStepResult> {
  if (!validCik(target.cik) || !/^[A-Z][A-Z0-9.-]{0,11}$/.test(target.ticker)) throw new Error('Invalid issuer identity');
  const repository = new D1SecRepository(db);
  const stored = (await repository.getCache<HistoryCursor>(cursorKey(target.cik)))?.payload;
  const current = stored && stored.version === HISTORY_VERSION && stored.ticker === target.ticker ? stored : undefined;
  let cursor: HistoryCursor;
  if (!current || (current.finishedAt && (options.restartFinished || now.getTime() - Date.parse(current.finishedAt) >= REFRESH_MS))) {
    const listing = await listDocuments(target.cik, reader, now);
    const previous = current?.finishedAt && current.read ? current : null;
    const listed = new Set(listing.documents.map(d => d.accession));
    const read = new Set((previous?.read ?? []).filter(accession => listed.has(accession)));
    const retained = (previous?.facts ?? []).filter(f => Date.parse(f.source.filedAt) >= now.getTime() - FACT_RETENTION_DAYS * 86400000);
    cursor = {version: HISTORY_VERSION, ticker: target.ticker, industry: listing.industry, documents: listing.documents.filter(d => !read.has(d.accession)), index: 0, facts: retained, issues: [], startedAt: now.toISOString(), read: [...read]};
  } else cursor = current;
  if(!cursor.documents.length&&!cursor.read?.length&&!cursor.issues.includes('NO_SUPPORTED_FILINGS'))cursor.issues.push('NO_SUPPORTED_FILINGS');
  cursor.read ??= [];
  const incoming: RevenueHistoryQuarter[] = [];
  const resolvedIssues: string[] = [];
  let attempted = 0, notices = 0, retry: HistoryStepResult['retry'];
  cursor.attempts ??= {};
  while (cursor.index < cursor.documents.length && (cursor.reports ?? 0) < MAX_DOCUMENTS && attempted < maxDocuments && notices < NOTICES_PER_STEP) {
    const document = cursor.documents[cursor.index];
    const temporaryIssue = `${document.accession}:SOURCE_TEMPORARILY_UNAVAILABLE`;
    let reading = false;
    try {
      // Commit a filing's facts only after all linked exhibits have been read and archived.
      // Otherwise a partial success followed by an R2 error would duplicate facts on retry.
      const contents = await readFilingDocuments(document.url, reader, document.accession, document.form);
      // A 6-K notice (monthly revenue, board, dividend) is archived but neither parsed, counted nor reported as an issue.
      if (!reportsFinancials(document.form, contents[0].html)) {
        await reader.archive?.({url: contents[0].url, accession: document.accession, filedAt: document.filedAt, cik: target.cik, industry: cursor.industry}, contents[0].html, {form: document.form, reportDate: document.periodEnd});
        delete cursor.attempts[document.accession];
        cursor.read.push(document.accession);
        cursor.index++; notices++;
        continue;
      }
      attempted++; reading = true;
      const {quarters: documentQuarters, facts: documentFacts, issues: documentIssues} = await readHistoryContents(contents, document, reader, target.cik, cursor.industry);
      incoming.push(...documentQuarters);
      cursor.facts.push(...documentFacts);
      if (cursor.issues.includes(temporaryIssue)) resolvedIssues.push(temporaryIssue);
      cursor.issues = [...new Set([...cursor.issues.filter(issue => issue !== temporaryIssue), ...(documentQuarters.length ? [] : documentIssues)])].slice(-40);
      delete cursor.attempts[document.accession];
      cursor.read.push(document.accession);
      cursor.reports = (cursor.reports ?? 0) + 1;
      cursor.index++;
    } catch {
      if (!reading) attempted++;
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
  const finished = cursor.index >= cursor.documents.length || (cursor.reports ?? 0) >= MAX_DOCUMENTS;
  const existing = historyForIssuer((await repository.getCache<unknown>(historyKey(target.cik)))?.payload, target.cik, target.ticker);
  // The cross-filing fourth-quarter bridge checks each nine months against the three quarters the history already holds.
  // The facts stay with the cursor (within retention) so the next scan, reading only a new 10-K, can still bridge its fourth quarter.
  if (finished && !cursor.finishedAt) { incoming.push(...deriveFourthQuarters(cursor.facts, target.cik, mergeHistory(target.ticker, existing?.quarters ?? [], incoming, now.toISOString()).quarters)); cursor.finishedAt = now.toISOString(); cursor.facts = cursor.facts.filter(f => Date.parse(f.source.filedAt) >= now.getTime() - FACT_RETENTION_DAYS * 86400000); }
  const obtainedData = incoming.some(validHistoryQuarter);
  const history = mergeHistory(target.ticker, existing?.quarters ?? [], incoming, obtainedData ? now.toISOString() : existing?.updatedAt ?? now.toISOString());
  // Retry progress belongs to the cursor. A failed/empty step must not date old data as new.
  if (obtainedData && history.quarters.length) await repository.setCache(historyKey(target.cik), history, now.toISOString());
  await repository.setCache(cursorKey(target.cik), cursor, now.toISOString());
  return {ticker: target.ticker, documents: attempted, finished, quarters: history.quarters.length, issues: cursor.issues.slice(-5), partial: cursor.partial ?? false, ...(retry ? {retry} : {}), ...(resolvedIssues.length ? {resolvedIssues} : {})};
}

export async function readRevenueHistory(db: D1Database, cik: string, ticker: string): Promise<RevenueHistory | null> {
  if (!validCik(cik)) return null;
  const record = await new D1SecRepository(db).getCache<unknown>(historyKey(cik));
  const history = record && historyForIssuer(record.payload, cik, ticker);
  return history ? readHistory(history, ticker) : null;
}

export type FilingRereadResult = {accession: string; form: string; filedAt: string; replaced: string[]; quarters: string[]; issues: string[]};

/**
 * Reads one filing again (admin "重新读取此报告") and replaces the history quarters that filing is the source of with what
 * it reads now. The filing is found in the issuer's EDGAR listing within the history lookback and read from its archived
 * copy when there is one. An annual report also re-derives its fourth quarter, read against the same fiscal year's
 * quarterly reports. A reading that yields no quarter replaces nothing: good history is never erased.
 */
export async function rereadHistoryFiling(db: D1Database, reader: SecReader, target: {ticker: string; cik: string}, accession: string, now = new Date()): Promise<FilingRereadResult> {
  if (!validCik(target.cik) || !/^[A-Z][A-Z0-9.-]{0,11}$/.test(target.ticker) || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) throw new Error('Invalid issuer identity');
  const listing = await listDocuments(target.cik, reader, now);
  const document = listing.documents.find(d => d.accession === accession);
  if (!document) throw new Error('FILING_NOT_IN_HISTORY_WINDOW');
  const contents = await readFilingDocuments(document.url, reader, document.accession, document.form);
  const result = {accession, form: document.form, filedAt: document.filedAt};
  if (!reportsFinancials(document.form, contents[0].html)) return {...result, replaced: [], quarters: [], issues: [`${accession}:NOT_A_FINANCIAL_REPORT`]};
  const read = await readHistoryContents(contents, document, reader, target.cik, listing.industry);
  const facts = [...read.facts];
  const annual = /^(?:10-K|20-F)(?:\/A)?$/.test(document.form);
  if (annual) {
    // The nine months of the same fiscal year come from the quarterly reports filed in the year before this one.
    const from = Date.parse(document.filedAt) - 400 * 86400000;
    for (const quarterly of listing.documents.filter(d => /^10-Q(?:\/A)?$/.test(d.form) && Date.parse(d.filedAt) >= from && d.filedAt <= document.filedAt)) {
      facts.push(...(await readHistoryContents(await readFilingDocuments(quarterly.url, reader, quarterly.accession, quarterly.form), quarterly, reader, target.cik, listing.industry)).facts);
    }
  }
  const repository = new D1SecRepository(db);
  const existing = historyForIssuer((await repository.getCache<unknown>(historyKey(target.cik)))?.payload, target.cik, target.ticker)?.quarters ?? [];
  const kept = existing.filter(q => q.source.accession !== accession);
  const derived = annual ? deriveFourthQuarters(facts, target.cik, mergeHistory(target.ticker, kept, read.quarters, now.toISOString()).quarters).filter(q => q.source.accession === accession) : [];
  const incoming = [...read.quarters, ...derived].filter(validHistoryQuarter);
  if (!incoming.length) return {...result, replaced: [], quarters: [], issues: read.issues.length ? read.issues : [`${accession}:NO_DIRECT_COMPARABLE_QUARTER`]};
  const history = mergeHistory(target.ticker, kept, incoming, now.toISOString());
  await repository.setCache(historyKey(target.cik), history, now.toISOString());
  const held = new Set(history.quarters.filter(q => q.source.accession === accession).map(q => q.periodEnd));
  return {...result, replaced: existing.filter(q => q.source.accession === accession).map(q => q.periodEnd).sort(), quarters: [...held].sort(), issues: read.issues};
}
