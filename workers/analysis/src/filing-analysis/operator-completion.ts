import type { AnalysisEnv } from "../operations.ts";
import type { RunStep } from "../durable-runs/engine.ts";
import { NonRetryableError } from "../durable-runs/engine.ts";
import { withRuns } from "../durable-runs/binding.ts";
import { packState, unpackState } from "../pi/state.ts";
import { sha256 } from "../sha256.ts";
import { artifactId } from "../artifact/store.ts";
import { modelFor } from "../ai-config.ts";
import { companyExposureMappingStatus } from "../public-research/context.ts";
import { readPublicResearch } from "../public-research/store.ts";
import { publicClaimUsable } from "../../../../shared/analysis-runtime/public-research.ts";
import { endedCheckpoint, shadowKey, type ShadowRun } from "./shadow-resume.ts";
import { filingOperatorPlanSchema, stableOperatorValue } from "./operator-plan.ts";
import { executeFilingOperatorPlan } from "./operator-execution.ts";
import { filingOperatorHarness, type FilingSpec, type FilingState, type FilingReviewerCorrectionReview } from "./recipe.ts";
import { saveFilingImpact } from "./impact-publication.ts";
import { PERIODIC_BLOCKS } from "./periodic.ts";
import type { ComposerPhaseResult } from "../artifact/compose.ts";
import type { ComposerPhaseReceipt, OperatorComposerState } from "../artifact/compose.ts";
import { runTool } from "../tools/registry.ts";
import { z } from "zod";
import { DEEPSEEK_BASE_URL } from "../operations.ts";

export const OPERATOR_REVIEW_REQUESTS=12;
export const OPERATOR_PHASE_LEASE_MS=10*60_000;
export const operatorKey=(runId:string)=>`filing-operator:${runId}`;
const lineageClaim=(runId:string)=>`${shadowKey(runId)}:operator-completion`;
type StateRef={key:string;hash:string};
type Phase={name:string;status:"started"|"done"|"failed"|"unknown";leaseToken:string;expiresAt:number;beforeStateRef:StateRef;afterStateRef?:StateRef;receipt?:unknown;error?:string};
type ReviewerCorrection={sourceOperatorRunId:string;sourceRecordRef:StateRef;failedStateRef:StateRef;correctionsHash:string;changedBlocks:string[]}&FilingReviewerCorrectionReview;
type PreparationRecovery={requestId:string;inputHash:string;previousExecutionId:string;executionId:string;recordRef:StateRef;failureRef:StateRef;stateRef:StateRef;runnerStatus:"errored"|"terminated";createdAt:string};
export type FilingOperatorRun={runId:string;executionId?:string;preparationRecovery?:PreparationRecovery;sourceRunId:string;rootRunId:string;checkpointHash:string;planHash:string;requestId:string;checkpointKey:string;planKey:string;spec:FilingSpec;baseVersion:number|null;baseHash:string|null;status:"claimed"|"running"|"failed"|"unknown"|"validated";reviewCalls:number;reviewCallsInherited?:number;correction?:ReviewerCorrection;maxReviewCalls:12;createdAt:string;phase?:Phase;stages:Record<string,Phase>;stateRef?:StateRef;validatedKey?:string;version?:number;hash?:string;error?:string};
const executionOf=(run:FilingOperatorRun)=>run.executionId??run.runId;
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{"cache-control":"private, no-store"}});
const db=(env:AnalysisEnv)=>{if(!env.DB)throw new Error("Operator storage unavailable");return env.DB;};
async function readRun(env:AnalysisEnv,id:string):Promise<FilingOperatorRun|null>{const row=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(operatorKey(id)).first<{payload:string}>();return row?JSON.parse(row.payload):null;}
async function putImmutable(env:AnalysisEnv,key:string,body:string){const result=await env.SEC_FILINGS.put(key,body,{httpMetadata:{contentType:"application/json"},onlyIf:{etagDoesNotMatch:"*"}});if(!result&&await(await env.SEC_FILINGS.get(key))?.text()!==body)throw new Error("Immutable operator object mismatch");}
async function writeState(env:AnalysisEnv,id:string,state:FilingState):Promise<StateRef>{const body=packState(state),hash=await sha256(body),key=`filing-operator/${id}/states/${hash}.json`;await putImmutable(env,key,body);return{key,hash};}
async function readState(env:AnalysisEnv,ref:StateRef):Promise<FilingState>{const body=await(await env.SEC_FILINGS.get(ref.key))?.text();if(!body||await sha256(body)!==ref.hash)throw new Error("Operator state integrity mismatch");return unpackState<FilingState>(body);}
async function publicBase(env:AnalysisEnv,ticker:string,accession:string){return await db(env).prepare("SELECT a.published_version version,v.hash FROM analysis_artifacts a LEFT JOIN analysis_artifact_versions v ON v.artifact_id=a.artifact_id AND v.version=a.published_version WHERE a.artifact_id=?").bind(artifactId("filing-report",ticker,accession)).first<{version:number|null;hash:string|null}>()??{version:null,hash:null};}
async function assertBase(env:AnalysisEnv,run:Pick<FilingOperatorRun,"spec"|"baseVersion"|"baseHash">){const current=await publicBase(env,run.spec.ticker,run.spec.filing.accessionNumber);if(current.version!==run.baseVersion||current.hash!==run.baseHash)throw new Error("The exact public base changed; this operator plan cannot be validated");}
async function assertFrozenResearch(env:AnalysisEnv,run:FilingOperatorRun,state:FilingState){
  const mappings=await companyExposureMappingStatus(env,run.spec.ticker,run.spec.publicResearch?.mappingVersions??[]);
  if(mappings.status!=="valid")throw new Error("Frozen company mapping requires review");
  for(const use of state.researchUses??[])if(use.decision==="adopted"){const current=await readPublicResearch(env,use.reportId,{version:use.version});if(!current.report||!publicClaimUsable(current.report,use.claimId))throw new Error("An adopted frozen public claim is no longer usable");}
}

