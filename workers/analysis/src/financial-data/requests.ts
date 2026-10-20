import {companyPolicyEnvironment} from './company-policy.ts';
import {financialPolicy, allowData} from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import {discoverDataIssuer, throttledSecReader} from './provider.ts';
import type {DataOnlyEnv} from './queue.ts';

type CollectionRow = {job_id:string;status:string;generation:number;updated_at:string};
export type CollectionRequest = {ticker:string;status:'queued'|'pending'|'fresh'|'maintenance';jobId:string|null};
const active = (row:CollectionRow) => ['queued','retry','running'].includes(row.status);

/** Compatibility producers only enqueue. The two-minute consumer owns parsing, archives and publication. */
export async function requestFinancialCollection(env:DataOnlyEnv,ticker:string,options:{maxAgeMs?:number;now?:Date;fetcher?:typeof fetch}={}):Promise<CollectionRequest>{
 env=await companyPolicyEnvironment(env);
 const policy=financialPolicy({SEC_DATA_TICKERS:env.SEC_DATA_TICKERS,SEC_TRACKED_TICKERS:env.SEC_TRACKED_TICKERS,SEC_AI_ENABLED:'false'});
 if(!allowData(policy,ticker))throw new Error('DATA_POLICY_DENIED');
 const now=options.now??new Date(),cutoff=new Date(now.getTime()-(options.maxAgeMs??0)).toISOString();
 const result=(status:CollectionRequest['status'],jobId:string|null=null):CollectionRequest=>({ticker,status,jobId});
 const recent=await env.DB.prepare('SELECT job_id,status,generation,updated_at FROM financial_collection_jobs WHERE ticker=? ORDER BY generation DESC LIMIT 1').bind(ticker).first<CollectionRow>();
 if(recent&&active(recent))return result('pending',recent.job_id);
 if(recent&&recent.updated_at>cutoff)return result('fresh',recent.job_id);
 const waiting=await env.DB.prepare("SELECT task_id FROM financial_maintenance_tasks WHERE ticker=? AND status IN ('queued','running','cancel_requested') LIMIT 1").bind(ticker).first();
 if(waiting)return result('maintenance');
 const issuer=await discoverDataIssuer(ticker,throttledSecReader(env.SEC_USER_AGENT,options.fetcher??fetch));
 const previous=await env.DB.prepare('SELECT MAX(generation) generation FROM financial_collection_jobs WHERE cik=?').bind(issuer.cik).first<{generation:number|null}>();
 const generation=Math.max(now.getTime(),(previous?.generation??0)+1),id=`${issuer.cik}:${generation}`;
 // Atomic insertion deduplicates concurrent cron/manual producers and different share classes.
 const created=await env.DB.prepare(`INSERT INTO financial_collection_jobs(job_id,cik,ticker,generation,status,next_attempt_at,updated_at)
  SELECT ?,?,?,?,'queued',?,? WHERE NOT EXISTS(
   SELECT 1 FROM financial_collection_jobs WHERE cik=? AND (status IN ('queued','retry','running') OR updated_at>?))
  AND NOT EXISTS(SELECT 1 FROM financial_maintenance_tasks WHERE (ticker=? OR cik=?) AND status IN ('queued','running','cancel_requested'))
  ON CONFLICT DO NOTHING RETURNING job_id`).bind(id,issuer.cik,ticker,generation,now.toISOString(),now.toISOString(),issuer.cik,cutoff,ticker,issuer.cik).first<{job_id:string}>();
 if(created)return result('queued',created.job_id);
 const maintenance=await env.DB.prepare("SELECT task_id FROM financial_maintenance_tasks WHERE (ticker=? OR cik=?) AND status IN ('queued','running','cancel_requested') LIMIT 1").bind(ticker,issuer.cik).first();
 if(maintenance)return result('maintenance');
 const existing=await env.DB.prepare('SELECT job_id,status,generation,updated_at FROM financial_collection_jobs WHERE cik=? ORDER BY generation DESC LIMIT 1').bind(issuer.cik).first<CollectionRow>();
 if(!existing)throw new Error('COLLECTION_REQUEST_NOT_SAVED');
 return result(active(existing)?'pending':'fresh',existing.job_id);
}
