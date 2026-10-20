import type { TranscriptItem, TranscriptDetail, TranscriptList } from '../../../../shared/analysis-contract/transcripts.ts';
import type { SecFiscalPeriod } from '../../../../shared/analysis-contract/report.ts';
import { dataTickersFor } from '../core.ts';
import { companyPolicyEnvironment, featureTickersFor } from '../financial-data/company-policy.ts';
import { AlphaVantageTranscriptProvider, TranscriptAccessError, TranscriptQuotaError } from '../guidance/sources.ts';
import { GuidanceStore } from '../guidance/store.ts';
import type { AnalysisEnv } from '../operations.ts';
import { parseFiscalPeriod } from '../sec/fiscal-period.ts';
import { inFiscalSequence, quarterAfterYearEnd, quarterOf, type FiscalLabel } from '../sec/fiscal-sequence.ts';
import { outboxStatement } from '../pipeline/outbox.ts';

const columns = `id,ticker,period_end periodEnd,accession,filing_url filingUrl,filed_at filedAt,
 fiscal_year fiscalYear,fiscal_quarter fiscalQuarter,status,title,source_url sourceUrl,characters,
 error_code errorCode,fetched_at fetchedAt,next_attempt_at nextAttemptAt,updated_at updatedAt`;
/** After a burst refusal the next request waits this long; Alpha Vantage's free key allows one a second, a few a minute. */
const THROTTLE_WAIT_MS = 65_000;
/** Days within which a foreign issuer's 6-K first reports a quarter. */
const RELEASE_DAYS = 120;

/** Every row key of a prefix as an index range, so the scan never reads the rest of sec_cache. */
const range = (prefix: string) => [prefix, prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)];

/**
 * Discover only actual archived reports, including history, with no external request: periodic reports (a 10-K or
 * 20-F is its fiscal year's fourth-quarter call), and a foreign issuer's quarters, which its 6-K results carry.
 */
