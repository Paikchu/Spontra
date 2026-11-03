import type {Job} from './store.ts';
/** Explicit opt-in. No model key or Workflow binding belongs to this subsystem. */
export interface DataOnlyEnv {DB:D1Database;SEC_USER_AGENT:string;SEC_DATA_TICKERS?:string;SEC_DATA_COLLECTION_ENABLED?:string;}

const ACTIVE="('queued','retry','running')";

/**
 * Starts a collection for a company with a new filing. Unlike the old daily refresh there is no cooldown: a filing is
 * reason enough. Nothing starts while a collection for the issuer is active or an admin maintenance task owns it.
 */
export async function startCollection(db:D1Database,ticker:string,cik:string,now=new Date()):Promise<boolean>{
 if(!/^\d{10}$/.test(cik))throw new Error('Invalid CIK');
 const previous=await db.prepare('SELECT MAX(generation) generation FROM financial_collection_jobs WHERE cik=?').bind(cik).first<{generation:number|null}>();
 const generation=Math.max(now.getTime(),(previous?.generation??0)+1),stamp=now.toISOString();
 const created=await db.prepare(`INSERT INTO financial_collection_jobs(job_id,cik,ticker,generation,status,next_attempt_at,updated_at)
  SELECT ?,?,?,?,'queued',?,? WHERE NOT EXISTS(SELECT 1 FROM financial_collection_jobs WHERE cik=? AND status IN ${ACTIVE})
  AND NOT EXISTS(SELECT 1 FROM financial_maintenance_tasks WHERE (ticker=? OR cik=?) AND status IN ('queued','running','cancel_requested')
   AND stage NOT IN ('analysis_dispatch','analysis_wait') AND NOT (stage='waiting_issuer' AND status='queued'))
  ON CONFLICT DO NOTHING RETURNING job_id`).bind(`${cik}:${generation}`,cik,ticker,generation,stamp,stamp,cik,ticker,cik).first<{job_id:string}>();
 return Boolean(created);
}

/** Leases this company's runnable collection job, if any. Admin-owned jobs belong to their maintenance task. */
export async function claimJobFor(db:D1Database,ticker:string,now=new Date()):Promise<Job|null>{
 const stamp=now.toISOString();
 await db.prepare(`UPDATE financial_collection_jobs SET status='unavailable',reasons_json='["SOURCE_TEMPORARILY_UNAVAILABLE"]',lease_token=NULL,lease_until=NULL,updated_at=? WHERE ticker=? AND job_id NOT LIKE 'admin:%' AND status='running' AND lease_until<=? AND attempt>=3`).bind(stamp,ticker,stamp).run();
 // Longer than one batch can take at SEC's pace (the tasks consumer allows 15 minutes): a lease that ran out mid-batch
 // would turn the batch's writes into no-ops.
 const lease=crypto.randomUUID(),until=new Date(now.getTime()+14*60000).toISOString();
 const row=await db.prepare(`UPDATE financial_collection_jobs SET status='running',lease_token=?,lease_until=?,attempt=attempt+1,updated_at=? WHERE job_id=(SELECT job_id FROM financial_collection_jobs WHERE ticker=? AND job_id NOT LIKE 'admin:%' AND ((status IN ('queued','retry') AND next_attempt_at<=?) OR (status='running' AND lease_until<=?)) AND attempt<4 ORDER BY generation DESC LIMIT 1) RETURNING job_id,cik,ticker,generation,cursor_json,attempt`)
  .bind(lease,until,stamp,ticker,stamp,stamp).first<{job_id:string;cik:string;ticker:string;generation:number;cursor_json:string;attempt:number}>();
 return row?{id:row.job_id,cik:row.cik,ticker:row.ticker,generation:row.generation,cursor:row.cursor_json,lease,attempt:row.attempt}:null;
}

/** The company's newest collection job: when it may run next, or how it ended. */
export async function latestJob(db:D1Database,ticker:string){
 return db.prepare(`SELECT job_id,cik,status,reasons_json,next_attempt_at,lease_until,updated_at FROM financial_collection_jobs WHERE ticker=? AND job_id NOT LIKE 'admin:%' ORDER BY generation DESC LIMIT 1`)
  .bind(ticker).first<{job_id:string;cik:string;status:string;reasons_json:string|null;next_attempt_at:string;lease_until:string|null;updated_at:string}>();
}