/** A separate one-shot tool/review operation. Original author/continuation budgets and objects remain untouched. */
export async function handleFilingOperatorCompletion(request:Request,env:AnalysisEnv,source:ShadowRun):Promise<Response>{
  if(request.method!=="POST")return reply({error:"Method not allowed"},405);
  const requestId=request.headers.get("idempotency-key")??"";
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId))return reply({error:"A UUID idempotency-key is required"},400);
  try{
    const body=await request.text();if(new TextEncoder().encode(body).byteLength>131072)return reply({error:"Operator plan exceeds 128 KiB"},413);
    const plan=filingOperatorPlanSchema.parse(JSON.parse(body)),planHash=await sha256(stableOperatorValue(plan));
    if(plan.sourceRunId!==source.runId||source.spec.operatorCompletion||source.spec.profile!=="periodic")throw new Error("Exact failed periodic source leaf required");
    if(await db(env).prepare("SELECT 1 FROM sec_cache WHERE cache_key=?").bind(`${shadowKey(source.runId)}:resume`).first())throw new Error("This source already has a continuation; complete only its failed leaf");
    let rootRunId=source.runId;
    if(source.parentRunId){
      rootRunId=source.parentRunId;
      const original=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(shadowKey(rootRunId)).first<{payload:string}>(),claim=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(`${shadowKey(rootRunId)}:resume`).first<{payload:string}>();
      if(!original||!claim||JSON.parse(claim.payload).runId!==source.runId||JSON.parse(original.payload).parentRunId)throw new Error("Continuation lineage does not match the admitted source");
    }
    const prior=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(lineageClaim(rootRunId)).first<{payload:string}>();
    if(prior){const old=JSON.parse(prior.payload);if(old.requestId!==requestId||old.planHash!==planHash||old.sourceRunId!==source.runId)throw new Error("This lineage already has its single operator plan; a new plan requires explicit reconsideration");return reply({...old,replay:true,dispatchRetried:false,operation:await readRun(env,old.runId)},202);}
    const exported=await endedCheckpoint(env,source),checkpoint=exported.checkpoint;
    if(exported.checkpointHash!==plan.expectedCheckpointHash||!checkpoint.session.capped||checkpoint.session.finished||checkpoint.session.startupPending||source.callsReserved!==source.maxCalls)throw new Error("Exact naturally ended failed, exhausted checkpoint required");
    const current=await publicBase(env,source.ticker,source.accession);
    if(current.version!==source.baseVersion||current.version!==plan.expectedPublicVersion||current.hash!==plan.expectedPublicHash)throw new Error("Exact unchanged public base version/hash required");
    const runId=`shadow-${source.ticker}-${source.accession}-operator-${requestId}`,now=new Date().toISOString();
    const checkpointKey=`filing-operator/${runId}/source/${exported.checkpointHash}.json`,planKey=`filing-operator/${runId}/plans/${planHash}.json`;
    const spec:FilingSpec={ticker:source.spec.ticker,filing:source.spec.filing,profile:source.spec.profile,sessionId:runId,jobId:runId,jobVersion:"operator.v1",requestedBy:"manual",material:source.spec.material,mode:"revise",shadow:true,publicResearch:source.spec.publicResearch,
      operatorCompletion:{sourceRunId:source.runId,checkpointHash:exported.checkpointHash,planHash,author:plan.author,authorUsage:{status:"unavailable",tokens:null,cost:null}}};
    const run:FilingOperatorRun={runId,sourceRunId:source.runId,rootRunId,checkpointHash:exported.checkpointHash,planHash,requestId,checkpointKey,planKey,spec,baseVersion:current.version,baseHash:current.hash,status:"claimed",reviewCalls:0,maxReviewCalls:12,createdAt:now,stages:{}};
    const state=unpackState<FilingState>(checkpoint.state);await assertFrozenResearch(env,run,state);
    await putImmutable(env,checkpointKey,JSON.stringify(checkpoint));await putImmutable(env,planKey,stableOperatorValue(plan));
    const raw=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(shadowKey(source.runId)).first<{payload:string}>();
    if(!raw||stableOperatorValue(JSON.parse(raw.payload))!==stableOperatorValue(source))throw new Error("Source shadow metadata changed");
    const receipt={runId,sourceRunId:source.runId,rootRunId,requestId,checkpointHash:run.checkpointHash,planHash,createdAt:now,publicReportUnchanged:true,maxReviewCalls:12,author:spec.operatorCompletion};
    const shadow:ShadowRun={runId,ticker:source.ticker,accession:source.accession,createdAt:now,baseVersion:current.version,callsReserved:0,maxCalls:12,spec};
    const artifact=artifactId("filing-report",source.ticker,source.accession);
    try{await db(env).batch([
      db(env).prepare(`INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM sec_cache WHERE cache_key=? AND payload=?) AND NOT EXISTS(SELECT 1 FROM sec_cache WHERE cache_key=?) AND COALESCE((SELECT published_version FROM analysis_artifacts WHERE artifact_id=?),-1)=? AND COALESCE((SELECT v.hash FROM analysis_artifact_versions v JOIN analysis_artifacts a ON a.artifact_id=v.artifact_id AND a.published_version=v.version WHERE a.artifact_id=?),'')=? THEN ? ELSE NULL END,?)`).bind(lineageClaim(rootRunId),shadowKey(source.runId),raw.payload,`${shadowKey(source.runId)}:resume`,artifact,current.version??-1,artifact,current.hash??"",JSON.stringify(receipt),now),
      db(env).prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)").bind(operatorKey(runId),JSON.stringify(run),now),
      db(env).prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)").bind(shadowKey(runId),JSON.stringify(shadow),now),
    ]);}catch(error){
      const claimed=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(lineageClaim(rootRunId)).first<{payload:string}>();
      if(claimed){const old=JSON.parse(claimed.payload);if(old.requestId===requestId&&old.planHash===planHash&&old.sourceRunId===source.runId)return reply({...old,replay:true,dispatchRetried:false,operation:await readRun(env,old.runId)},202);throw new Error("This lineage already has its single operator plan; a new plan requires explicit reconsideration");}
      throw error;
    }
    try{const runner=(withRuns(env) as AnalysisEnv&{FILING_OPERATOR_COMPLETION_WORKFLOW?:{create(input:{id:string;params:{runId:string}}):Promise<unknown>}}).FILING_OPERATOR_COMPLETION_WORKFLOW;if(!runner)throw new Error("Operator task runner unavailable");await runner.create({id:runId,params:{runId}});}
    catch(error){await failOperation(env,runId,"unknown",`Dispatch outcome uncertain; no automatic redispatch: ${String(error)}`);}
    return reply({...receipt,status:(await readRun(env,runId))?.status,replay:false},202);
  }catch(error){return reply({error:error instanceof Error?error.message:String(error)},409);}
}