export async function seedTranscripts(env: AnalysisEnv, now = new Date(), tickers?: string[]): Promise<void> {
  tickers ??= dataTickersFor(await companyPolicyEnvironment(env));
  const stamp = now.toISOString(), list = JSON.stringify(tickers);
  // A 6-K's report date is its filing date; the quarter it reports is the one the revenue history read from it. Only
  // the release that first reported the quarter counts (a year-later 6-K carries it as a comparative), and it goes in
  // first, so a fourth quarter released by 6-K is dated by that release rather than the 20-F months later.
  const [historyFrom, historyTo] = range('sec:revenue-history:v1:');
  await env.DB!.prepare(`INSERT INTO company_transcripts(id,ticker,period_end,accession,form,filing_url,filed_at,raw_key,next_attempt_at,updated_at)
    SELECT ticker||'-'||period_end,ticker,period_end,accession,form,filing_url,filed_at,
      (SELECT json_extract(a.payload,'$.rawKey') FROM sec_cache a WHERE a.cache_key >= 'sec:disclosure-audit:v1:'||ticker||':'
        AND a.cache_key < 'sec:disclosure-audit:v1:'||ticker||';' AND json_extract(a.payload,'$.source.accessionNumber')=accession
        AND json_extract(a.payload,'$.rawKey') IS NOT NULL LIMIT 1),?,? FROM (
      SELECT json_extract(h.payload,'$.ticker') ticker,json_extract(q.value,'$.periodEnd') period_end,json_extract(q.value,'$.source.accession') accession,
        json_extract(q.value,'$.source.form') form,json_extract(q.value,'$.source.url') filing_url,json_extract(q.value,'$.source.filedAt') filed_at
      FROM sec_cache h, json_each(h.payload,'$.quarters') q
      WHERE h.cache_key >= ? AND h.cache_key < ? AND json_extract(q.value,'$.source.form') IN ('6-K','6-K/A')
        AND json_extract(h.payload,'$.ticker') IN (SELECT value FROM json_each(?))
    ) WHERE period_end IS NOT NULL AND accession IS NOT NULL AND filing_url IS NOT NULL AND filed_at IS NOT NULL
      AND julianday(filed_at)-julianday(period_end) BETWEEN 0 AND ${RELEASE_DAYS}
      AND EXISTS (SELECT 1 FROM sec_cache a WHERE a.cache_key >= 'sec:disclosure-audit:v1:'||ticker||':' AND a.cache_key < 'sec:disclosure-audit:v1:'||ticker||';'
        AND json_extract(a.payload,'$.source.accessionNumber')=accession AND json_extract(a.payload,'$.rawKey') IS NOT NULL)
    ON CONFLICT(ticker,period_end) DO NOTHING`).bind(stamp,stamp,historyFrom,historyTo,list).run();
  await env.DB!.prepare(`INSERT INTO company_transcripts(id,ticker,period_end,accession,form,filing_url,filed_at,raw_key,next_attempt_at,updated_at)
    SELECT ticker||'-'||period_end,ticker,period_end,accession,form,filing_url,filed_at,raw_key,?,? FROM (
      SELECT json_extract(payload,'$.ticker') ticker,json_extract(payload,'$.source.reportDate') period_end,
      json_extract(payload,'$.source.accessionNumber') accession,json_extract(payload,'$.source.form') form,json_extract(payload,'$.source.documentUrl') filing_url,
      json_extract(payload,'$.source.filedAt') filed_at,json_extract(payload,'$.rawKey') raw_key,
      ROW_NUMBER() OVER(PARTITION BY json_extract(payload,'$.ticker'),json_extract(payload,'$.source.reportDate')
        ORDER BY json_extract(payload,'$.source.filedAt') DESC) position
      FROM sec_cache WHERE cache_key LIKE 'sec:disclosure-audit:v1:%'
        AND json_extract(payload,'$.source.form') IN ('10-Q','10-K','10-Q/A','10-K/A','20-F','20-F/A')
        AND json_extract(payload,'$.ticker') IN (SELECT value FROM json_each(?))
    ) WHERE position=1 AND period_end IS NOT NULL AND raw_key IS NOT NULL
    ON CONFLICT(ticker,period_end) DO NOTHING`).bind(stamp,stamp,list).run();
}

type LabelledRow = { id: string; ticker: string; period_end: string; fiscal_year: number; fiscal_quarter: number; status: string };

/**
 * Each company's fiscal labels: the fiscal periods the SEC reports recorded (`sec:fiscal-period:v1:*`) and the labels
 * this library gave its rows, one per period end (the recorded one first), put in sequence (fiscal-sequence.ts).
 */
async function labelsInSequence(db: D1Database, tickers?: string[]): Promise<{ labels: Map<string, Map<string, FiscalLabel>>; rows: LabelledRow[] }> {
  const [from, to] = range('sec:fiscal-period:v1:');
  const recorded = (await db.prepare('SELECT cache_key,payload FROM sec_cache WHERE cache_key >= ? AND cache_key < ?').bind(from, to).all<{ cache_key: string; payload: string }>()).results;
  const rows = (await db.prepare(`SELECT id,ticker,period_end,fiscal_year,fiscal_quarter,status FROM company_transcripts WHERE fiscal_year IS NOT NULL AND fiscal_quarter IS NOT NULL`)
    .bind().all<LabelledRow>()).results;
  const byTicker = new Map<string, Map<string, FiscalLabel>>();
  const add = (ticker: string, label: FiscalLabel) => {
    if (tickers && !tickers.includes(ticker)) return;
    const own = byTicker.get(ticker) ?? new Map<string, FiscalLabel>();
    if (!own.has(label.periodEnd)) own.set(label.periodEnd, label);
    byTicker.set(ticker, own);
  };
  for (const row of recorded) {
    const ticker = row.cache_key.slice(from.length).split(':')[0]!;
    let period: SecFiscalPeriod | null = null;
    try { period = JSON.parse(row.payload) as SecFiscalPeriod | null; } catch { continue; }
    const quarter = period ? quarterOf(period.fiscalPeriod) : null;
    if (period && quarter && /^\d{4}-\d{2}-\d{2}$/.test(period.periodEnd)) add(ticker, { fiscalYear: period.fiscalYear, quarter, periodEnd: period.periodEnd });
  }
  for (const row of rows) if ([1, 2, 3, 4].includes(row.fiscal_quarter)) add(row.ticker, { fiscalYear: row.fiscal_year, quarter: row.fiscal_quarter as FiscalLabel['quarter'], periodEnd: row.period_end });
  const labels = new Map([...byTicker].map(([ticker, own]) => [ticker, new Map(inFiscalSequence([...own.values()]).map(l => [l.periodEnd, l]))]));
  return { labels, rows };
}

