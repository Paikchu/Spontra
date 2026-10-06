import type { TranscriptItem, TranscriptDetail, TranscriptList } from '../../../../shared/analysis-contract/transcripts.ts';
import { dataTickersFor } from '../core.ts';
import { companyPolicyEnvironment } from '../financial-data/company-policy.ts';
import { AlphaVantageTranscriptProvider, TranscriptAccessError, TranscriptQuotaError } from '../guidance/sources.ts';
import { GuidanceStore } from '../guidance/store.ts';
import type { SecPipelineEnv } from '../operations.ts';
import { parseFiscalPeriod } from '../sec/fiscal-period.ts';

const columns = `id,ticker,period_end periodEnd,accession,filing_url filingUrl,filed_at filedAt,
 fiscal_year fiscalYear,fiscal_quarter fiscalQuarter,status,title,source_url sourceUrl,characters,
 error_code errorCode,fetched_at fetchedAt,next_attempt_at nextAttemptAt,updated_at updatedAt`;
async function allowed(env: SecPipelineEnv) { return dataTickersFor(await companyPolicyEnvironment(env)); }

/** Discover only actual archived periodic reports, including history, with no external request. */
export async function seedTranscripts(env: SecPipelineEnv, now = new Date()): Promise<void> {
  const tickers = await allowed(env);
  await env.DB!.prepare(`INSERT INTO company_transcripts(id,ticker,period_end,accession,form,filing_url,filed_at,raw_key,next_attempt_at,updated_at)
    SELECT ticker||'-'||period_end,ticker,period_end,accession,form,filing_url,filed_at,raw_key,?,? FROM (
      SELECT json_extract(payload,'$.ticker') ticker,json_extract(payload,'$.source.reportDate') period_end,
      json_extract(payload,'$.source.accessionNumber') accession,json_extract(payload,'$.source.form') form,json_extract(payload,'$.source.documentUrl') filing_url,
      json_extract(payload,'$.source.filedAt') filed_at,json_extract(payload,'$.rawKey') raw_key,
      ROW_NUMBER() OVER(PARTITION BY json_extract(payload,'$.ticker'),json_extract(payload,'$.source.reportDate')
        ORDER BY json_extract(payload,'$.source.filedAt') DESC) position
      FROM sec_cache WHERE cache_key LIKE 'sec:disclosure-audit:v1:%'
        AND json_extract(payload,'$.source.form') IN ('10-Q','10-K','10-Q/A','10-K/A')
        AND json_extract(payload,'$.ticker') IN (SELECT value FROM json_each(?))
    ) WHERE position=1 AND period_end IS NOT NULL AND raw_key IS NOT NULL
    ON CONFLICT(ticker,period_end) DO NOTHING`).bind(now.toISOString(),now.toISOString(),JSON.stringify(tickers)).run();
}