const reviewerCorrectionBase=z.object({expectedPlanHash:z.string().regex(/^[a-f0-9]{64}$/),expectedFailedStateHash:z.string().regex(/^[a-f0-9]{64}$/),expectedPublicVersion:z.number().int().positive().nullable(),expectedPublicHash:z.string().regex(/^[a-f0-9]{64}$/).nullable()});
const reviewerCorrectionSchema=z.union([
  reviewerCorrectionBase.extend({expectedSemanticReceiptHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  reviewerCorrectionBase.extend({expectedContentBlockId:z.enum(PERIODIC_BLOCKS),expectedContentReceiptHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
const correctionClaim=(runId:string)=>`${operatorKey(runId)}:reviewer-correction`;
const phaseReceipt=(phase:Phase|undefined)=>phase?.receipt as ComposerPhaseReceipt|undefined;
const correctionPhase=(correction:FilingReviewerCorrectionReview)=>correction.sourcePhase??"semantic";
const correctionReceiptHash=(correction:FilingReviewerCorrectionReview)=>"contentReceiptHash"in correction?correction.contentReceiptHash:correction.semanticReceiptHash;
const reviewPhases=[...PERIODIC_BLOCKS.map(id=>`content:${id}`),"semantic"];
const cumulativeReviews=(run:FilingOperatorRun)=>run.reviewCalls+(run.reviewCallsInherited??0);
const frozenOperatorIdentity=(run:FilingOperatorRun)=>{
  const spec={...run.spec,sessionId:undefined,jobId:undefined,jobVersion:undefined,operatorCompletion:{...run.spec.operatorCompletion,reviewerCorrection:undefined}};
  return stableOperatorValue({sourceRunId:run.sourceRunId,rootRunId:run.rootRunId,checkpointHash:run.checkpointHash,checkpointKey:run.checkpointKey,planHash:run.planHash,planKey:run.planKey,baseVersion:run.baseVersion,baseHash:run.baseHash,spec});
};

async function correctionSource(env:AnalysisEnv,run:FilingOperatorRun){
  const ref=run.correction!.sourceRecordRef,body=await(await env.SEC_FILINGS.get(ref.key))?.text();
  if(!body||await sha256(body)!==ref.hash)throw new Error("The immutable failed operator record changed");
  const source=JSON.parse(body) as FilingOperatorRun,current=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(operatorKey(source.runId)).first<{payload:string}>();
  if(source.runId!==run.correction!.sourceOperatorRunId||!current||await sha256(current.payload)!==ref.hash)throw new Error("The original failed operator ledger changed");
  return source;
}

/** A content correction may advance through the fixed audit order, never restart it or reset its budget. */
async function correctionLineage(env:AnalysisEnv,leaf:FilingOperatorRun){
  const chain:FilingOperatorRun[]=[],seen=new Set<string>(),identity=frozenOperatorIdentity(leaf);
  let source=leaf;
  for(;;){
    if(seen.has(source.runId)||chain.length>=reviewPhases.length||frozenOperatorIdentity(source)!==identity)throw new Error("The bounded correction ancestry or frozen original inputs changed");
    seen.add(source.runId);chain.push(source);
    const paid=Object.values(source.stages).filter(phase=>reviewPhases.includes(phase.name)&&!phaseReceipt(phase)?.reusedFrom).length;
    if(source.status!=="failed"||source.phase?.status!=="failed"||!reviewPhases.includes(source.phase.name)||source.validatedKey||source.version||source.hash||!Number.isSafeInteger(source.reviewCalls)||source.reviewCalls<Math.max(1,paid)||!Number.isSafeInteger(source.reviewCallsInherited??0)||(source.reviewCallsInherited??0)<0||cumulativeReviews(source)>OPERATOR_REVIEW_REQUESTS||source.maxReviewCalls!==OPERATOR_REVIEW_REQUESTS||source.stages.prepare?.status!=="done")throw new Error("Every correction ancestor must retain its completed failed review and cumulative allowance");
    const failure=await(await env.SEC_FILINGS.get(`research-shadow/${source.runId}/failed.json`))?.text();
    if(!failure||JSON.parse(failure).status!=="failed")throw new Error("A stopped or interrupted correction ancestor cannot be reused");
    if(!source.correction){
      if(source.reviewCallsInherited||source.spec.operatorCompletion?.reviewerCorrection||source.stages.tools?.status!=="done")throw new Error("The correction ancestry must end at the original completed tools operation");
      return chain;
    }
    const correction=source.correction,metadata=source.spec.operatorCompletion?.reviewerCorrection,previous=correctionPhase(correction),next=source.phase.name;
    if(!previous.startsWith("content:")||reviewPhases.indexOf(next)<=reviewPhases.indexOf(previous)||source.stages.corrections?.status!=="done"||!metadata||metadata.sourceOperatorRunId!==correction.sourceOperatorRunId||metadata.failedStateHash!==correction.failedStateRef.hash||correctionPhase(metadata)!==previous||correctionReceiptHash(metadata)!==correctionReceiptHash(correction)||metadata.correctionsHash!==correction.correctionsHash||metadata.reviewCallsInherited!==source.reviewCallsInherited)throw new Error("Reviewer corrections must move strictly forward from a content failure with exact metadata");
    const parent=await correctionSource(env,source),receipt=phaseReceipt(parent.stages[previous]);
    if(parent.phase?.name!==previous||parent.phase.status!=="failed"||!receipt||receipt.success||receipt.unavailable||await sha256(JSON.stringify(receipt))!==correctionReceiptHash(correction)||stableOperatorValue(parent.stateRef)!==stableOperatorValue(correction.failedStateRef)||source.reviewCallsInherited!==cumulativeReviews(parent))throw new Error("The correction parent receipt, failed state or inherited total changed");
    source=parent;
  }
}

async function applyReviewerCorrections(env:AnalysisEnv,run:FilingOperatorRun,state:FilingState){
  const source=await correctionSource(env,run),phase=correctionPhase(run.correction!),receipt=phaseReceipt(source.stages[phase])!,selectedIssues=phase==="semantic"?receipt.issues:receipt.issues.filter(issue=>issue.severity==="major");
  if(await sha256(JSON.stringify(receipt))!==correctionReceiptHash(run.correction!)||await sha256(stableOperatorValue(selectedIssues.map(({block,key,quote,replacement})=>({block,key,quote,replacement}))))!==run.correction!.correctionsHash)throw new Error("The admitted reviewer corrections changed");
  const validation=(state.composer as OperatorComposerState).operatorValidation;
  const recorded=phase==="semantic"?validation?.semantic:validation?.content[receipt.blockId??""];
  if(stableOperatorValue(source.stateRef)!==stableOperatorValue(run.correction!.failedStateRef)||!validation||validation.runId!==source.runId||JSON.stringify(recorded)!==JSON.stringify(receipt))throw new Error("Failed state does not hold the actual admitted review receipt");
  const harness=await filingOperatorHarness(env,run.spec,state,async()=>{throw new Error("Applying corrections cannot validate a shadow");});
  const researchBefore=packState({...state,composer:null}),before=Object.fromEntries(state.composer.blocks.map(block=>[block.id,stableOperatorValue({id:block.id,title:block.title,html:block.html,sources:block.sources})]));
  const transcript=[];
  for(const id of run.correction!.changedBlocks){
    const issues=state.composer.open[id]??[],selected=selectedIssues.filter(issue=>issue.block===id);
    const original=state.composer.blocks.find(block=>block.id===id)!,issue=selected[0]!;
    if(selected.length!==1||!issue.quote||!issue.replacement||original.html.split(issue.quote).length!==2)throw new Error("The single reviewer quote must appear exactly once as plain HTML text");
    const expectedHtml=original.html.replace(issue.quote,()=>issue.replacement!.trim().replace(/&/g,"&amp;"));
    const numbers=selected.map(expected=>issues.findIndex(issue=>stableOperatorValue(issue)===stableOperatorValue(expected))+1);
    if(numbers.some(number=>number<1))throw new Error("Actual saved open issues do not match the failed review receipt");
    const beforeHash=await sha256(packState(state)),input={id,numbers};
    const outcome=await runTool(harness.recipe.tools(state),{...harness.recipe.policy,allow:["apply_fixes"]},{name:"apply_fixes",input},{state,signal:AbortSignal.timeout(60_000),recipe:harness.recipe.id,stage:(_name,work)=>work()});
    transcript.push({name:"apply_fixes",input,outcome,beforeHash,afterHash:await sha256(packState(state))});
    if(outcome.error||outcome.asked)throw new Error(`The real apply_fixes tool rejected the reviewer replacement: ${outcome.observation}`);
    if(state.composer.blocks.find(block=>block.id===id)?.html!==expectedHtml)throw new Error("The real apply_fixes result differs from the one exact reviewer replacement");
  }
  const changed=state.composer.blocks.filter(block=>before[block.id]!==stableOperatorValue({id:block.id,title:block.title,html:block.html,sources:block.sources})).map(block=>block.id);
  if(stableOperatorValue(changed.sort())!==stableOperatorValue([...run.correction!.changedBlocks].sort())||packState({...state,composer:null})!==researchBefore)throw new Error("Reviewer corrections must change only their named report blocks, never research or computations");
  return {observation:`Applied ${selectedIssues.length} actual reviewer replacement(s) without research or calculations.`,transcript};
}

async function prepareReviewerCorrection(env:AnalysisEnv,run:FilingOperatorRun,state:FilingState,harness:Awaited<ReturnType<typeof filingOperatorHarness>>){
  const prepared=await harness.stages.prepare(state);if(prepared.error)return prepared;
  const source=await correctionSource(env,run),lineage=await correctionLineage(env,source),reused=[];
  for(const id of PERIODIC_BLOCKS.filter(id=>!run.correction!.changedBlocks.includes(id))){
    let owner=source,phase=owner.stages[`content:${id}`],receipt=phaseReceipt(phase);
    if(!phase&&correctionPhase(run.correction!)!=="semantic")continue;
    if(phase?.status!=="done"||!receipt?.success||!phase.afterStateRef||receipt.stage!=="content"||receipt.blockId!==id)throw new Error("The original block has no completed real content proof");
    const sourceAfter=await readState(env,phase.afterStateRef),sourceValidation=(sourceAfter.composer as OperatorComposerState).operatorValidation;
    if(sourceValidation?.runId!==source.runId||JSON.stringify(sourceValidation.content[id])!==JSON.stringify(receipt))throw new Error("A successful content receipt must be present in its actual saved after-state");
    if(receipt.reusedFrom){
      const inherited=receipt.reusedFrom;
      owner=lineage.find(ancestor=>ancestor.runId===inherited.sourceRunId)!;
      if(!owner)throw new Error("A reused content proof must resolve to this exact frozen ancestry");
      phase=owner.stages[`content:${id}`];receipt=phaseReceipt(phase);
      if(phase?.status!=="done"||!receipt?.success||receipt.reusedFrom||!phase.afterStateRef||receipt.stage!=="content"||receipt.blockId!==id||inherited.sourcePhase!==phase.name||inherited.receiptHash!==await sha256(JSON.stringify(receipt))||stableOperatorValue(inherited.beforeStateRef)!==stableOperatorValue(phase.beforeStateRef)||stableOperatorValue(inherited.afterStateRef)!==stableOperatorValue(phase.afterStateRef)||inherited.inputHash!==receipt.inputHash||inherited.blockHash!==receipt.blockHash||inherited.requestPolicy!==receipt.requestPolicy)throw new Error("A reused content proof must name the actual original successful provider receipt");
    }
    const before=await readState(env,phase.beforeStateRef),after=await readState(env,phase.afterStateRef),input=await harness.contentInput(before,id),current=await harness.contentInput(state,id);
    const originalValidation=(after.composer as OperatorComposerState).operatorValidation;
    if(originalValidation?.runId!==owner.runId||JSON.stringify(originalValidation.content[id])!==JSON.stringify(receipt))throw new Error("The original provider receipt does not match its saved after-state");
    if(!input||!current||input.inputHash!==current.inputHash||input.blockHash!==current.blockHash)throw new Error(`Unchanged block ${id} no longer has the exact original review input`);
    const rows=await db(env).prepare("SELECT at,model,reasoning,outcome FROM ai_usage WHERE run_id=? AND stage=? AND outcome='ok' AND at>=? AND at<=? ORDER BY at").bind(owner.runId,`artifact-review-${id}`,new Date(phase.expiresAt-OPERATOR_PHASE_LEASE_MS).toISOString(),receipt.at).all<{at:string;model:string;reasoning:string|null;outcome:"ok"}>();
    if(rows.results.length!==1||rows.results[0]!.model!==input.model||rows.results[0]!.reasoning!==input.reasoning)throw new Error(`Original successful provider usage for ${id} does not match the reconstructed request`);
    if(!receipt.inputHash){
      // Old v1 receipts did not store a wire-request hash. Do not infer unchanged historical configuration
      // from a matching current alias when its retained endpoint or tool settings were subsequently edited.
      const settings=await db(env).prepare("SELECT updated_at FROM ai_tool_settings WHERE tool='artifact-review'").first<{updated_at:string}>(),endpoint=await db(env).prepare("SELECT base_url,thinking_level,updated_at FROM ai_endpoints WHERE name=?").bind(input.model).first<{base_url:string;thinking_level:string;updated_at:string}>();
      const changed=(at:string)=>!Number.isFinite(Date.parse(at))||Date.parse(at)>Date.parse(rows.results[0]!.at);
      if(settings&&changed(settings.updated_at)||endpoint&&(changed(endpoint.updated_at)||endpoint.base_url!==input.endpoint.url||endpoint.thinking_level!==input.endpoint.thinkingLevel)||!endpoint&&(input.endpoint.url!==DEEPSEEK_BASE_URL||input.endpoint.thinkingLevel!==null))throw new Error(`Legacy configuration for ${id} cannot be reconstructed as unchanged`);
    }
    const proof={sourceRunId:owner.runId,sourcePhase:`content:${id}`,beforeStateRef:phase.beforeStateRef,afterStateRef:phase.afterStateRef,receiptHash:await sha256(JSON.stringify(receipt)),receipt,input,passedBefore:before.composer.passed?.[id]??[],passedAfter:after.composer.passed?.[id]??[],usage:{...rows.results[0]!,reasoning:rows.results[0]!.reasoning!,runId:owner.runId,stage:`artifact-review-${id}`},reconstruction:"reconstructedLegacy-v1" as const};
    const result=await harness.stages.reuseContent(state,id,proof);if(result.error)throw new Error(result.observation);
    reused.push({id,receipt:result.receipt});
  }
  const observation=`${prepared.observation} Reused ${reused.length} unchanged exact provider inputs.`;
  return {...prepared,observation,receipt:{...prepared.receipt!,observation,reusedContent:reused},reused};
}

/** Offline rehearsal of the durable non-billable tool/proof phases; HTTP admission never calls this heavy path. */
export async function previewFilingReviewerCorrections(env:AnalysisEnv,run:FilingOperatorRun,state:FilingState){
  const applied=await applyReviewerCorrections(env,run,state),harness=await filingOperatorHarness(env,run.spec,state,async()=>{throw new Error("Correction preparation cannot validate a shadow");});
  const prepared=await prepareReviewerCorrection(env,run,state,harness);if(prepared.error)throw new Error(prepared.observation);
  return {applied,prepared};
}

/** One reviewer's own supported correction, never an arbitrary replacement plan or a reopened author budget. */
export async function handleFilingReviewerCorrections(request:Request,env:AnalysisEnv,shadow:ShadowRun):Promise<Response>{
  if(request.method!=="POST")return reply({error:"Method not allowed"},405);
  const requestId=request.headers.get("idempotency-key")??"";
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId))return reply({error:"A UUID idempotency-key is required"},400);
  try{
    const body=await request.text();if(new TextEncoder().encode(body).byteLength>8192)return reply({error:"Reviewer correction identity exceeds 8 KiB"},413);
    const input=reviewerCorrectionSchema.parse(JSON.parse(body)),inputHash=await sha256(stableOperatorValue(input));
    const prior=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(correctionClaim(shadow.runId)).first<{payload:string}>();
    const replay=async(payload:string)=>{const old=JSON.parse(payload);if(old.requestId!==requestId||old.inputHash!==inputHash)throw new Error("This operator already has its single reviewer correction");return reply({...old,replay:true,dispatchRetried:false,operation:await readRun(env,old.runId)},202);};
    if(prior)return await replay(prior.payload);
    const row=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(operatorKey(shadow.runId)).first<{payload:string}>(),source=row?JSON.parse(row.payload) as FilingOperatorRun:null;
    const contentBlock="expectedContentBlockId"in input?input.expectedContentBlockId:null;
    const reviewPhase=contentBlock?`content:${contentBlock}`:"semantic",expectedReceiptHash="expectedContentReceiptHash"in input?input.expectedContentReceiptHash:input.expectedSemanticReceiptHash;
    if(!source||source.runId!==shadow.runId||stableOperatorValue(source.spec)!==stableOperatorValue(shadow.spec)||!source.spec.operatorCompletion||source.status!=="failed"||source.phase?.name!==reviewPhase||source.phase.status!=="failed"||source.validatedKey||source.version||source.hash)throw new Error("Only an exact completed failed content or semantic leaf may receive its single forward correction");
    await correctionLineage(env,source);
    const failed=source.stages[reviewPhase],receipt=phaseReceipt(failed);
    if(!failed||failed.status!=="failed"||!receipt||receipt.stage!==(contentBlock?"content":"semantic")||contentBlock&&receipt.blockId!==contentBlock||receipt.success||receipt.unavailable||!receipt.issues.length||!failed.afterStateRef||stableOperatorValue(source.stateRef)!==stableOperatorValue(failed.afterStateRef)||source.planHash!==input.expectedPlanHash||source.stateRef?.hash!==input.expectedFailedStateHash||await sha256(JSON.stringify(receipt))!==expectedReceiptHash||await sha256(JSON.stringify(source.phase.receipt??null))!==expectedReceiptHash)throw new Error("The exact completed failed review receipt, state and original plan are required");
    const issues=contentBlock?receipt.issues.filter(issue=>issue.severity==="major"):receipt.issues;
    if(contentBlock&&receipt.issues.some(issue=>issue.kind!=="content"||issue.block!==contentBlock||!["major","minor"].includes(issue.severity)))throw new Error("Content correction must preserve its actual single-block content review");
    if(issues.some(issue=>issue.kind!=="content"||(contentBlock?issue.block!==contentBlock||issue.origin!==undefined:issue.origin!=="semantic"))||issues.some(issue=>issue.severity!=="major"||!PERIODIC_BLOCKS.includes(issue.block as typeof PERIODIC_BLOCKS[number])||!issue.quote||!issue.replacement?.trim()||/[<>]/.test(issue.replacement)||/^delete\.?$/i.test(issue.replacement.trim())))throw new Error("Every material issue must have an unambiguous plain-text reviewer replacement");
    if(contentBlock&&(!receipt.inputHash||!receipt.blockHash||!receipt.requestPolicy))throw new Error("The failed content review must retain its actual request and block identity");
    const preceding=contentBlock?PERIODIC_BLOCKS.slice(0,PERIODIC_BLOCKS.indexOf(contentBlock)):[...PERIODIC_BLOCKS];
    if(preceding.some(id=>source.stages[`content:${id}`]?.status!=="done"||!phaseReceipt(source.stages[`content:${id}`])?.success)||contentBlock&&(PERIODIC_BLOCKS.slice(PERIODIC_BLOCKS.indexOf(contentBlock)+1).some(id=>source.stages[`content:${id}`])||["semantic","render","shadow"].some(name=>source.stages[name])))throw new Error("Completed preparation and all preceding content proofs are required");
    if(preceding.some(id=>!phaseReceipt(source.stages[`content:${id}`])?.inputHash))throw new Error("Reusing a prior content audit requires its actual original request hash; a changed prompt cannot be proven from a hashless legacy receipt");
    const freshReviews=contentBlock?PERIODIC_BLOCKS.length-preceding.length+2:3;
    const reviewCallsInherited=cumulativeReviews(source);
    if(reviewCallsInherited+freshReviews>OPERATOR_REVIEW_REQUESTS)throw new Error("The inherited review allowance must cover every fresh content audit, full semantic audit and strict rendering review");
    const failure=await(await env.SEC_FILINGS.get(`research-shadow/${source.runId}/failed.json`))?.text();
    if(!failure||JSON.parse(failure).status!=="failed")throw new Error("A completed failure receipt is required; stopped or interrupted work is not correctable");
    await assertBase(env,source);if(source.baseVersion!==input.expectedPublicVersion||source.baseHash!==input.expectedPublicHash)throw new Error("Exact unchanged public version and hash required");
    const correctionsHash=await sha256(stableOperatorValue(issues.map(({block,key,quote,replacement})=>({block,key,quote,replacement})))),changedBlocks=[...new Set(issues.map(issue=>issue.block))];
    if(changedBlocks.length!==1||issues.length!==1)throw new Error("This bounded reviewer correction applies exactly one reviewer's plain-text replacement in one report block");
    const runId=`shadow-${shadow.ticker}-${shadow.accession}-operator-fix-${requestId}`,now=new Date().toISOString(),sourceRecordHash=await sha256(row!.payload),sourceRecordRef={key:`filing-operator/${runId}/correction-source/${sourceRecordHash}.json`,hash:sourceRecordHash};
    await putImmutable(env,sourceRecordRef.key,row!.payload);
    const identity:FilingReviewerCorrectionReview=contentBlock?{sourcePhase:`content:${contentBlock}`,contentReceiptHash:expectedReceiptHash}:{semanticReceiptHash:expectedReceiptHash};
    const spec:FilingSpec={...source.spec,sessionId:runId,jobId:runId,jobVersion:"operator.reviewer-correction.v1",operatorCompletion:{...source.spec.operatorCompletion,reviewerCorrection:{sourceOperatorRunId:source.runId,failedStateHash:source.stateRef.hash,...identity,correctionsHash,reviewCallsInherited}}};
    const run:FilingOperatorRun={...source,runId,requestId,spec,status:"claimed",reviewCalls:0,reviewCallsInherited,createdAt:now,stages:{},correction:{sourceOperatorRunId:source.runId,sourceRecordRef,failedStateRef:source.stateRef,...identity,correctionsHash,changedBlocks}};
    delete run.executionId;delete run.preparationRecovery;delete run.phase;delete run.stateRef;delete run.validatedKey;delete run.version;delete run.hash;delete run.error;
    // Large pinned states and full evidence proofs belong to the durable non-billable phases below.
    // The HTTP admission binds their exact identities and claims once without rereading them synchronously.
    const claim={runId,sourceOperatorRunId:source.runId,requestId,inputHash,planHash:source.planHash,failedStateHash:source.stateRef.hash,...identity,correctionsHash,reviewCallsInherited,maxReviewCalls:12,createdAt:now,publicReportUnchanged:true};
    const newShadow:ShadowRun={runId,ticker:shadow.ticker,accession:shadow.accession,createdAt:now,baseVersion:source.baseVersion,callsReserved:0,maxCalls:12,spec},artifact=artifactId("filing-report",shadow.ticker,shadow.accession);
    try{await db(env).batch([
      db(env).prepare(`INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM sec_cache WHERE cache_key=? AND payload=?) AND COALESCE((SELECT published_version FROM analysis_artifacts WHERE artifact_id=?),-1)=? AND COALESCE((SELECT v.hash FROM analysis_artifact_versions v JOIN analysis_artifacts a ON a.artifact_id=v.artifact_id AND a.published_version=v.version WHERE a.artifact_id=?),'')=? THEN ? ELSE NULL END,?)`).bind(correctionClaim(source.runId),operatorKey(source.runId),row!.payload,artifact,source.baseVersion??-1,artifact,source.baseHash??"",JSON.stringify(claim),now),
      db(env).prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)").bind(operatorKey(runId),JSON.stringify(run),now),
      db(env).prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)").bind(shadowKey(runId),JSON.stringify(newShadow),now),
    ]);}catch(error){const existing=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(correctionClaim(source.runId)).first<{payload:string}>();if(existing)return await replay(existing.payload);throw error;}
    try{const runner=(withRuns(env) as AnalysisEnv&{FILING_OPERATOR_COMPLETION_WORKFLOW?:{create(input:{id:string;params:{runId:string}}):Promise<unknown>}}).FILING_OPERATOR_COMPLETION_WORKFLOW;if(!runner)throw new Error("Operator task runner unavailable");await runner.create({id:runId,params:{runId}});}catch(error){await failOperation(env,runId,"unknown",`Correction dispatch outcome uncertain; no automatic redispatch: ${String(error)}`);}
    return reply({...claim,status:(await readRun(env,runId))?.status,replay:false},202);
  }catch(error){return reply({error:error instanceof Error?error.message:String(error)},409);}
}

const preparationRecoverySchema=z.object({expectedRecordHash:z.string().regex(/^[a-f0-9]{64}$/),expectedPlanHash:z.string().regex(/^[a-f0-9]{64}$/),expectedPreparationStateHash:z.string().regex(/^[a-f0-9]{64}$/),expectedPublicVersion:z.number().int().positive().nullable(),expectedPublicHash:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict();
const preparationClaim=(id:string)=>`${operatorKey(id)}:preparation-recovery`;
type OperatorRunner={create(input:{id:string;params:{runId:string}}):Promise<unknown>;get(id:string):Promise<{status():Promise<{status:string;error?:unknown}>}>};
const operatorRunner=(env:AnalysisEnv)=>(withRuns(env) as AnalysisEnv&{FILING_OPERATOR_COMPLETION_WORKFLOW?:OperatorRunner}).FILING_OPERATOR_COMPLETION_WORKFLOW;

/** Explicitly redoes only a timed-out, never-billed preparation after its old task is terminal. */
export async function handleFilingPreparationRecovery(request:Request,env:AnalysisEnv,shadow:ShadowRun):Promise<Response>{
  if(request.method!=="POST")return reply({error:"Method not allowed"},405);
  const requestId=request.headers.get("idempotency-key")??"";
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId))return reply({error:"A UUID idempotency-key is required"},400);
  try{
    const body=await request.text();if(new TextEncoder().encode(body).byteLength>8192)return reply({error:"Preparation identity exceeds 8 KiB"},413);
    const input=preparationRecoverySchema.parse(JSON.parse(body)),inputHash=await sha256(stableOperatorValue(input));
    const replay=async(payload:string)=>{const claim=JSON.parse(payload);if(claim.requestId!==requestId||claim.inputHash!==inputHash)throw new Error("This operation already has its single preparation recovery");return reply({...claim,replay:true,dispatchRetried:false,operation:await readRun(env,shadow.runId)},202);};
    const existing=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(preparationClaim(shadow.runId)).first<{payload:string}>();if(existing)return await replay(existing.payload);
    const row=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(operatorKey(shadow.runId)).first<{payload:string}>(),run=row?JSON.parse(row.payload) as FilingOperatorRun:null;
    if(!run||run.runId!==shadow.runId||stableOperatorValue(run.spec)!==stableOperatorValue(shadow.spec)||!run.correction||run.preparationRecovery||run.status!=="unknown"||run.phase?.name!=="prepare"||run.phase.status!=="unknown"||run.phase.expiresAt!==0||run.error!=="step operator:prepare timed out after 660s"||run.reviewCalls!==0||run.validatedKey||run.version||run.hash||run.stages.prepare||Object.keys(run.stages).some(name=>name.startsWith("content:")||["semantic","render","shadow"].includes(name))){
      const claimed=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(preparationClaim(shadow.runId)).first<{payload:string}>();if(claimed)return await replay(claimed.payload);
      throw new Error("Only the exact unbilled preparation timeout can be recovered once");
    }
    const corrected=run.stages.corrections;
    if(corrected?.status!=="done"||!corrected.afterStateRef||stableOperatorValue(corrected.afterStateRef)!==stableOperatorValue(run.phase.beforeStateRef)||stableOperatorValue(run.stateRef)!==stableOperatorValue(corrected.afterStateRef)||run.planHash!==input.expectedPlanHash||corrected.afterStateRef.hash!==input.expectedPreparationStateHash||await sha256(row!.payload)!==input.expectedRecordHash)throw new Error("Exact timed-out record, original plan and completed correction state required");
    await assertBase(env,run);if(run.baseVersion!==input.expectedPublicVersion||run.baseHash!==input.expectedPublicHash)throw new Error("The exact public base changed");
    const original=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(operatorKey(run.correction.sourceOperatorRunId)).first<{payload:string}>();
    if(!original||await sha256(original.payload)!==run.correction.sourceRecordRef.hash)throw new Error("The original failed author-review record changed");
    const runner=operatorRunner(env);if(!runner)throw new Error("Operator runner unavailable");
    const previousExecutionId=executionOf(run),oldStatus=await(await runner.get(previousExecutionId)).status();
    if(oldStatus.status!=="errored"&&oldStatus.status!=="terminated")throw new Error("The previous task must be terminal, never active or waiting");
    const failure=await(await env.SEC_FILINGS.get(`research-shadow/${run.runId}/failed.json`))?.text();
    if(!failure||JSON.parse(failure).status!=="failed"||JSON.parse(failure).reason!==run.error)throw new Error("The original timeout failure receipt is required; stopped work cannot recover");
    const executionId=`${run.runId}-preparation-recovery`,createdAt=new Date().toISOString(),recordRef={key:`filing-operator/${run.runId}/preparation-recovery/records/${input.expectedRecordHash}.json`,hash:input.expectedRecordHash},failureHash=await sha256(failure),failureRef={key:`filing-operator/${run.runId}/preparation-recovery/failures/${failureHash}.json`,hash:failureHash};
    await putImmutable(env,recordRef.key,row!.payload);await putImmutable(env,failureRef.key,failure);
    const recovery:PreparationRecovery={requestId,inputHash,previousExecutionId,executionId,recordRef,failureRef,stateRef:corrected.afterStateRef,runnerStatus:oldStatus.status,createdAt};
    const claim={runId:run.runId,...recovery,originalCalls:run.reviewCallsInherited??0,addedCalls:0,maxReviewCalls:12,publicReportUnchanged:true};
    const next={...run,executionId,preparationRecovery:recovery,status:"claimed" as const};delete next.error;
    const artifact=artifactId("filing-report",shadow.ticker,shadow.accession);
    try{await db(env).batch([
      db(env).prepare(`INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM sec_cache WHERE cache_key=? AND payload=?) AND EXISTS(SELECT 1 FROM sec_cache WHERE cache_key=? AND payload=?) AND COALESCE((SELECT published_version FROM analysis_artifacts WHERE artifact_id=?),-1)=? AND COALESCE((SELECT v.hash FROM analysis_artifact_versions v JOIN analysis_artifacts a ON a.artifact_id=v.artifact_id AND a.published_version=v.version WHERE a.artifact_id=?),'')=? THEN ? ELSE NULL END,?)`).bind(preparationClaim(run.runId),operatorKey(run.runId),row!.payload,operatorKey(run.correction.sourceOperatorRunId),original.payload,artifact,run.baseVersion??-1,artifact,run.baseHash??"",JSON.stringify(claim),createdAt),
      db(env).prepare("UPDATE sec_cache SET payload=?,fetched_at=? WHERE cache_key=? AND payload=?").bind(JSON.stringify(next),createdAt,operatorKey(run.runId),row!.payload),
    ]);}catch(error){const prior=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(preparationClaim(run.runId)).first<{payload:string}>();if(prior)return await replay(prior.payload);throw error;}
    try{await runner.create({id:executionId,params:{runId:run.runId}});}catch(error){await failOperation(env,run.runId,"unknown",`Preparation recovery dispatch uncertain; never automatically redispatched: ${String(error)}`,executionId);}
    return reply({...claim,status:(await readRun(env,run.runId))?.status,replay:false},202);
  }catch(error){return reply({error:error instanceof Error?error.message:String(error)},409);}
}

async function failOperation(env:AnalysisEnv,id:string,status:"failed"|"unknown",reason:string,executionId=id){
  const saved=await db(env).prepare("UPDATE sec_cache SET payload=json_set(payload,'$.status',?,'$.error',?,'$.phase.status',?,'$.phase.expiresAt',0),fetched_at=? WHERE cache_key=? AND json_extract(payload,'$.status')!='validated' AND COALESCE(json_extract(payload,'$.executionId'),json_extract(payload,'$.runId'))=?").bind(status,reason,status,new Date().toISOString(),operatorKey(id),executionId).run();
  const current=saved.meta.changes?await readRun(env,id):null;
  if(current&&executionOf(current)===executionId){const key=executionId===id?`research-shadow/${id}/failed.json`:`filing-operator/${id}/executions/${executionId}/failed.json`;await env.SEC_FILINGS.put(key,JSON.stringify({status:"failed",reason,at:new Date().toISOString(),operator:true,executionId}));}
}

/** Atomic before-send reservation shared by every independent provider/SDK retry. */
export async function reserveFilingOperatorReview(env:AnalysisEnv,id:string,leaseToken:string,executionId=id){
  const reserved=await db(env).prepare("UPDATE sec_cache SET payload=json_set(payload,'$.reviewCalls',json_extract(payload,'$.reviewCalls')+1) WHERE cache_key=? AND json_extract(payload,'$.status')='running' AND json_extract(payload,'$.phase.status')='started' AND (json_extract(payload,'$.phase.name') LIKE 'content:%' OR json_extract(payload,'$.phase.name') IN ('semantic','render')) AND json_extract(payload,'$.phase.leaseToken')=? AND json_extract(payload,'$.phase.expiresAt')>? AND COALESCE(json_extract(payload,'$.executionId'),json_extract(payload,'$.runId'))=? AND json_extract(payload,'$.reviewCalls')+COALESCE(json_extract(payload,'$.reviewCallsInherited'),0)<12 RETURNING cache_key").bind(operatorKey(id),leaseToken,Date.now(),executionId).first();
  if(!reserved)throw new Error("Operator independent-review allowance or lease exhausted");
}

export async function readFilingOperatorStatus(env:AnalysisEnv,shadow:ShadowRun){
  const row=await db(env).prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(operatorKey(shadow.runId)).first<{payload:string}>();if(!row)return {runId:shadow.runId,status:"unavailable"};
  const run=JSON.parse(row.payload) as FilingOperatorRun;
  const expired=run.status==="running"&&run.phase?.status==="started"&&run.phase.expiresAt<=Date.now();
  const current=await publicBase(env,shadow.ticker,shadow.accession);
  return {...run,recordHash:await sha256(row.payload),executionId:executionOf(run),totalReviewCalls:run.reviewCalls+(run.reviewCallsInherited??0),status:expired?"unknown":run.status,leaseExpired:!!expired,published:false,humanReviewRequired:true,authorUsage:{status:"unavailable",tokens:null,cost:null},reviewBudgetScope:"All independent provider HTTP sends including SDK retries and visual review, plus inherited failed requests when corrected; author session usage is unavailable",publicReportUnchanged:current.version===run.baseVersion&&current.hash===run.baseHash};
}
export async function stopFilingOperator(env:AnalysisEnv,shadow:ShadowRun){await db(env).prepare("UPDATE sec_cache SET payload=json_set(payload,'$.status','failed','$.error','Stopped by administrator','$.phase.status','failed','$.phase.expiresAt',0) WHERE cache_key=?").bind(operatorKey(shadow.runId)).run();await env.SEC_FILINGS.put(`research-shadow/${shadow.runId}/failed.json`,JSON.stringify({status:"stopped",reason:"Stopped by administrator",at:new Date().toISOString()}));return{runId:shadow.runId,status:"stopped"};}

/** Durable deterministic tools followed by independent stages. No Pi session or original budget is reopened. */
export async function executeFilingOperatorCompletion(params:{runId:string},context:{env:AnalysisEnv;step:RunStep;executionId?:string}){
  const {env,step}=context,id=params.runId,executionId=context.executionId??id;let state:FilingState;
  try{
    let run=await readRun(env,id);if(!run||executionOf(run)!==executionId)throw new NonRetryableError("Operator execution was superseded");if(run.status==="validated")return{runId:id,status:run.status,version:run.version,hash:run.hash,reviewCalls:run.reviewCalls,replay:true,publicReportUnchanged:true,humanReviewRequired:true};if(!["claimed","running"].includes(run.status))throw new NonRetryableError("Operator operation is not active");
    const sourceText=await(await env.SEC_FILINGS.get(run.checkpointKey))?.text(),planText=await(await env.SEC_FILINGS.get(run.planKey))?.text();
    if(!sourceText||await sha256(sourceText)!==run.checkpointHash||!planText||await sha256(planText)!==run.planHash)throw new NonRetryableError("Operator frozen inputs changed");
    const plan=filingOperatorPlanSchema.parse(JSON.parse(planText)),source=JSON.parse(sourceText);
    if(run.preparationRecovery){
      const recovery=run.preparationRecovery,record=await(await env.SEC_FILINGS.get(recovery.recordRef.key))?.text(),failure=await(await env.SEC_FILINGS.get(recovery.failureRef.key))?.text();
      if(!record||await sha256(record)!==recovery.recordRef.hash||!failure||await sha256(failure)!==recovery.failureRef.hash)throw new NonRetryableError("Preparation timeout archives changed");
      const previous=JSON.parse(record) as FilingOperatorRun;
      if(previous.status!=="unknown"||previous.reviewCalls!==0||previous.error!=="step operator:prepare timed out after 660s"||previous.phase?.name!=="prepare"||previous.phase.status!=="unknown"||previous.planHash!==run.planHash||previous.checkpointHash!==run.checkpointHash||executionOf(previous)!==recovery.previousExecutionId||recovery.executionId!==executionId||previous.stages.corrections?.status!=="done"||stableOperatorValue(previous.stages.corrections.afterStateRef)!==stableOperatorValue(recovery.stateRef)||stableOperatorValue(previous.phase.beforeStateRef)!==stableOperatorValue(recovery.stateRef)||stableOperatorValue(run.stages.corrections)!==stableOperatorValue(previous.stages.corrections))throw new NonRetryableError("Preparation recovery no longer matches its exact unbilled timeout and completed corrections");
      state=await readState(env,recovery.stateRef);
    }else state=run.correction?await readState(env,run.correction.failedStateRef):unpackState<FilingState>(source.state);
    const bootstrap=await readRun(env,id);if(!bootstrap||executionOf(bootstrap)!==executionId||!["claimed","running"].includes(bootstrap.status))throw new NonRetryableError("Operator execution changed during input loading");
    let stateRef=await writeState(env,id,state);
    const phases=[run.correction?"corrections":"tools","prepare",...PERIODIC_BLOCKS.map(block=>`content:${block}`),"semantic","render","shadow"];
    for(const name of phases){
      const output=await step.do(`operator:${name}`,{retries:{limit:0,delay:0},timeout:"11 minutes"},async()=>{
        const current=await readRun(env,id);if(!current||executionOf(current)!==executionId||!["claimed","running"].includes(current.status))throw new NonRetryableError("Operator execution is not active");
        const completed=current.stages[name];if(completed?.status==="done"&&completed.afterStateRef)return completed;
        if(current.phase?.status==="started"){await failOperation(env,id,"unknown","A phase was interrupted; billable work is never automatically replayed",executionId);throw new NonRetryableError("Interrupted operator phase; inspect its receipts");}
        await assertBase(env,current);await assertFrozenResearch(env,current,state);if(current.correction)await correctionSource(env,current);
        const phase:Phase={name,status:"started",leaseToken:crypto.randomUUID(),expiresAt:Date.now()+OPERATOR_PHASE_LEASE_MS,beforeStateRef:stateRef};
        const started=await db(env).prepare("UPDATE sec_cache SET payload=json_set(payload,'$.status','running','$.phase',json(?)),fetched_at=? WHERE cache_key=? AND json_extract(payload,'$.status') IN ('claimed','running') AND COALESCE(json_extract(payload,'$.phase.status'),'')!='started' AND COALESCE(json_extract(payload,'$.executionId'),json_extract(payload,'$.runId'))=?").bind(JSON.stringify(phase),new Date().toISOString(),operatorKey(id),executionId).run();
        if(!started.meta.changes)throw new NonRetryableError("Operator phase claim conflicted");
        const live=async()=>{const row=await readRun(env,id);if(!row||executionOf(row)!==executionId||row.status!=="running"||row.phase?.status!=="started"||row.phase.leaseToken!==phase.leaseToken||row.phase.expiresAt<=Date.now())throw new Error("Operator execution or phase lease expired or operation stopped");return row;};
        const gate=()=>reserveFilingOperatorReview(env,id,phase.leaseToken,executionId);
        const reviewEnv={...env,MODEL_REQUEST_GATE:gate};let pending:Record<string,unknown>|null=null;
        const harness=await filingOperatorHarness(reviewEnv,current.spec,state,async(work,published)=>{
          await live();await assertBase(env,current);await assertFrozenResearch(env,current,work);
          if(published.degraded.length)throw new Error("An operator shadow cannot use degraded content");
          await saveFilingImpact(env,{spec:current.spec,version:published.version,hash:published.hash,work:{material:current.spec.material,periodic:work.periodic,web:work.web,read:work.read??[]}});
          pending={spec:current.spec,...published,validatedAt:new Date().toISOString(),researchUses:work.researchUses??[],work:{material:current.spec.material,periodic:work.periodic,web:work.web,read:work.read??[]},operator:{...current.spec.operatorCompletion,reviewModels:{content:modelFor(env,"artifact-review"),semantic:env.OPENAI_REVIEW_MODEL??null,visual:env.OPENAI_REVIEW_MODEL??null}}};
        });
        let result:ComposerPhaseResult;
        if(name==="corrections"){
          try{
            const applied=await applyReviewerCorrections(reviewEnv,current,state);
            for(const entry of applied.transcript){await live();const body=JSON.stringify(entry);await putImmutable(env,`filing-operator/${id}/corrections/${await sha256(body)}.json`,body);}
            result={observation:applied.observation};
          }catch(error){result={error:true,observation:`Reviewer correction validation failed before any model request: ${error instanceof Error?error.message:String(error)}`};}
        }else if(name==="tools"){
          const applied=await executeFilingOperatorPlan(reviewEnv,current.spec,state,plan,async()=>{throw new Error("Tools cannot validate a shadow");},async entry=>{await live();const body=JSON.stringify(entry);await putImmutable(env,`filing-operator/${id}/tools/${entry.sequence}-${await sha256(body)}.json`,body);});
          result={observation:`Executed ${applied.toolCalls} real tool calls.`};
        }else if(name==="prepare"){
          if(current.correction){try{result=await prepareReviewerCorrection(reviewEnv,current,state,harness);}catch(error){result={error:true,observation:`Historical review proof failed before any model request: ${error instanceof Error?error.message:String(error)}`};}}
          else result=await harness.stages.prepare(state);
        }
        else if(name.startsWith("content:"))result=await harness.stages.content(state,name.slice(8));
        else if(name==="semantic")result=await harness.stages.semantic(state);
        else if(name==="render")result=await harness.stages.render(state);
        else result=await harness.stages.shadow(state);
        const afterStateRef=await writeState(env,id,state);await live();
        const done:Phase={...phase,status:result.error?"failed":"done",afterStateRef,receipt:result.receipt??{observation:result.observation},...(result.error?{error:result.observation}:{})};
        let validatedKey:string|null=null,version:number|null=null,hash:string|null=null;
        if(name==="shadow"&&!result.error){if(!pending)throw new Error("The real shadow harness produced no validation result");await assertBase(env,current);const body=JSON.stringify(pending);validatedKey=`filing-operator/${id}/validated/${await sha256(body)}.json`;await putImmutable(env,validatedKey,body);version=(pending as {version:number}).version;hash=(pending as {hash:string}).hash;}
        const artifact=artifactId("filing-report",current.spec.ticker,current.spec.filing.accessionNumber);
        const complete=await db(env).prepare(`UPDATE sec_cache SET payload=json_set(payload,'$.status',?,'$.phase',json(?),'$.stages.'||?,json(?),'$.stateRef',json(?),'$.validatedKey',?,'$.version',?,'$.hash',?),fetched_at=? WHERE cache_key=? AND json_extract(payload,'$.status')='running' AND json_extract(payload,'$.phase.status')='started' AND json_extract(payload,'$.phase.leaseToken')=? AND json_extract(payload,'$.phase.expiresAt')>? AND COALESCE(json_extract(payload,'$.executionId'),json_extract(payload,'$.runId'))=? AND COALESCE((SELECT published_version FROM analysis_artifacts WHERE artifact_id=?),-1)=? AND COALESCE((SELECT v.hash FROM analysis_artifact_versions v JOIN analysis_artifacts a ON a.artifact_id=v.artifact_id AND a.published_version=v.version WHERE a.artifact_id=?),'')=?`)
          .bind(result.error?"failed":name==="shadow"?"validated":"running",JSON.stringify(done),JSON.stringify(name),JSON.stringify(done),JSON.stringify(afterStateRef),validatedKey,version,hash,new Date().toISOString(),operatorKey(id),phase.leaseToken,Date.now(),executionId,artifact,current.baseVersion??-1,artifact,current.baseHash??"").run();
        if(!complete.meta.changes)throw new Error("Operator completion fence failed; no validated shadow is exposed");
        if(result.error){await failOperation(env,id,"failed",result.observation,executionId);throw new NonRetryableError(result.observation);}
        return done;
      });
      stateRef=output.afterStateRef!;state=await readState(env,stateRef);
    }
    run=(await readRun(env,id))!;return{runId:id,status:run.status,version:run.version,hash:run.hash,reviewCalls:run.reviewCalls,publicReportUnchanged:true,humanReviewRequired:true};
  }catch(error){const current=await readRun(env,id);if(current&&executionOf(current)===executionId&&current.status!=="validated"&&current.status!=="failed"&&current.status!=="unknown")await failOperation(env,id,current.phase?.status==="started"?"unknown":"failed",error instanceof Error?error.message:String(error),executionId);throw new NonRetryableError(error instanceof Error?error.message:String(error));}
}