/**
 * A row whose label the sequence corrects asked the provider for another quarter's call: it takes the corrected label
 * and is fetched again, its stored text dropped (a call from a year before, under this period's name).
 */
async function relabelTranscripts(db: D1Database, stamp: string): Promise<number> {
  const { labels, rows } = await labelsInSequence(db);
  const wrong = rows.flatMap(row => {
    const label = labels.get(row.ticker)?.get(row.period_end);
    return label && (label.fiscalYear !== row.fiscal_year || label.quarter !== row.fiscal_quarter) ? [{ row, label }] : [];
  });
  if (!wrong.length) return 0;
  await db.batch(wrong.map(({ row, label }) => db.prepare(`UPDATE company_transcripts SET fiscal_year=?,fiscal_quarter=?,
      status=CASE WHEN status='fetching' THEN status ELSE 'queued' END,attempts=0,error_code=NULL,title=NULL,source_url=NULL,content=NULL,characters=0,fetched_at=NULL,
      next_attempt_at=?,updated_at=? WHERE id=? AND fiscal_year=? AND fiscal_quarter=?`)
    .bind(label.fiscalYear, label.quarter, stamp, stamp, row.id, row.fiscal_year, row.fiscal_quarter)));
  console.warn(JSON.stringify({ event: 'transcript-relabelled', rows: wrong.map(({ row, label }) => `${row.id}:FY${row.fiscal_year}Q${row.fiscal_quarter}->FY${label.fiscalYear}Q${label.quarter}`) }));
  return wrong.length;
}

/**
 * The library rows ready for one company whose label is still the sequence's, newest first: a row the sequence corrects
 * holds another quarter's call until it is fetched again. Guidance reads these; it never calls the provider itself.
 */
export async function readyTranscripts(db: D1Database, ticker: string, sincePeriodEnd: string): Promise<Array<{
  id: string; periodEnd: string; accession: string; form: string; filedAt: string; title: string; sourceUrl: string; content: string; fiscalYear: number; fiscalQuarter: 1 | 2 | 3 | 4;
}>> {
  const { results } = await db.prepare(`SELECT id,period_end periodEnd,accession,form,filed_at filedAt,title,source_url sourceUrl,content,fiscal_year fiscalYear,fiscal_quarter fiscalQuarter
    FROM company_transcripts WHERE ticker=? AND status='ready' AND content IS NOT NULL AND period_end>=? ORDER BY period_end DESC`).bind(ticker, sincePeriodEnd)
    .all<{ id: string; periodEnd: string; accession: string; form: string; filedAt: string; title: string | null; sourceUrl: string | null; content: string; fiscalYear: number; fiscalQuarter: 1 | 2 | 3 | 4 }>();
  if (!results.length) return [];
  const labels = (await labelsInSequence(db, [ticker])).labels.get(ticker);
  return results.filter(row => {
    const label = labels?.get(row.periodEnd);
    return !label || (label.fiscalYear === row.fiscalYear && label.quarter === row.fiscalQuarter);
  }).map(row => ({ ...row, title: row.title ?? `${ticker} earnings call transcript`, sourceUrl: row.sourceUrl ?? '' }));
}

