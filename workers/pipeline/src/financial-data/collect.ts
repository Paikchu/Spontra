import type { PublicBusinessFlow, BusinessFlowQuarter } from '../../../../shared/analysis-contract/business-flow.ts';
import type { FinancialPolicy } from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import { allowData } from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import { checkCompleteFlow, newestPair } from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import type { CompleteStore, Job } from './store.ts';
/** Explicit dependencies prevent model/analysis/memory dispatch from entering this task. */
export interface DocumentBatch {quarters:BusinessFlowQuarter[];nextCursor:string;finished:boolean;expectedPeriodEnd?:string;}
export async function collectComplete(job:Job,policy:FinancialPolicy,store:CompleteStore,readBatch:(job:Job)=>Promise<DocumentBatch>):Promise<{published:boolean;reasons:string[]}>{
 if(!allowData(policy,job.ticker)){await store.defer({...job,attempt:3},['DATA_POLICY_DENIED'],job.cursor);return {published:false,reasons:['DATA_POLICY_DENIED']};}
 try{
  // Stop once the newest filing period and its comparable predecessor are fully verified;
  // older historical documents cannot improve this publication and need not delay it.
  const stagedBefore=await store.staged(job);
  const expectedBefore=(JSON.parse(job.cursor||'{}') as {expectedPeriodEnd?:string}).expectedPeriodEnd;
  const existing:PublicBusinessFlow=newestPair({schemaVersion:'business-flow.v1',ticker:job.ticker,fetchedAt:new Date().toISOString(),quarters:stagedBefore});
  if(expectedBefore&&existing.quarters[0]?.periodEnd===expectedBefore&&checkCompleteFlow(existing).complete)return {published:await store.publish(job,existing),reasons:[]};
  const batch=await readBatch(job);for(const quarter of batch.quarters)await store.stage(job,quarter);
  const flow:PublicBusinessFlow=newestPair({schemaVersion:'business-flow.v1',ticker:job.ticker,fetchedAt:new Date().toISOString(),quarters:await store.staged(job)});
  const check=checkCompleteFlow(flow);
  if(!batch.finished&&!(batch.expectedPeriodEnd&&flow.quarters[0]?.periodEnd===batch.expectedPeriodEnd&&check.complete)){await store.defer(job,['PREPARING'],batch.nextCursor);return {published:false,reasons:['PREPARING']};}
  if(batch.expectedPeriodEnd&&flow.quarters[0]?.periodEnd!==batch.expectedPeriodEnd){await store.defer(job,['LATEST_PERIOD_NOT_COLLECTED'],batch.nextCursor);return {published:false,reasons:['LATEST_PERIOD_NOT_COLLECTED']};}
  if(!check.complete){await store.defer(job,check.reasons,batch.nextCursor);return {published:false,reasons:check.reasons};}
  return {published:await store.publish(job,flow),reasons:[]};
 }catch{await store.defer(job,['SOURCE_TEMPORARILY_UNAVAILABLE'],job.cursor);return {published:false,reasons:['SOURCE_TEMPORARILY_UNAVAILABLE']};}
}