export async function syncTranscript(env: SecPipelineEnv, now = new Date(), fetcher: typeof fetch = fetch) {
  if (env.TRANSCRIPTS_ENABLED !== 'true' || !env.DB || !env.ALPHA_VANTAGE_API_KEY) return { status: 'disabled' };
  await seedTranscripts(env, now);
  const tickers = await allowed(env), stamp = now.toISOString();
  const budget = new GuidanceStore(env.DB,env.SEC_FILINGS);
  const cap = Number(env.GUIDANCE_DAILY_TRANSCRIPT_CALLS) > 0 ? Number(env.GUIDANCE_DAILY_TRANSCRIPT_CALLS) : 25;
  const spent = await env.DB.prepare("SELECT units FROM feature_budget WHERE day=? AND feature='guidance-transcript'").bind(stamp.slice(0,10)).first<{units:number}>();
  if ((spent?.units ?? 0) >= cap) return { status: 'daily_budget' };
  const lease = new Date(now.getTime()+120_000).toISOString();
  const row = await env.DB.prepare(`UPDATE company_transcripts SET status='fetching',lease_until=?,updated_at=? WHERE id=(
    SELECT id FROM company_transcripts WHERE ticker IN (SELECT value FROM json_each(?)) AND
      ((status IN ('queued','retry') AND next_attempt_at<=?) OR (status='fetching' AND lease_until<=?))
    ORDER BY period_end DESC,ticker LIMIT 1) RETURNING *,${columns}`)
    .bind(lease,stamp,JSON.stringify(tickers),stamp,stamp).first<TranscriptItem & {raw_key:string;form:string;attempts:number}>();
  if (!row) return { status: 'idle' };
  const finish = async (status: string, code: string | null, next=stamp) => {
    await env.DB!.prepare('UPDATE company_transcripts SET status=?,error_code=?,next_attempt_at=?,lease_until=NULL,updated_at=? WHERE id=? AND lease_until=?')
      .bind(status,code,next,stamp,row.id,lease).run();
    return { status, ticker: row.ticker, period: row.periodEnd };
  };
  const tomorrow = new Date(now); tomorrow.setUTCHours(24,10,0,0);
  try {
    const object = await env.SEC_FILINGS.get(row.raw_key);
    if (!object) return await finish('retry','SOURCE_MISSING',tomorrow.toISOString());
    const period = parseFiscalPeriod(await object.text(), {form: row.form, reportDate:row.periodEnd,accessionNumber:row.accession,documentUrl:row.filingUrl});
    // DEI annual focus maps to the fourth-quarter call. Never guess from calendar months.
    const q = period?.fiscalPeriod==='FY'?4:Number(period?.fiscalPeriod.slice(1));
    if (!period || ![1,2,3,4].includes(q)) return await finish('needs_period','FISCAL_PERIOD_UNKNOWN');
    await env.DB.prepare('UPDATE company_transcripts SET fiscal_year=?,fiscal_quarter=? WHERE id=? AND lease_until=?')
      .bind(period.fiscalYear,q,row.id,lease).run();
    if (!await budget.reserve('guidance-transcript',stamp.slice(0,10),cap)) return await finish('retry','DAILY_BUDGET',tomorrow.toISOString());
    await env.DB.prepare('UPDATE company_transcripts SET attempts=attempts+1 WHERE id=? AND lease_until=?').bind(row.id,lease).run();
    const material = await new AlphaVantageTranscriptProvider(env.ALPHA_VANTAGE_API_KEY,fetcher).fetch(row.ticker,{fiscalYear:period.fiscalYear,quarter:q as 1|2|3|4,date:row.filedAt});
    if (!material || !('text' in material)) return await finish('unavailable','PROVIDER_NO_TRANSCRIPT');
    await env.DB.prepare(`UPDATE company_transcripts SET status='ready',title=?,source_url=?,content=?,characters=?,error_code=NULL,fetched_at=?,updated_at=?,lease_until=NULL WHERE id=? AND lease_until=?`)
      .bind(material.title,material.url,material.text,material.text.length,stamp,stamp,row.id,lease).run();
    return {status:'ready',ticker:row.ticker,period:row.periodEnd,characters:material.text.length};
  } catch(error) {
    if(error instanceof TranscriptQuotaError) {
      // Stop the whole library for today, including when another client used this API key.
      await env.DB.prepare("INSERT INTO feature_budget(day,feature,units) VALUES(?,'guidance-transcript',?) ON CONFLICT(day,feature) DO UPDATE SET units=MAX(units,excluded.units)").bind(stamp.slice(0,10),cap).run();
      return finish('retry','PROVIDER_QUOTA',tomorrow.toISOString());
    }
    if(error instanceof TranscriptAccessError) return finish('unavailable','PROVIDER_ACCESS');
    return finish(row.attempts>=2?'unavailable':'retry','PROVIDER_ERROR',tomorrow.toISOString());
  }
}

export async function listTranscripts(env:SecPipelineEnv,url:URL):Promise<TranscriptList> {
  const ticker=(url.searchParams.get('ticker')??'').toUpperCase(),offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
  const where=ticker?'WHERE ticker=?':'',args=ticker?[ticker]:[];
  const rows=await env.DB!.prepare(`SELECT ${columns} FROM company_transcripts ${where} ORDER BY period_end DESC,ticker LIMIT 100 OFFSET ?`).bind(...args,offset).all<TranscriptItem>();
  const count=await env.DB!.prepare(`SELECT count(*) n FROM company_transcripts ${where}`).bind(...args).first<{n:number}>();
  const companies=await env.DB!.prepare('SELECT DISTINCT ticker FROM company_transcripts ORDER BY ticker').bind().all<{ticker:string}>();
  return {transcripts:rows.results,companies:companies.results.map(r=>r.ticker),total:count?.n??0,offset,enabled:env.TRANSCRIPTS_ENABLED==='true'};
}
export async function transcriptDetail(env:SecPipelineEnv,id:string):Promise<TranscriptDetail|null> {
  return env.DB!.prepare(`SELECT ${columns},content FROM company_transcripts WHERE id=?`).bind(id).first<TranscriptDetail>();
}
