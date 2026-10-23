import {publicFlowSchema} from '../../../../shared/analysis-runtime/financial-data/schema.ts';
import type { PublicBusinessFlow, BusinessFlowQuarter } from '../../../../shared/analysis-contract/business-flow.ts';
import { checkCompleteFlow } from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import { outboxStatement } from '../pipeline/outbox.ts';
export interface Job {id:string;cik:string;ticker:string;generation:number;lease:string;cursor:string;attempt:number;}
export interface CompleteStore {stage(job:Job,quarter:BusinessFlowQuarter):Promise<void>;staged(job:Job):Promise<BusinessFlowQuarter[]>;publish(job:Job,flow:PublicBusinessFlow):Promise<boolean>;defer(job:Job,reasons:string[],cursor:string):Promise<void>;
 /** Ends a job that found nothing new to publish, as succeeded, with why. */
 finish?(job:Job,reasons:string[]):Promise<void>;}
export class D1CompleteStore implements CompleteStore{
 private db:D1Database;private causeId:string|null;private announceDegraded:boolean;
 /** `announceDegraded`: a published newest quarter whose after-tax lines no structure balanced asks for a judgement
  * (`presentation.unresolved`) in the same transaction. Only the collect task asks; a maintenance collection never
  * does, which keeps the event graph free of loops (presentation-task.ts). */
 constructor(db:D1Database,causeId:string|null=null,options:{announceDegraded?:boolean}={}){this.db=db;this.causeId=causeId;this.announceDegraded=options.announceDegraded??false;}
 async stage(job:Job,quarter:BusinessFlowQuarter){await this.db.prepare(`INSERT INTO financial_staged_quarters(job_id,period_end,payload_json) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM financial_collection_jobs WHERE job_id=? AND lease_token=? AND status='running' AND lease_until>?) ON CONFLICT(job_id,period_end) DO UPDATE SET payload_json=excluded.payload_json WHERE json_extract(excluded.payload_json,'$.reportedAt')>=json_extract(financial_staged_quarters.payload_json,'$.reportedAt')`).bind(job.id,quarter.periodEnd,JSON.stringify(quarter),job.id,job.lease,new Date().toISOString()).run();}
 async staged(job:Job){const rows=await this.db.prepare('SELECT payload_json FROM financial_staged_quarters WHERE job_id=? ORDER BY period_end DESC').bind(job.id).all<{payload_json:string}>();return rows.results.map(row=>JSON.parse(row.payload_json) as BusinessFlowQuarter);}
 async publish(job:Job,flow:PublicBusinessFlow){flow=publicFlowSchema.parse(flow);if(flow.ticker!==job.ticker||!checkCompleteFlow(flow).complete)throw new Error('Incomplete snapshot cannot be published');const version=job.id,now=new Date().toISOString();
  const results=await this.db.batch([
   this.db.prepare(`INSERT INTO financial_complete_versions(version_id,cik,ticker,generation,payload_json,published_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM financial_collection_jobs WHERE job_id=? AND lease_token=? AND status='running' AND lease_until>?) ON CONFLICT(version_id) DO NOTHING`).bind(version,job.cik,job.ticker,job.generation,JSON.stringify(flow),now,job.id,job.lease,now),
   this.db.prepare(`INSERT INTO financial_complete_current(cik,version_id,generation) SELECT cik,version_id,generation FROM financial_complete_versions WHERE version_id=? AND EXISTS(SELECT 1 FROM financial_collection_jobs WHERE job_id=? AND lease_token=? AND status='running' AND lease_until>?) ON CONFLICT(cik) DO UPDATE SET version_id=excluded.version_id,generation=excluded.generation WHERE excluded.generation>financial_complete_current.generation`).bind(version,job.id,job.lease,now),
   this.db.prepare(`UPDATE financial_collection_jobs SET status='succeeded',reasons_json='[]',cursor_json=?,updated_at=?,lease_token=NULL,lease_until=NULL WHERE job_id=? AND lease_token=? AND EXISTS(SELECT 1 FROM financial_complete_current WHERE cik=? AND version_id=?)`).bind(job.cursor,now,job.id,job.lease,job.cik,version),
   // Announced in the same transaction, and only when this job's publication took effect.
   outboxStatement(this.db,{type:'financials.published',ticker:job.ticker,cik:job.cik,causeId:this.causeId},now,{sql:"EXISTS(SELECT 1 FROM financial_collection_jobs WHERE job_id=? AND status='succeeded' AND updated_at=?)",binds:[job.id,now]}),
   ...(this.announceDegraded&&[...flow.quarters].sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd))[0]?.presentation?.source==='degraded'
    ?[outboxStatement(this.db,{type:'presentation.unresolved',ticker:job.ticker,cik:job.cik,causeId:this.causeId},now,{sql:"EXISTS(SELECT 1 FROM financial_collection_jobs WHERE job_id=? AND status='succeeded' AND updated_at=?)",binds:[job.id,now]})]:[]),
  ]);return (results[2].meta.changes??0)>0;
 }
 async finish(job:Job,reasons:string[]){
  const now=new Date().toISOString();
  await this.db.prepare(`UPDATE financial_collection_jobs SET status='succeeded',cursor_json=?,reasons_json=?,updated_at=?,lease_token=NULL,lease_until=NULL WHERE job_id=? AND lease_token=? AND status='running' AND lease_until>?`)
   .bind(job.cursor,JSON.stringify(reasons),now,job.id,job.lease,now).run();
 }
 async defer(job:Job,reasons:string[],cursor:string){
  const now=new Date(),continuation=reasons.length===1&&reasons[0]==='PREPARING';
  await this.db.prepare(`UPDATE financial_collection_jobs SET status=?,cursor_json=?,reasons_json=?,next_attempt_at=?,updated_at=?,attempt=?,lease_token=NULL,lease_until=NULL WHERE job_id=? AND lease_token=? AND status='running' AND lease_until>?`)
   .bind(continuation?'queued':job.attempt>=3?'unavailable':'retry',cursor,JSON.stringify(reasons),new Date(now.getTime()+(continuation?0:Math.min(86400000,60000*2**job.attempt))).toISOString(),now.toISOString(),continuation?0:job.attempt,job.id,job.lease,now.toISOString()).run();
 }
}
