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
import { filingOperatorHarness, type FilingSpec, type FilingState } from "./recipe.ts";
import { saveFilingImpact } from "./impact-publication.ts";
import { PERIODIC_BLOCKS } from "./periodic.ts";
import type { ComposerPhaseResult } from "../artifact/compose.ts";

export const OPERATOR_REVIEW_REQUESTS=12;
export const OPERATOR_PHASE_LEASE_MS=10*60_000;
export const operatorKey=(runId:string)=>`filing-operator:${runId}`;
const lineageClaim=(runId:string)=>`${shadowKey(runId)}:operator-completion`;
type StateRef={key:string;hash:string};
type Phase={name:string;status:"started"|"done"|"failed"|"unknown";leaseToken:string;expiresAt:number;beforeStateRef:StateRef;afterStateRef?:StateRef;receipt?:unknown;error?:string};
export type FilingOperatorRun={runId:string;sourceRunId:string;rootRunId:string;checkpointHash:string;planHash:string;requestId:string;checkpointKey:string;planKey:string;spec:FilingSpec;baseVersion:number|null;baseHash:string|null;status:"claimed"|"running"|"failed"|"unknown"|"validated";reviewCalls:number;maxReviewCalls:12;createdAt:string;phase?:Phase;stages:Record<string,Phase>;stateRef?:StateRef;validatedKey?:string;version?:number;hash?:string;error?:string};
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

async function failOperation(env:AnalysisEnv,id:string,status:"failed"|"unknown",reason:string){
  const saved=await db(env).prepare("UPDATE sec_cache SET payload=json_set(payload,'$.status',?,'$.error',?,'$.phase.status',?,'$.phase.expiresAt',0),fetched_at=? WHERE cache_key=? AND json_extract(payload,'$.status')!='validated'").bind(status,reason,status,new Date().toISOString(),operatorKey(id)).run();
  if(saved.meta.changes)await env.SEC_FILINGS.put(`research-shadow/${id}/failed.json`,JSON.stringify({status:"failed",reason,at:new Date().toISOString(),operator:true}));
}

/** Atomic before-send reservation shared by every independent provider/SDK retry. */
export async function reserveFilingOperatorReview(env:AnalysisEnv,id:string,leaseToken:string){
  const reserved=await db(env).prepare("UPDATE sec_cache SET payload=json_set(payload,'$.reviewCalls',json_extract(payload,'$.reviewCalls')+1) WHERE cache_key=? AND json_extract(payload,'$.status')='running' AND json_extract(payload,'$.phase.status')='started' AND (json_extract(payload,'$.phase.name') LIKE 'content:%' OR json_extract(payload,'$.phase.name') IN ('semantic','render')) AND json_extract(payload,'$.phase.leaseToken')=? AND json_extract(payload,'$.phase.expiresAt')>? AND json_extract(payload,'$.reviewCalls')<12 RETURNING cache_key").bind(operatorKey(id),leaseToken,Date.now()).first();
  if(!reserved)throw new Error("Operator independent-review allowance or lease exhausted");
}

export async function readFilingOperatorStatus(env:AnalysisEnv,shadow:ShadowRun){
  const run=await readRun(env,shadow.runId);if(!run)return {runId:shadow.runId,status:"unavailable"};
  const expired=run.status==="running"&&run.phase?.status==="started"&&run.phase.expiresAt<=Date.now();
  const current=await publicBase(env,shadow.ticker,shadow.accession);
  return {...run,status:expired?"unknown":run.status,leaseExpired:!!expired,published:false,humanReviewRequired:true,authorUsage:{status:"unavailable",tokens:null,cost:null},reviewBudgetScope:"All independent provider HTTP sends including SDK retries and visual review; author session usage is unavailable",publicReportUnchanged:current.version===run.baseVersion&&current.hash===run.baseHash};
}
export async function stopFilingOperator(env:AnalysisEnv,shadow:ShadowRun){await db(env).prepare("UPDATE sec_cache SET payload=json_set(payload,'$.status','failed','$.error','Stopped by administrator','$.phase.status','failed','$.phase.expiresAt',0) WHERE cache_key=?").bind(operatorKey(shadow.runId)).run();await env.SEC_FILINGS.put(`research-shadow/${shadow.runId}/failed.json`,JSON.stringify({status:"stopped",reason:"Stopped by administrator",at:new Date().toISOString()}));return{runId:shadow.runId,status:"stopped"};}

