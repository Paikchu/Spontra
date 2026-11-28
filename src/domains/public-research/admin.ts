import { companyResearchExposureSchema, publicResearchDraftSchema } from "./schema.ts";
import { saveCompanyResearchExposure, freezeCompanyResearch, bindCompanyExposureFromTag } from "./context.ts";
import { z } from "zod";
import type { AnalysisEnv } from "../../operations.ts";
import { authenticateAdmin } from "../../api/admin/auth.ts";
import { json } from "../../api/admin/http.ts";
import { AI_MODELS } from "../../api/admin/types/ai-models-admin.ts";
import { listEndpoints } from "../../ai/pi/endpoints.ts";
import { sha256 } from "../../lib/sha256.ts";
import { withRuns } from "../../ai/durable-runs/binding.ts";
import { publicResearchRunSchema, freezePublicResearchInput, type PublicResearchRunSpec } from "./generation.ts";
import { readPublicResearch, readPublicResearchDraft, reviewPublicResearch, publishPublicResearch, withdrawPublicResearch, restorePublicResearch, listPublicResearch, invalidatePublicResearchEvent, revisePublicResearchDraft, completeStoppedIndustryDraft } from "./store.ts";
import { publicResearchCheckpoint, publicResearchStageSchema, readPublicResearchCheckpoint } from "./checkpoint.ts";
import type { StoredPiSession } from "../../ai/pi/host.ts";

type RunRow={run_id:string;report_id:string;input_fingerprint:string;state:string;params_json:string;result_version:string|null;error:string|null;calls_reserved:number;max_calls:number;max_tokens:number;created_at:string;updated_at:string};
type Binding={create(options:{id:string;params:unknown}):Promise<unknown>;get(id:string):Promise<{status():Promise<unknown>;report():Promise<unknown>;terminate():Promise<void>}>;readPublicResearchSession(id:string,stage:string):Promise<{runId:string;status:"terminated";session:StoredPiSession}|null>};
const binding=(env:AnalysisEnv)=>(withRuns(env) as AnalysisEnv & {PUBLIC_RESEARCH_WORKFLOW?:Binding}).PUBLIC_RESEARCH_WORKFLOW;
const reviewSchema=z.object({mode:z.enum(["human","automatic"]).default("human"),reviewer:z.string().min(3),reviewedAt:z.string().datetime({offset:true}),authorRunId:z.string(),claimChecks:z.array(z.object({claimId:z.string(),supported:z.boolean(),notes:z.string().min(1)})),conclusion:z.enum(["approved","rejected"]),notes:z.string().min(1)});
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==="object"&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);