/** The library row for an earnings release: its own filing's row, else the period that ended in the 100 days before it. */
export async function transcriptForEvent(db: D1Database, ticker: string, accession: string, eventDate: string): Promise<{ status: string; fiscalYear: number | null; fiscalQuarter: number | null } | null> {
  const since = new Date(Date.parse(`${eventDate}T00:00:00Z`) - 100 * 86_400_000).toISOString().slice(0, 10);
  return db.prepare(`SELECT status,fiscal_year fiscalYear,fiscal_quarter fiscalQuarter FROM company_transcripts WHERE ticker=? AND (accession=? OR (period_end>=? AND period_end<?))
    ORDER BY accession=? DESC, period_end DESC LIMIT 1`).bind(ticker, accession, since, eventDate, accession).first();
}

type QueueRow = TranscriptItem & { raw_key: string; form: string; attempts: number };
class SourceMissing extends Error {}

/**
 * The fiscal quarter a row's call is filed under. A periodic report declares it (the SEC reports' recorded period, else
 * the document's DEI); a 6-K counts on from the issuer's newest fiscal year end, read from its archived annual report
 * when no label of the company's gives one. The label is then put in sequence with the company's others.
 */
async function labelRow(env: AnalysisEnv, row: QueueRow): Promise<FiscalLabel | null> {
  const db = env.DB!;
  const known = async () => [...((await labelsInSequence(db, [row.ticker])).labels.get(row.ticker)?.values() ?? [])].filter(l => l.periodEnd !== row.periodEnd);
  const declared = async (target: { raw_key: string; form: string; periodEnd: string; accession: string; filingUrl: string }): Promise<FiscalLabel | null> => {
    const recorded = await db.prepare('SELECT payload FROM sec_cache WHERE cache_key=?').bind(`sec:fiscal-period:v1:${row.ticker}:${target.accession}`).first<{ payload: string }>();
    let period = recorded ? JSON.parse(recorded.payload) as SecFiscalPeriod | null : null;
    if (period?.periodEnd !== target.periodEnd) {
      const object = await env.SEC_FILINGS.get(target.raw_key);
      if (!object) throw new SourceMissing(target.raw_key);
      period = parseFiscalPeriod(await object.text(), { form: target.form, reportDate: target.periodEnd, accessionNumber: target.accession, documentUrl: target.filingUrl });
    }
    // DEI annual focus maps to the fourth-quarter call. Never guess from calendar months.
    const quarter = period ? quarterOf(period.fiscalPeriod) : null;
    return period && quarter ? { fiscalYear: period.fiscalYear, quarter, periodEnd: target.periodEnd } : null;
  };
  let own: FiscalLabel | null;
  if (/^6-K/.test(row.form)) {
    own = quarterAfterYearEnd(await known(), row.periodEnd);
    if (!own) {
      // The newest annual report archived for the quarter's year end or before it, whether or not the library has a row
      // for its period: a 6-K that releases the fourth quarter is that 20-F's year.
      const [from, to] = range(`sec:disclosure-audit:v1:${row.ticker}:`);
      const annual = await db.prepare(`SELECT json_extract(payload,'$.rawKey') raw_key,json_extract(payload,'$.source.form') form,json_extract(payload,'$.source.reportDate') periodEnd,
          json_extract(payload,'$.source.accessionNumber') accession,json_extract(payload,'$.source.documentUrl') filingUrl FROM sec_cache
        WHERE cache_key >= ? AND cache_key < ? AND json_extract(payload,'$.source.form') IN ('20-F','20-F/A','10-K','10-K/A') AND json_extract(payload,'$.source.reportDate') <= ?
          AND json_extract(payload,'$.rawKey') IS NOT NULL ORDER BY json_extract(payload,'$.source.reportDate') DESC,json_extract(payload,'$.source.filedAt') DESC LIMIT 1`)
        .bind(from, to, row.periodEnd).first<{ raw_key: string; form: string; periodEnd: string; accession: string; filingUrl: string }>();
      const year = annual ? await declared(annual) : null;
      if (year?.quarter === 4) own = year.periodEnd === row.periodEnd ? year : quarterAfterYearEnd([...await known(), year], row.periodEnd);
    }
  } else own = await declared({ raw_key: row.raw_key, form: row.form, periodEnd: row.periodEnd, accession: row.accession, filingUrl: row.filingUrl });
  if (!own) return null;
  return inFiscalSequence([...await known(), own]).find(l => l.periodEnd === row.periodEnd)!;
}