/** Durable deterministic tools followed by independent stages. No Pi session or original budget is reopened. */
export async function executeFilingOperatorCompletion(params:{runId:string},context:{env:AnalysisEnv;step:RunStep}){
  const {env,step}=context,id=params.runId;let state:FilingState;
  try{
    let run=await readRun(env,id);if(run?.status==="validated")return{runId:id,status:run.status,version:run.version,hash:run.hash,reviewCalls:run.reviewCalls,replay:true,publicReportUnchanged:true,humanReviewRequired:true};if(!run||!["claimed","running"].includes(run.status))throw new NonRetryableError("Operator operation is not active");
    const sourceText=await(await env.SEC_FILINGS.get(run.checkpointKey))?.text(),planText=await(await env.SEC_FILINGS.get(run.planKey))?.text();
    if(!sourceText||await sha256(sourceText)!==run.checkpointHash||!planText||await sha256(planText)!==run.planHash)throw new NonRetryableError("Operator frozen inputs changed");
    const plan=filingOperatorPlanSchema.parse(JSON.parse(planText)),source=JSON.parse(sourceText);state=unpackState<FilingState>(source.state);
    let stateRef=await writeState(env,id,state);
    const phases=["tools","prepare",...PERIODIC_BLOCKS.map(block=>`content:${block}`),"semantic","render","shadow"];
    for(const name of phases){
      const output=await step.do(`operator:${name}`,{retries:{limit:0,delay:0},timeout:"11 minutes"},async()=>{
        const current=await readRun(env,id);if(!current||!["claimed","running"].includes(current.status))throw new NonRetryableError("Operator operation is not active");
        const completed=current.stages[name];if(completed?.status==="done"&&completed.afterStateRef)return completed;
        if(current.phase?.status==="started"){await failOperation(env,id,"unknown","A phase was interrupted; billable work is never automatically replayed");throw new NonRetryableError("Interrupted operator phase; inspect its receipts");}
        await assertBase(env,current);await assertFrozenResearch(env,current,state);
        const phase:Phase={name,status:"started",leaseToken:crypto.randomUUID(),expiresAt:Date.now()+OPERATOR_PHASE_LEASE_MS,beforeStateRef:stateRef};
        const started=await db(env).prepare("UPDATE sec_cache SET payload=json_set(payload,'$.status','running','$.phase',json(?)),fetched_at=? WHERE cache_key=? AND json_extract(payload,'$.status') IN ('claimed','running') AND COALESCE(json_extract(payload,'$.phase.status'),'')!='started'").bind(JSON.stringify(phase),new Date().toISOString(),operatorKey(id)).run();
        if(!started.meta.changes)throw new NonRetryableError("Operator phase claim conflicted");
        const live=async()=>{const row=await readRun(env,id);if(!row||row.status!=="running"||row.phase?.status!=="started"||row.phase.leaseToken!==phase.leaseToken||row.phase.expiresAt<=Date.now())throw new Error("Operator phase lease expired or operation stopped");return row;};
        const gate=()=>reserveFilingOperatorReview(env,id,phase.leaseToken);
        const reviewEnv={...env,MODEL_REQUEST_GATE:gate};let pending:Record<string,unknown>|null=null;
        const harness=await filingOperatorHarness(reviewEnv,current.spec,state,async(work,published)=>{
          await live();await assertBase(env,current);await assertFrozenResearch(env,current,work);
          if(published.degraded.length)throw new Error("An operator shadow cannot use degraded content");
          await saveFilingImpact(env,{spec:current.spec,version:published.version,hash:published.hash,work:{material:current.spec.material,periodic:work.periodic,web:work.web,read:work.read??[]}});
          pending={spec:current.spec,...published,validatedAt:new Date().toISOString(),researchUses:work.researchUses??[],work:{material:current.spec.material,periodic:work.periodic,web:work.web,read:work.read??[]},operator:{...current.spec.operatorCompletion,reviewModels:{content:modelFor(env,"artifact-review"),semantic:env.OPENAI_REVIEW_MODEL??null,visual:env.OPENAI_REVIEW_MODEL??null}}};
        });
        let result:ComposerPhaseResult;
        if(name==="tools"){
          const applied=await executeFilingOperatorPlan(reviewEnv,current.spec,state,plan,async()=>{throw new Error("Tools cannot validate a shadow");},async entry=>{await live();const body=JSON.stringify(entry);await putImmutable(env,`filing-operator/${id}/tools/${entry.sequence}-${await sha256(body)}.json`,body);});
          result={observation:`Executed ${applied.toolCalls} real tool calls.`};
        }else if(name==="prepare")result=await harness.stages.prepare(state);
        else if(name.startsWith("content:"))result=await harness.stages.content(state,name.slice(8));
        else if(name==="semantic")result=await harness.stages.semantic(state);
        else if(name==="render")result=await harness.stages.render(state);
        else result=await harness.stages.shadow(state);
        const afterStateRef=await writeState(env,id,state);await live();
        const done:Phase={...phase,status:result.error?"failed":"done",afterStateRef,receipt:result.receipt??{observation:result.observation},...(result.error?{error:result.observation}:{})};
        let validatedKey:string|null=null,version:number|null=null,hash:string|null=null;
        if(name==="shadow"&&!result.error){if(!pending)throw new Error("The real shadow harness produced no validation result");await assertBase(env,current);const body=JSON.stringify(pending);validatedKey=`filing-operator/${id}/validated/${await sha256(body)}.json`;await putImmutable(env,validatedKey,body);version=(pending as {version:number}).version;hash=(pending as {hash:string}).hash;}
        const artifact=artifactId("filing-report",current.spec.ticker,current.spec.filing.accessionNumber);
        const complete=await db(env).prepare(`UPDATE sec_cache SET payload=json_set(payload,'$.status',?,'$.phase',json(?),'$.stages.'||?,json(?),'$.stateRef',json(?),'$.validatedKey',?,'$.version',?,'$.hash',?),fetched_at=? WHERE cache_key=? AND json_extract(payload,'$.status')='running' AND json_extract(payload,'$.phase.status')='started' AND json_extract(payload,'$.phase.leaseToken')=? AND json_extract(payload,'$.phase.expiresAt')>? AND COALESCE((SELECT published_version FROM analysis_artifacts WHERE artifact_id=?),-1)=? AND COALESCE((SELECT v.hash FROM analysis_artifact_versions v JOIN analysis_artifacts a ON a.artifact_id=v.artifact_id AND a.published_version=v.version WHERE a.artifact_id=?),'')=?`)
          .bind(result.error?"failed":name==="shadow"?"validated":"running",JSON.stringify(done),JSON.stringify(name),JSON.stringify(done),JSON.stringify(afterStateRef),validatedKey,version,hash,new Date().toISOString(),operatorKey(id),phase.leaseToken,Date.now(),artifact,current.baseVersion??-1,artifact,current.baseHash??"").run();
        if(!complete.meta.changes)throw new Error("Operator completion fence failed; no validated shadow is exposed");
        if(result.error){await failOperation(env,id,"failed",result.observation);throw new NonRetryableError(result.observation);}
        return done;
      });
      stateRef=output.afterStateRef!;state=await readState(env,stateRef);
    }
    run=(await readRun(env,id))!;return{runId:id,status:run.status,version:run.version,hash:run.hash,reviewCalls:run.reviewCalls,publicReportUnchanged:true,humanReviewRequired:true};
  }catch(error){const current=await readRun(env,id);if(current&&current.status!=="validated"&&current.status!=="failed"&&current.status!=="unknown")await failOperation(env,id,current.phase?.status==="started"?"unknown":"failed",error instanceof Error?error.message:String(error));throw new NonRetryableError(error instanceof Error?error.message:String(error));}
}