/** Explicit operator runs: macro may publish after independent automatic review; industry remains human-gated. */
export async function handlePublicResearchAdminRequest(request:Request,env:AnalysisEnv):Promise<Response>{
  if(!await authenticateAdmin(request,env.REPORT_ADMIN_PASSWORD,Date.now()))return json({error:"请登录管理后台。"},401);
  if(!env.DB)return json({error:"Research database unavailable"},503);
  const path=new URL(request.url).pathname.replace(/\/$/,""),db=env.DB;
  try{
    if(path==="/admin/public-research/exposures/from-tag"&&request.method==="POST"){
      const input=z.object({exposureId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),baseVersion:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),tagId:z.string().regex(/^t[a-f0-9]{24}$/)}).strict().parse(await request.json());
      return json(await bindCompanyExposureFromTag(env,input));
    }
    if(path==="/admin/public-research/exposures"&&request.method==="POST"){
      const exposure=companyResearchExposureSchema.parse(await request.json());
      if(exposure.tagBinding)return json({error:"Use exposures/from-tag to bind existing server-verified tag evidence"},400);
      if(await sha256(exposure.source.excerpt)!==exposure.source.contentHash)return json({error:"Exposure source hash mismatch"},400);
      if(Date.parse(exposure.source.availableAt)>Date.now())return json({error:"Future exposure source"},400);
      await saveCompanyResearchExposure(env,exposure);return json({saved:true,id:exposure.id,version:exposure.version});
    }
    const company=/^\/admin\/public-research\/companies\/([A-Z0-9.-]{1,12})\/context$/.exec(path);
    if(company&&request.method==="GET")return json(await freezeCompanyResearch(env,company[1]!,new URL(request.url).searchParams.get("asOf")??new Date().toISOString()));
    if(path==="/admin/public-research/runs"&&request.method==="POST"){
      const input=publicResearchRunSchema.parse(await request.json());
      if(Date.parse(input.asOf)>Date.now())return json({error:"Research asOf cannot be in the future"},400);
      // An explicit enrichment already pins its parent, cutoff and dependencies. Replay its immutable admission before live freshness checks.
      if(input.enrichment){
        const admitted=(await db.prepare("SELECT * FROM public_research_runs WHERE report_id=? AND json_extract(params_json,'$.enrichment.sourceRunId')=? AND json_extract(params_json,'$.asOf')=?").bind(input.reportId,input.enrichment.sourceRunId,input.asOf).all<RunRow>()).results;
        const existing=admitted.find(row=>{const prior=publicResearchRunSchema.safeParse(JSON.parse(row.params_json));return prior.success&&stable(prior.data)===stable(input);});
        if(existing)return json({runId:existing.run_id,state:existing.state,version:existing.result_version,reused:true,humanReviewRequired:true},200);
      }
      const models=new Set<string>([...AI_MODELS,...(await listEndpoints(db)).map(e=>e.name)]);
      if(!models.has(input.model))return json({error:"Unknown per-run model"},400);
      if(input.type==="macro"&&input.scope.industryId!==null)return json({error:"Macro scope must not have industryId"},400);
      if(input.type==="industry"&&!input.scope.industryId)return json({error:"Industry scope requires industryId"},400);
      const runner=binding(env);if(!runner)return json({error:"Durable research runner unavailable"},503);
      const frozen=await freezePublicResearchInput(env,input,"pending",await sha256(stable(input)));
      const fingerprint=await sha256(stable({input,filings:frozen.frozenFilings,...(frozen.enrichmentBase?{enrichmentBase:frozen.enrichmentBase}:{})})),runId=`public-${fingerprint.slice(0,40)}`;
      const existing=await db.prepare("SELECT * FROM public_research_runs WHERE report_id=? AND input_fingerprint=?").bind(input.reportId,fingerprint).first<RunRow>();
      if(existing)return json({runId:existing.run_id,state:existing.state,version:existing.result_version,reused:true,humanReviewRequired:input.type!=="macro"},200);
      const spec={...frozen,runId,inputFingerprint:fingerprint},at=new Date().toISOString();
      // Atomic admission: duplicate fingerprints join one logical task; no more than two active operator runs.
      await db.prepare("INSERT OR IGNORE INTO public_research_runs(run_id,report_id,input_fingerprint,state,params_json,max_calls,max_tokens,created_at,updated_at) SELECT ?,?,?,'queued',?,?,?,?,? WHERE (SELECT COUNT(*) FROM public_research_runs WHERE state IN ('queued','running'))<2")
        .bind(runId,input.reportId,fingerprint,JSON.stringify(spec),input.maxCalls,input.maxTokens,at,at).run();
      const admitted=await db.prepare("SELECT run_id FROM public_research_runs WHERE run_id=?").bind(runId).first();
      if(!admitted)return json({error:"Two research runs are already active; no model call started"},409);
      try{await runner.create({id:runId,params:spec});}
      catch(error){if(!/already_exists/.test(String(error))){await db.prepare("UPDATE public_research_runs SET state='failed',error=?,updated_at=? WHERE run_id=?").bind(String(error).slice(0,1000),at,runId).run();throw error;}}
      return json({runId,state:"queued",shadow:input.type!=="macro",humanReviewRequired:input.type!=="macro",maxCalls:input.maxCalls,maxTokens:input.maxTokens},202);
    }
    if(path==="/admin/public-research/runs"&&request.method==="GET")return json((await db.prepare("SELECT run_id,report_id,state,result_version,error,calls_reserved,max_calls,max_tokens,created_at,updated_at FROM public_research_runs ORDER BY created_at DESC LIMIT 40").all()).results);
    const checkpointMatch=/^\/admin\/public-research\/runs\/([^/]+)\/checkpoints\/([^/]+)$/.exec(path);
    if(checkpointMatch){
      if(request.method!=="GET")return json({error:"Method not allowed"},405);
      const runId=z.string().regex(/^public-[a-f0-9]{40}$/).parse(checkpointMatch[1]),stage=publicResearchStageSchema.parse(checkpointMatch[2]);
      const row=await db.prepare("SELECT * FROM public_research_runs WHERE run_id=?").bind(runId).first<RunRow>();
      if(!row)return json({error:"Run not found"},404);
      const identity={runId,reportId:row.report_id,inputFingerprint:row.input_fingerprint};
      const archived=await readPublicResearchCheckpoint(env,identity,stage);
      const metadata={runId,state:row.state,resultVersion:row.result_version,callsReserved:row.calls_reserved,stage,published:false,reviewStatus:"unreviewed",warning:"Storage checkpoint only; it is not an independently approved or published report."};
      if(archived)return json({...metadata,source:"stage-archive",...archived});
      // The legacy path must never poll/settle/resume a task to recover its saved state.
      if(row.state!=="stopped")return json({error:"No archived checkpoint; legacy export requires a stopped run"},409);
      const runner=binding(env);if(!runner)return json({error:"Durable research storage unavailable"},503);
      const stored=await runner.readPublicResearchSession(runId,stage);
      if(!stored)return json({error:"Research stage checkpoint not found"},404);
      if(stored.runId!==runId||stored.status!=="terminated"||stored.session.active||stored.session.kind!=="public-research"||stored.session.operationId!==`${runId}:${stage}`)throw new Error("Stopped research storage identity mismatch");
      const spec=stored.session.spec as {run:PublicResearchRunSpec;stage:string;notes?:unknown[];draft?:unknown;review?:unknown};
      if(spec.stage!==stage||spec.run.runId!==runId||spec.run.reportId!==row.report_id||spec.run.inputFingerprint!==row.input_fingerprint)throw new Error("Research session specification does not match admitted run");
      const state=stored.session.state as Parameters<typeof publicResearchCheckpoint>[2];
      const checkpoint=publicResearchCheckpoint(spec.run,stage,state,spec);
      const {operationId,kind,active,startedAt,turns,spent,capped,finished}=stored.session,session={operationId,kind,active,startedAt,turns,spent,capped,finished};
      return json({...metadata,source:"stopped-session-storage",runnerStatus:stored.status,session,contentHash:await sha256(JSON.stringify(checkpoint)),checkpoint});
    }
    const runMatch=/^\/admin\/public-research\/runs\/([a-zA-Z0-9._:-]+)(?:\/(stop))?$/.exec(path);
    if(runMatch){
      const row=await db.prepare("SELECT * FROM public_research_runs WHERE run_id=?").bind(runMatch[1]).first<RunRow>();if(!row)return json({error:"Run not found"},404);
      if(runMatch[2]==="stop"&&request.method==="POST"){
        await db.prepare("UPDATE public_research_runs SET state='stopped',updated_at=? WHERE run_id=?").bind(new Date().toISOString(),row.run_id).run();
        await (await binding(env)?.get(row.run_id))?.terminate();return json({runId:row.run_id,state:"stopped"});
      }
      if(request.method!=="GET")return json({error:"Method not allowed"},405);
      const usage=await db.prepare("SELECT model,COUNT(*) calls,SUM(input_tokens) input_tokens,SUM(cached_tokens) cached_tokens,SUM(output_tokens) output_tokens,SUM(duration_ms) duration_ms FROM ai_usage WHERE run_id=? GROUP BY model").bind(row.run_id).all();
      const review=await env.SEC_FILINGS.get(`public-research/runs/${row.run_id}/machine-review.json`);
      const draft=row.result_version?await readPublicResearchDraft(env,row.report_id,row.result_version):null;
      return json({...row,params:JSON.parse(row.params_json),params_json:undefined,humanReviewRequired:JSON.parse(row.params_json).type!=="macro",usage:usage.results,machineReview:review?JSON.parse(await review.text()):null,draft,runner:await (await binding(env)?.get(row.run_id))?.report()});
    }
    if(path==="/admin/public-research/reports"&&request.method==="GET")return json(await listPublicResearch(env));
    const report=/^\/admin\/public-research\/reports\/([a-zA-Z0-9._:-]+)(?:\/(review|publish|withdraw|restore|invalidate|revise|operator-complete))?$/.exec(path);
    if(!report)return json({error:"Not found"},404);
    const id=report[1]!,action=report[2];
    if(!action&&request.method==="GET"){
      const version=new URL(request.url).searchParams.get("version");
      return json(version?{draft:await readPublicResearchDraft(env,id,version),published:await readPublicResearch(env,id,{version})}:await readPublicResearch(env,id));
    }
    if(request.method!=="POST")return json({error:"Method not allowed"},405);
    if(action==="operator-complete"){
      const completion=z.object({sourceRunId:z.string().regex(/^public-[a-f0-9]{40}$/),checkpointHash:z.string().regex(/^[a-f0-9]{64}$/),failedRunId:z.string().regex(/^public-[a-f0-9]{40}$/),draft:publicResearchDraftSchema,reason:z.string().trim().min(1).max(8000),operator:z.string().trim().min(1).max(200),sourceChecks:z.array(z.object({sourceId:z.string().min(1),notes:z.string().trim().min(1).max(4000)}))}).strict().parse(await request.json());
      return json(await completeStoppedIndustryDraft(env,id,completion));
    }
    if(action==="revise"){
      const revision=z.object({baseVersion:z.string().regex(/^[a-f0-9]{64}$/),draft:publicResearchDraftSchema,reason:z.string().trim().min(1).max(8000),operator:z.string().trim().min(1).max(200),sourceChecks:z.array(z.object({sourceId:z.string().min(1),notes:z.string().trim().min(1).max(4000)}))}).strict().parse(await request.json());
      return json(await revisePublicResearchDraft(env,id,revision));
    }
    if(action==="invalidate"){
      const event=z.object({version:z.string().regex(/^[a-f0-9]{64}$/),claimIds:z.array(z.string().min(1).max(128)).min(1).max(200),eventId:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),reason:z.string().min(1).max(4000),sourceUrl:z.string().url().refine(value=>["https:","http:"].includes(new URL(value).protocol)),occurredAt:z.string().datetime({offset:true})}).strict().parse(await request.json());
      return json(await invalidatePublicResearchEvent(env,id,event));
    }
    const body=z.object({version:z.string().regex(/^[a-f0-9]{64}$/),review:reviewSchema.optional(),expectedCurrentVersion:z.string().nullable().optional(),reason:z.string().min(1).optional()}).parse(await request.json());
    if(action==="review"){
      if(!body.review)return json({error:"Explicit independent claim-by-claim review required"},400);
      const draft=await readPublicResearchDraft(env,id,body.version);
      if(!draft||draft.authorRunId!==body.review.authorRunId)return json({error:"Review authorRunId does not match this draft"},409);
      await reviewPublicResearch(env,id,body.version,body.review);return json({reviewed:true,reportId:id,version:body.version,mode:body.review.mode});
    }
    if(action==="publish"){
      if(body.expectedCurrentVersion===undefined)return json({error:"Explicit expectedCurrentVersion (or null) required"},400);
      return json(await publishPublicResearch(env,id,body.version,body.expectedCurrentVersion));
    }
    if(action==="withdraw"){if(!body.reason)return json({error:"Withdrawal reason required"},400);await withdrawPublicResearch(env,id,body.version,body.reason);return json({withdrawn:true});}
    if(action==="restore"){await restorePublicResearch(env,id,body.version);return json({restored:true});}
    return json({error:"Not found"},404);
  }catch(error){return json({error:error instanceof Error?error.message:String(error)},400);}
}