export async function syncTranscript(env: AnalysisEnv, now = new Date(), fetcher: typeof fetch = fetch, causeId: string | null = null) {
  if (env.TRANSCRIPTS_ENABLED !== 'true' || !env.DB || !env.ALPHA_VANTAGE_API_KEY) return { status: 'disabled' };
  const policy = await companyPolicyEnvironment(env);
  const tickers = dataTickersFor(policy), stamp = now.toISOString();
  await seedTranscripts(env, now, tickers);
  await relabelTranscripts(env.DB, stamp);
  const budget = new GuidanceStore(env.DB,env.SEC_FILINGS);
  const cap = Number(env.GUIDANCE_DAILY_TRANSCRIPT_CALLS) > 0 ? Number(env.GUIDANCE_DAILY_TRANSCRIPT_CALLS) : 25;
  const spent = await env.DB.prepare("SELECT units FROM feature_budget WHERE day=? AND feature='guidance-transcript'").bind(stamp.slice(0,10)).first<{units:number}>();
  if ((spent?.units ?? 0) >= cap) return { status: 'daily_budget' };
  const lease = new Date(now.getTime()+120_000).toISOString();
  // Companies whose guidance reads the calls go first; then the newest periods.
  const row = await env.DB.prepare(`UPDATE company_transcripts SET status='fetching',lease_until=?,updated_at=? WHERE id=(
    SELECT id FROM company_transcripts WHERE ticker IN (SELECT value FROM json_each(?)) AND
      ((status IN ('queued','retry') AND next_attempt_at<=?) OR (status='fetching' AND lease_until<=?))
    ORDER BY ticker IN (SELECT value FROM json_each(?)) DESC,period_end DESC,ticker LIMIT 1) RETURNING *,${columns}`)
    .bind(lease,stamp,JSON.stringify(tickers),stamp,stamp,JSON.stringify(featureTickersFor(policy,'reports'))).first<QueueRow>();
  if (!row) return { status: 'idle' };
  const finish = async (status: string, code: string | null, next=stamp, uncount=false) => {
    await env.DB!.prepare(`UPDATE company_transcripts SET status=?,error_code=?,next_attempt_at=?,attempts=attempts-?,lease_until=NULL,updated_at=? WHERE id=? AND lease_until=?`)
      .bind(status,code,next,uncount?1:0,stamp,row.id,lease).run();
    return { status, ticker: row.ticker, period: row.periodEnd, ...(code ? { code } : {}) };
  };
  const tomorrow = new Date(now); tomorrow.setUTCHours(24,10,0,0);
  try {
    const label = await labelRow(env, row);
    if (!label) return await finish('needs_period', /^6-K/.test(row.form) ? 'FISCAL_YEAR_UNKNOWN' : 'FISCAL_PERIOD_UNKNOWN');
    await env.DB.prepare('UPDATE company_transcripts SET fiscal_year=?,fiscal_quarter=? WHERE id=? AND lease_until=?')
      .bind(label.fiscalYear,label.quarter,row.id,lease).run();
    if (!await budget.reserve('guidance-transcript',stamp.slice(0,10),cap)) return await finish('retry','DAILY_BUDGET',tomorrow.toISOString());
    await env.DB.prepare('UPDATE company_transcripts SET attempts=attempts+1 WHERE id=? AND lease_until=?').bind(row.id,lease).run();
    const material = await new AlphaVantageTranscriptProvider(env.ALPHA_VANTAGE_API_KEY,fetcher).fetch(row.ticker,{fiscalYear:label.fiscalYear,quarter:label.quarter,date:row.filedAt});
    // The provider often has the call a day or two after the filing: try again tomorrow, three tries in all.
    if (!material || !('text' in material)) return await finish(row.attempts>=2?'unavailable':'retry','PROVIDER_NO_TRANSCRIPT',tomorrow.toISOString());
    await env.DB.batch([
      env.DB.prepare(`UPDATE company_transcripts SET status='ready',title=?,source_url=?,content=?,characters=?,error_code=NULL,fetched_at=?,updated_at=?,lease_until=NULL WHERE id=? AND lease_until=?`)
        .bind(material.title,material.url,material.text,material.text.length,stamp,stamp,row.id,lease),
      outboxStatement(env.DB,{type:'transcript.stored',ticker:row.ticker,causeId},stamp,{sql:"EXISTS(SELECT 1 FROM company_transcripts WHERE id=? AND status='ready' AND fetched_at=?)",binds:[row.id,stamp]}),
    ]);
    return {status:'ready',ticker:row.ticker,period:row.periodEnd,characters:material.text.length};
  } catch(error) {
    if (error instanceof SourceMissing) return finish('retry','SOURCE_MISSING',tomorrow.toISOString());
    const message = (error instanceof Error ? error.message : 'Unknown failure')
      .replaceAll(env.ALPHA_VANTAGE_API_KEY, '[redacted]').replace(/https?:\/\/\S+/g, '[url]').slice(0,300);
    const detail = error instanceof TranscriptQuotaError ? error.detail : undefined;
    console.error(JSON.stringify({event:'transcript-library-error',ticker:row.ticker,period:row.periodEnd,message,...(detail ? {provider:detail} : {})}));
    // A refusal for rate is not a try at this period.
    if(error instanceof TranscriptQuotaError && error.scope === 'burst') {
      return finish('retry','PROVIDER_THROTTLED',new Date(now.getTime()+THROTTLE_WAIT_MS).toISOString(),true);
    }
    if(error instanceof TranscriptQuotaError) {
      // The key's allowance for the day is spent, whoever spent it: stop the whole library until the next UTC day.
      await env.DB.prepare("INSERT INTO feature_budget(day,feature,units) VALUES(?,'guidance-transcript',?) ON CONFLICT(day,feature) DO UPDATE SET units=MAX(units,excluded.units)").bind(stamp.slice(0,10),cap).run();
      return finish('retry','PROVIDER_DAILY_LIMIT',tomorrow.toISOString(),true);
    }
    if(error instanceof TranscriptAccessError) return finish(row.attempts>=2?'unavailable':'retry','PROVIDER_ACCESS',tomorrow.toISOString());
    return finish(row.attempts>=2?'unavailable':'retry','PROVIDER_ERROR',tomorrow.toISOString());
  }
}

export async function listTranscripts(env:AnalysisEnv,url:URL):Promise<TranscriptList> {
  const ticker=(url.searchParams.get('ticker')??'').toUpperCase(),offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
  const where=ticker?'WHERE ticker=?':'',args=ticker?[ticker]:[];
  const rows=await env.DB!.prepare(`SELECT ${columns} FROM company_transcripts ${where} ORDER BY period_end DESC,ticker LIMIT 100 OFFSET ?`).bind(...args,offset).all<TranscriptItem>();
  const count=await env.DB!.prepare(`SELECT count(*) n FROM company_transcripts ${where}`).bind(...args).first<{n:number}>();
  const companies=await env.DB!.prepare('SELECT DISTINCT ticker FROM company_transcripts ORDER BY ticker').bind().all<{ticker:string}>();
  return {transcripts:rows.results,companies:companies.results.map(r=>r.ticker),total:count?.n??0,offset,enabled:env.TRANSCRIPTS_ENABLED==='true'};
}
export async function transcriptDetail(env:AnalysisEnv,id:string):Promise<TranscriptDetail|null> {
  return env.DB!.prepare(`SELECT ${columns},content FROM company_transcripts WHERE id=?`).bind(id).first<TranscriptDetail>();
}
