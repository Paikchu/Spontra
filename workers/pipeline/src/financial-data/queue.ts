import {financialPolicy,allowData, type FinancialPolicy} from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import type {FinancialIssuer} from '../../../../shared/analysis-contract/complete-business-flow.ts';
import {D1CompleteStore,type Job} from './store.ts';
import {collectComplete} from './collect.ts';
import {readSecDocumentBatch,throttledSecReader,discoverDataIssuer} from './provider.ts';
import {runHistoryTick} from './history.ts';
import {archiveFilingDisclosures, type DisclosureArchiveEnv} from './disclosure-audit.ts';
/** Explicit opt-in. No cron registration, model key or Workflow binding belongs to this subsystem. */
export interface DataOnlyEnv {DB:D1Database;SEC_USER_AGENT:string;SEC_DATA_TICKERS?:string;SEC_TRACKED_TICKERS?:string;SEC_DATA_COLLECTION_ENABLED?:string;SEC_FILINGS?:DisclosureArchiveEnv['SEC_FILINGS'];}
export async function enqueueIssuer(db:D1Database,issuer:FinancialIssuer,policy:FinancialPolicy,generation:number):Promise<string|null>{
 const ticker=issuer.tickers.find(t=>allowData(policy,t));if(!ticker)return null;if(!Number.isSafeInteger(generation)||generation<1)throw new Error('Invalid generation');const id=`${issuer.cik}:${generation}`,now=new Date().toISOString();
 const created=await db.prepare(`INSERT INTO financial_collection_jobs(job_id,cik,ticker,generation,status,next_attempt_at,updated_at)
  SELECT ?,?,?,?,'queued',?,? WHERE NOT EXISTS(SELECT 1 FROM financial_collection_jobs WHERE cik=? AND (status IN ('queued','retry','running') OR updated_at>?))
  ON CONFLICT(cik,generation) DO NOTHING RETURNING job_id`).bind(id,issuer.cik,ticker,generation,now,now,issuer.cik,new Date(generation-86400000).toISOString()).first<{job_id:string}>();
 return created?.job_id??(await db.prepare('SELECT job_id FROM financial_collection_jobs WHERE cik=? ORDER BY generation DESC LIMIT 1').bind(issuer.cik).first<{job_id:string}>())?.job_id??null;
}
export async function claimJob(db:D1Database,now=new Date()):Promise<Job|null>{
 await db.prepare(`UPDATE financial_collection_jobs SET status='unavailable',reasons_json='["SOURCE_TEMPORARILY_UNAVAILABLE"]',lease_token=NULL,lease_until=NULL,updated_at=? WHERE job_id NOT LIKE 'admin:%' AND status='running' AND lease_until<=? AND attempt>=3`).bind(now.toISOString(),now.toISOString()).run();
 const lease=crypto.randomUUID(),until=new Date(now.getTime()+300000).toISOString();const row=await db.prepare(`UPDATE financial_collection_jobs SET status='running',lease_token=?,lease_until=?,attempt=attempt+1,updated_at=? WHERE job_id=(SELECT job_id FROM financial_collection_jobs WHERE job_id NOT LIKE 'admin:%' AND ((status IN ('queued','retry') AND next_attempt_at<=?) OR (status='running' AND lease_until<=?)) AND attempt<4 ORDER BY next_attempt_at,job_id LIMIT 1) RETURNING job_id,cik,ticker,generation,cursor_json,attempt`).bind(lease,until,now.toISOString(),now.toISOString(),now.toISOString()).first<{job_id:string;cik:string;ticker:string;generation:number;cursor_json:string;attempt:number}>();
 return row?{id:row.job_id,cik:row.cik,ticker:row.ticker,generation:row.generation,cursor:row.cursor_json,lease,attempt:row.attempt}:null;
}
type HistorySummary=Awaited<ReturnType<typeof runHistoryTick>>;
export async function runDataOnlySweep(env:DataOnlyEnv,fetcher:typeof fetch=fetch):Promise<{enabled:boolean;published:boolean;reasons:string[];ticker?:string;modelCalls:0;history?:HistorySummary|{error:string}}>{
 if(env.SEC_DATA_COLLECTION_ENABLED!=='true')return {enabled:false,published:false,reasons:[],modelCalls:0};
 const policy=financialPolicy({SEC_DATA_TICKERS:env.SEC_DATA_TICKERS,SEC_TRACKED_TICKERS:env.SEC_TRACKED_TICKERS,SEC_AI_ENABLED:'false'});
 const reader=throttledSecReader(env.SEC_USER_AGENT,fetcher,1000);let job=await claimJob(env.DB);
 if(!job){
  // At most one issuer enqueue per tick, and at most one refresh per issuer per day.
  const recent=await env.DB.prepare('SELECT ticker,MAX(updated_at) updated_at FROM financial_collection_jobs GROUP BY ticker').bind().all<{ticker:string;updated_at:string}>();
  const updated=new Map(recent.results.map(r=>[r.ticker,Date.parse(r.updated_at)]));
  const failures=await env.DB.prepare("SELECT cache_key,fetched_at FROM sec_cache WHERE cache_key LIKE 'sec:financial-discovery-failure:v1:%'").bind().all<{cache_key:string;fetched_at:string}>();
  const failedAt=new Map(failures.results.map(r=>[r.cache_key.slice('sec:financial-discovery-failure:v1:'.length),Date.parse(r.fetched_at)]));
  const ticker=[...policy.dataTickers].find(t=>(!updated.has(t)||Date.now()-updated.get(t)!>=86400000)&&(!failedAt.has(t)||Date.now()-failedAt.get(t)!>=3600000));
  if(!ticker){
   // Idle tick: the complete snapshot has nothing due, so quarterly revenue history may advance one bounded step.
   try{const history=await runHistoryTick(env.DB,reader,policy,new Date(),env.SEC_FILINGS ? (ticker,source,html,metadata)=>archiveFilingDisclosures({DB:env.DB,SEC_FILINGS:env.SEC_FILINGS!},ticker,source,html,metadata).then(()=>{}) : undefined);return {enabled:true,published:false,reasons:[],modelCalls:0,...(history?{history}:{})};}
   catch{return {enabled:true,published:false,reasons:[],modelCalls:0,history:{error:'SOURCE_TEMPORARILY_UNAVAILABLE'}};}
  }
  try{const issuer=await discoverDataIssuer(ticker,reader);await enqueueIssuer(env.DB,issuer,policy,Date.now());job=await claimJob(env.DB);}catch{
   // Back off directory failures so one invalid or unavailable issuer cannot starve the list.
   await env.DB.prepare('INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at').bind(`sec:financial-discovery-failure:v1:${ticker}`,JSON.stringify({reason:'SOURCE_TEMPORARILY_UNAVAILABLE'}),new Date().toISOString()).run();
   return {enabled:true,published:false,reasons:['SOURCE_TEMPORARILY_UNAVAILABLE'],ticker,modelCalls:0};
  }
 }
 if(!job)return {enabled:true,published:false,reasons:[],modelCalls:0};
 if(env.SEC_FILINGS)reader.archive=(source,html,metadata)=>archiveFilingDisclosures({DB:env.DB,SEC_FILINGS:env.SEC_FILINGS!},job!.ticker,source,html,metadata).then(()=>{});
 const result=await collectComplete(job,policy,new D1CompleteStore(env.DB),job=>readSecDocumentBatch(job,reader));return {enabled:true,...result,ticker:job.ticker,modelCalls:0};
}
