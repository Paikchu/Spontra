import type { PublicBusinessFlow, BusinessFlowQuarter } from '../../../../shared/analysis-contract/business-flow.ts';
import type { FinancialPolicy } from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import { allowData } from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import { checkCompleteFlow, newestPair } from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import type { CompleteStore, Job } from './store.ts';
import { markBasisChanges, type Restated } from './restatement.ts';
/** Explicit dependencies prevent model/analysis/memory dispatch from entering this task. */
export interface DocumentBatch {quarters:BusinessFlowQuarter[];nextCursor:string;finished:boolean;expectedPeriodEnd?:string;}
/** The quarter an earnings release reports after the verified pair's newest quarter, when there is one. */
export type ReadRelease=(job:Job,previous:BusinessFlowQuarter)=>Promise<{quarter:BusinessFlowQuarter|null;issues:string[]}>;
export async function collectComplete(job:Job,policy:FinancialPolicy,store:CompleteStore,readBatch:(job:Job)=>Promise<DocumentBatch>,readRelease?:ReadRelease):Promise<{published:boolean;reasons:string[];flow?:PublicBusinessFlow;release?:{periodEnd:string|null;issues:string[]}}>{
 // The verified pair publishes as it is unless a newer earnings release passes the same gate on top of its newest quarter;
 // a release that cannot be read leaves the verified pair, and the 10-Q brings the quarter later.
 const publish=async(at:Job,flow:PublicBusinessFlow)=>{
  if(readRelease&&flow.quarters[0]){
   try{const read=await readRelease(at,flow.quarters[0]);
    const pair:PublicBusinessFlow={...flow,quarters:read.quarter?[read.quarter,flow.quarters[0]]:flow.quarters};
    if(read.quarter&&checkCompleteFlow(pair).complete)return {published:await store.publish(at,pair),reasons:[],flow:pair,release:{periodEnd:read.quarter.periodEnd,issues:read.issues}};
    if(read.issues.length)console.log(JSON.stringify({event:'earnings-release-not-used',ticker:at.ticker,issues:read.issues.slice(0,8)}));
   }catch(error){console.log(JSON.stringify({event:'earnings-release-unreadable',ticker:at.ticker,error:error instanceof Error?error.message.slice(0,200):'unknown'}));}
  }
  // A job whose publication did not become current (an admin collection published a newer generation meanwhile) ends
  // here instead of staying running: it would otherwise hold the issuer and block every later collection.
  const published=await store.publish(at,flow);
  if(!published)await store.defer({...at,attempt:3},['NEWER_PUBLICATION_CURRENT'],at.cursor);
  return {published,reasons:published?[]:['NEWER_PUBLICATION_CURRENT'],flow};
 };
 if(!allowData(policy,job.ticker)){await store.defer({...job,attempt:3},['DATA_POLICY_DENIED'],job.cursor);return {published:false,reasons:['DATA_POLICY_DENIED']};}
 try{
  // Stop once the newest filing period and its comparable predecessor are fully verified;
  // older historical documents cannot improve this publication and need not delay it.
  const stagedBefore=await store.staged(job);
  const expectedBefore=(JSON.parse(job.cursor||'{}') as {expectedPeriodEnd?:string}).expectedPeriodEnd;
  // Lines a later filing restated are marked uncompared (restatement.ts); the rest of the pair still compares.
  const restated=(cursor:string)=>{try{return (JSON.parse(cursor||'{}') as {restated?:Restated[]}).restated;}catch{return undefined;}};
  const existing:PublicBusinessFlow=markBasisChanges(newestPair({schemaVersion:'business-flow.v1',ticker:job.ticker,fetchedAt:new Date().toISOString(),quarters:stagedBefore}),restated(job.cursor));
  if(expectedBefore&&existing.quarters[0]?.periodEnd===expectedBefore&&checkCompleteFlow(existing).complete)return await publish(job,existing);
  const batch=await readBatch(job);for(const quarter of batch.quarters)await store.stage(job,quarter);
  const flow:PublicBusinessFlow=markBasisChanges(newestPair({schemaVersion:'business-flow.v1',ticker:job.ticker,fetchedAt:new Date().toISOString(),quarters:await store.staged(job)}),restated(batch.nextCursor));
  const check=checkCompleteFlow(flow);
  if(!batch.finished&&!(batch.expectedPeriodEnd&&flow.quarters[0]?.periodEnd===batch.expectedPeriodEnd&&check.complete)){await store.defer(job,['PREPARING'],batch.nextCursor);return {published:false,reasons:['PREPARING']};}
  if(batch.expectedPeriodEnd&&flow.quarters[0]?.periodEnd!==batch.expectedPeriodEnd){await store.defer(job,['LATEST_PERIOD_NOT_COLLECTED'],batch.nextCursor);return {published:false,reasons:['LATEST_PERIOD_NOT_COLLECTED']};}
  if(!check.complete){await store.defer(job,check.reasons,batch.nextCursor);return {published:false,reasons:check.reasons};}
  return await publish({...job,cursor:batch.nextCursor},flow);
 }catch(error){const code=error instanceof Error?error.message:'';const terminal=['RESTATEMENT_REVIEW_REQUIRED','SEC_FACT_FORMAT_UNSUPPORTED','NO_SUPPORTED_FILINGS','SEC_DOCUMENT_TOO_LARGE'].includes(code);const reasons=[terminal||code==='SEC_ACCESS_PAUSED'?code:'SOURCE_TEMPORARILY_UNAVAILABLE'];await store.defer(terminal?{...job,attempt:3}:job,reasons,job.cursor);return {published:false,reasons};}
}
