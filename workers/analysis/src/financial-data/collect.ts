import type { PublicBusinessFlow, BusinessFlowQuarter } from '../../../../shared/analysis-contract/business-flow.ts';
import { allowData } from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import { checkCompleteFlow, newestPair } from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import type { CompleteStore, Job } from './store.ts';
import { markBasisChanges, type Restated } from './restatement.ts';
/** Explicit dependencies prevent model/analysis/memory dispatch from entering this task. */
export interface DocumentBatch {quarters:BusinessFlowQuarter[];nextCursor:string;finished:boolean;expectedPeriodEnd?:string;}
/** The quarter an earnings release reports after the verified pair's newest quarter, when there is one. */
export type ReadRelease=(job:Job,previous:BusinessFlowQuarter)=>Promise<{quarter:BusinessFlowQuarter|null;issues:string[]}>;
/**
 * An issuer that already publishes takes only its new filings, oldest first, each read once by its read note
 * (read-note.ts); published quarters are never read again. A quarter a filing reports follows the newest published one,
 * or replaces it when the newest came from an earnings release and the filing is its quarterly report. Nothing new ends
 * the job without a publication. `read` throws when the filing or the model cannot be reached; the job then retries.
 */
export async function collectNewFilings<F extends {accession:string}>(job:Job,current:PublicBusinessFlow,store:CompleteStore,filings:F[],readFiling:(filing:F,published:BusinessFlowQuarter[])=>Promise<{quarter:BusinessFlowQuarter|null;replaces:boolean;issues:string[];budget?:true}>):Promise<{published:boolean;reasons:string[];read:Array<{accession:string;periodEnd:string|null;issues:string[]}>}>{
 let flow=newestPair(current);const read:Array<{accession:string;periodEnd:string|null;issues:string[]}>=[];
 try{
  for(const filing of filings){
   const outcome=await readFiling(filing,flow.quarters);
   if(outcome.budget){await store.defer(job,['MODEL_BUDGET_SPENT'],job.cursor);return {published:false,reasons:['MODEL_BUDGET_SPENT'],read};}
   read.push({accession:filing.accession,periodEnd:outcome.quarter?.periodEnd??null,issues:outcome.issues.slice(0,5)});
   if(!outcome.quarter)continue;
   const pair:PublicBusinessFlow={...flow,fetchedAt:new Date().toISOString(),quarters:[outcome.quarter,outcome.replaces?flow.quarters[1]!:flow.quarters[0]!]};
   if(checkCompleteFlow(pair).complete)flow=pair;
  }
 }catch{await store.defer(job,['SOURCE_TEMPORARILY_UNAVAILABLE'],job.cursor);return {published:false,reasons:['SOURCE_TEMPORARILY_UNAVAILABLE'],read};}
 if(flow.quarters[0]?.periodEnd===newestPair(current).quarters[0]?.periodEnd&&flow.quarters[0]?.sources[0]?.id===newestPair(current).quarters[0]?.sources[0]?.id){
  const reasons=read.some(r=>r.issues.length)?['NEW_FILING_UNRESOLVED']:['UP_TO_DATE'];
  if(store.finish)await store.finish(job,reasons);else await store.defer({...job,attempt:3},reasons,job.cursor);
  return {published:false,reasons,read};
 }
 const published=await store.publish(job,flow);
 if(!published)await store.defer({...job,attempt:3},['NEWER_PUBLICATION_CURRENT'],job.cursor);
 return {published,reasons:published?[]:['NEWER_PUBLICATION_CURRENT'],read};
}
export async function collectComplete(job:Job,dataTickers:ReadonlySet<string>,store:CompleteStore,readBatch:(job:Job)=>Promise<DocumentBatch>,readRelease?:ReadRelease):Promise<{published:boolean;reasons:string[];flow?:PublicBusinessFlow;release?:{periodEnd:string|null;issues:string[]}}>{
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
 if(!allowData(dataTickers,job.ticker)){await store.defer({...job,attempt:3},['DATA_POLICY_DENIED'],job.cursor);return {published:false,reasons:['DATA_POLICY_DENIED']};}
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
