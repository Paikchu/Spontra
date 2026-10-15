import type { PublicBusinessFlow, BusinessFlowQuarter } from '../../../../shared/analysis-contract/business-flow.ts';
import type { FinancialPolicy } from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import { allowData } from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import { checkCompleteFlow, newestPair } from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import type { CompleteStore, Job } from './store.ts';
import { markBasisChanges, type Restated } from './restatement.ts';
/** Explicit dependencies prevent model/analysis/memory dispatch from entering this task. */
export interface DocumentBatch {quarters:BusinessFlowQuarter[];nextCursor:string;finished:boolean;expectedPeriodEnd?:string;}
export async function collectComplete(job:Job,policy:FinancialPolicy,store:CompleteStore,readBatch:(job:Job)=>Promise<DocumentBatch>):Promise<{published:boolean;reasons:string[];flow?:PublicBusinessFlow}>{
 if(!allowData(policy,job.ticker)){await store.defer({...job,attempt:3},['DATA_POLICY_DENIED'],job.cursor);return {published:false,reasons:['DATA_POLICY_DENIED']};}
 try{
  // Stop once the newest filing period and its comparable predecessor are fully verified;
  // older historical documents cannot improve this publication and need not delay it.
  const stagedBefore=await store.staged(job);
  const expectedBefore=(JSON.parse(job.cursor||'{}') as {expectedPeriodEnd?:string}).expectedPeriodEnd;
  // Lines a later filing restated are marked uncompared (restatement.ts); the rest of the pair still compares.
  const restated=(cursor:string)=>{try{return (JSON.parse(cursor||'{}') as {restated?:Restated[]}).restated;}catch{return undefined;}};
  const existing:PublicBusinessFlow=markBasisChanges(newestPair({schemaVersion:'business-flow.v1',ticker:job.ticker,fetchedAt:new Date().toISOString(),quarters:stagedBefore}),restated(job.cursor));
  if(expectedBefore&&existing.quarters[0]?.periodEnd===expectedBefore&&checkCompleteFlow(existing).complete)return {published:await store.publish(job,existing),reasons:[],flow:existing};
  const batch=await readBatch(job);for(const quarter of batch.quarters)await store.stage(job,quarter);
  const flow:PublicBusinessFlow=markBasisChanges(newestPair({schemaVersion:'business-flow.v1',ticker:job.ticker,fetchedAt:new Date().toISOString(),quarters:await store.staged(job)}),restated(batch.nextCursor));
  const check=checkCompleteFlow(flow);
  if(!batch.finished&&!(batch.expectedPeriodEnd&&flow.quarters[0]?.periodEnd===batch.expectedPeriodEnd&&check.complete)){await store.defer(job,['PREPARING'],batch.nextCursor);return {published:false,reasons:['PREPARING']};}
  if(batch.expectedPeriodEnd&&flow.quarters[0]?.periodEnd!==batch.expectedPeriodEnd){await store.defer(job,['LATEST_PERIOD_NOT_COLLECTED'],batch.nextCursor);return {published:false,reasons:['LATEST_PERIOD_NOT_COLLECTED']};}
  if(!check.complete){await store.defer(job,check.reasons,batch.nextCursor);return {published:false,reasons:check.reasons};}
  return {published:await store.publish({...job,cursor:batch.nextCursor},flow),reasons:[],flow};
 }catch(error){const code=error instanceof Error?error.message:'';const terminal=['RESTATEMENT_REVIEW_REQUIRED','SEC_FACT_FORMAT_UNSUPPORTED','NO_SUPPORTED_FILINGS'].includes(code);const reasons=[terminal||code==='SEC_ACCESS_PAUSED'?code:'SOURCE_TEMPORARILY_UNAVAILABLE'];await store.defer(terminal?{...job,attempt:3}:job,reasons,job.cursor);return {published:false,reasons};}
}
