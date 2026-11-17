import type { PublicResearchDraft, PublicReportVersion, PublicReportSummary, PublicResearchList, PublicResearchRead, ResearchReview, ResearchFreshness } from "../../../../shared/analysis-contract/public-research.ts";
import { publicResearchDraftSchema } from "../../../../shared/analysis-runtime/public-research-schema.ts";
import { validatePublicResearch, validatePublicResearchDraft, publicReportSummary, researchFreshness, publicClaimUsable } from "../../../../shared/analysis-runtime/public-research.ts";
import { sha256 } from "../sha256.ts";
import type { AnalysisEnv } from "../operations.ts";
import type { PublicResearchRunSpec } from "./generation.ts";
import { withRuns } from "../durable-runs/binding.ts";
import { readStoppedPublicResearchCheckpoint, savePublicResearchCheckpoint } from "./checkpoint.ts";

export type PublicResearchEnv = { DB?: D1Database; SEC_FILINGS: { get(key: string): Promise<{ text(): Promise<string> } | null>; put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown> } };
type VersionRow = { report_id: string; version: string; r2_key: string; state: string; as_of: string; generated_at: string; published_at: string | null; supersedes: string | null; review_json: string | null; summary_json: string; freshness?: ResearchFreshness };
const database = (env: PublicResearchEnv) => { if (!env.DB) throw new Error("Public research storage unavailable"); return env.DB; };
const stable = (value: unknown): string => JSON.stringify(value, (_key, val) => val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a],[b]) => a.localeCompare(b))) : val);
const escape = (s: string) => s.replace(/[\\`*_[\]<>]/g, "\\$&");
/** The agent chooses sections and writes claims; the harness binds citations/observations from that same data. */
export function renderPublicResearch(report: PublicResearchDraft): string {
  const zh = report.language === "zh-CN";
  const claims = new Map(report.claims.map(claim => [claim.id, claim]));
  const observations = new Map(report.observations.map(observation => [observation.id, observation]));
  const sources = new Map(report.sources.map(source => [source.id, source]));
  // The reader owns the report header, change list and missing-input state once.
  const out: string[] = [];
  for (const section of report.sections) {
    out.push("", `## ${section.title}`);
    for (const id of section.claimIds) {
      const claim = claims.get(id)!;
      out.push("", `### ${claim.title}`, "", `${zh ? ({ fact: "事实", inference: "推断", scenario: "情景" } as const)[claim.kind] : claim.kind}: ${claim.statement}`);
      for (const obsId of claim.observationIds) { const obs = observations.get(obsId)!; out.push("", `- ${escape(obs.label)}: ${obs.value === null ? (obs.missingReason ?? obs.status) : `${obs.value} ${escape(obs.unit)}`} (${obs.period.start}–${obs.period.end}; ${escape(obs.definition)})`); }
      if (claim.assumptions.length) out.push("", `**${zh ? "假设" : "Assumptions"}**`, ...claim.assumptions.map(a => `- ${a}`));
      out.push("", `**${zh ? "传导" : "Transmission"}**`, ...claim.impactChannels.map(a => `- ${a}`), "", `**${zh ? "反证与不确定性" : "Counter-evidence and uncertainty"}**`, ...claim.counterEvidence.map(a => `- ${a}`), "", `**${zh ? "验证节点" : "Verification"}**: ${claim.verification}`, "", claim.sourceIds.map(sourceId => { const source = sources.get(sourceId)!; return `[${escape(source.title)} · ${escape(source.locator)}](${source.uri})`; }).join(" · "));
    }
  }
  out.push("", `## ${zh ? "情景条件" : "Scenario conditions"}`);
  for (const scenario of report.scenarios) out.push("", `### ${zh ? ({downside:"下行情景",base:"基准情景",upside:"上行情景"} as const)[scenario.name] : scenario.name}`, ...scenario.assumptions.map(a => `- ${a}`));
  return out.join("\n");
}

export async function savePublicResearchDraft(env: PublicResearchEnv, input: PublicResearchDraft): Promise<{ version: string }> {
  return saveDraftWithAudit(env,input,[]);
}
async function saveDraftWithAudit(env:PublicResearchEnv,input:PublicResearchDraft,audit:D1PreparedStatement[]):Promise<{version:string}>{
  const draft = publicResearchDraftSchema.parse(input);
  const db = database(env), version = await sha256(stable(draft));
  const identity=await db.prepare("SELECT report_type,industry_id FROM public_research_reports WHERE report_id=?").bind(draft.reportId).first<{report_type:string;industry_id:string|null}>();
  if(identity && (identity.report_type!==draft.type || identity.industry_id!==draft.scope.industryId))throw new Error("Report identity cannot switch type or industry; use a new report ID");
  for (const source of draft.sources) if (await sha256(source.excerpt) !== source.contentHash) throw new Error(`Source snapshot hash mismatch: ${source.id}`);
  const key = `public-research/${draft.reportId}/${version}.json`;
  // Content-addressed immutable object first. A failed index write can only leave an unreferenced complete body.
  await env.SEC_FILINGS.put(key, JSON.stringify(draft), { httpMetadata: { contentType: "application/json" } });
  const summary = { reportId: draft.reportId, version, type: draft.type, title: draft.title, language: draft.language, scope: draft.scope, asOf: draft.asOf, publishedAt: "", freshnessStatus: "unavailable", coverage: draft.coverage, summary: draft.summary, changes: draft.changes };
  await db.batch([
    ...audit,
    db.prepare("INSERT INTO public_research_reports(report_id,report_type,industry_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(report_id) DO NOTHING").bind(draft.reportId,draft.type,draft.scope.industryId,draft.generatedAt),
    db.prepare("INSERT INTO public_research_versions(report_id,version,input_fingerprint,r2_key,state,as_of,generated_at,valid_until,summary_json) VALUES(?,?,?,?,'draft',?,?,?,?) ON CONFLICT(report_id,version) DO NOTHING").bind(draft.reportId,version,draft.inputFingerprint,key,draft.asOf,draft.generatedAt,draft.validUntil,JSON.stringify(summary)),
    ...draft.claims.map(claim=>db.prepare("INSERT OR IGNORE INTO public_research_claims(report_id,version,claim_id) VALUES(?,?,?)").bind(draft.reportId,version,claim.id)),
  ]);
  return { version };
}
/** Explicit operator correction creates a new unreviewed immutable draft, never a publication. */
export async function revisePublicResearchDraft(env:PublicResearchEnv,reportId:string,input:{baseVersion:string;draft:PublicResearchDraft;reason:string;operator:string;sourceChecks:Array<{sourceId:string;notes:string}>}){
  const db=database(env),draft=validatePublicResearchDraft(input.draft,new Date().toISOString());
  const base=await readPublicResearchDraft(env,reportId,input.baseVersion);
  if(!base)throw new Error("Revision base draft not found");
  for(const key of ["reportId","type","scope","asOf","language","authorRunId","inputFingerprint","modelVersion","promptVersion","toolVersion","generatedAt","validUntil","dependencies"] as const){
    if(stable(draft[key])!==stable(base[key]))throw new Error(`Revision cannot change provenance field: ${key}`);
  }
  if(draft.reportId!==reportId)throw new Error("Revision report identity mismatch");
  if(!input.operator.trim()||!input.reason.trim())throw new Error("Operator identity and correction reason required");
  if(input.sourceChecks.length!==draft.sources.length||draft.sources.some(source=>input.sourceChecks.filter(check=>check.sourceId===source.id&&check.notes.trim()).length!==1))throw new Error("Operator source audit must cover every corrected draft source exactly once");
  const version=await sha256(stable(draft)),requestHash=await sha256(stable({...input,draft:version,sourceChecks:[...input.sourceChecks].sort((a,b)=>a.sourceId.localeCompare(b.sourceId))}));
  if(version===input.baseVersion)throw new Error("Revision must change the draft content");
  const prior=await db.prepare("SELECT request_hash,receipt_json FROM public_research_revisions WHERE report_id=? AND base_version=?").bind(reportId,input.baseVersion).first<{request_hash:string;receipt_json:string}>();
  if(prior){if(prior.request_hash!==requestHash)throw new Error("Base version already revised; use the exact returned revision as the next base");return JSON.parse(prior.receipt_json);}
  if(await db.prepare("SELECT version FROM public_research_versions WHERE report_id=? AND version=?").bind(reportId,version).first())throw new Error("Revision content already exists; its review state cannot be reused by this correction");
  const receipt={reportId,baseVersion:input.baseVersion,version,operator:input.operator,reason:input.reason,sourceChecks:input.sourceChecks,revisedAt:new Date().toISOString(),state:"draft",humanReviewRequired:draft.type!=="macro"};
  await saveDraftWithAudit(env,draft,[db.prepare("INSERT INTO public_research_revisions(report_id,base_version,version,request_hash,receipt_json) VALUES(?,?,?,?,?) ON CONFLICT(report_id,base_version) DO UPDATE SET request_hash=CASE WHEN request_hash=excluded.request_hash THEN request_hash ELSE NULL END").bind(reportId,input.baseVersion,version,requestHash,JSON.stringify(receipt))]);
  const saved=await db.prepare("SELECT receipt_json FROM public_research_revisions WHERE report_id=? AND base_version=?").bind(reportId,input.baseVersion).first<{receipt_json:string}>();
  return JSON.parse(saved!.receipt_json);
}

/** External completion preserves the stopped/failed runs and creates only a separately authored, unreviewed industry draft. */
export async function completeStoppedIndustryDraft(env:AnalysisEnv,reportId:string,input:{sourceRunId:string;checkpointHash:string;failedRunId:string;draft:PublicResearchDraft;reason:string;operator:string;sourceChecks:Array<{sourceId:string;notes:string}>}){
  const db=database(env),at=new Date().toISOString(),draft=validatePublicResearchDraft(input.draft,at);
  if(draft.reportId!==reportId||draft.type!=="industry")throw new Error("Operator completion accepts only the same industry report");
  if(!input.operator.trim()||!input.reason.trim())throw new Error("Operator identity and completion reason required");
  if(input.sourceChecks.length!==draft.sources.length||draft.sources.some(source=>input.sourceChecks.filter(check=>check.sourceId===source.id&&check.notes.trim()).length!==1))throw new Error("Operator source audit must cover every completed draft source exactly once");
  if(!/^operator-[A-Za-z0-9._:-]+$/.test(draft.authorRunId)||!/^operator-completion\.[A-Za-z0-9._:-]+$/.test(draft.promptVersion))throw new Error("External author and operator-completion prompt provenance required");
  const version=await sha256(stable(draft)),requestHash=await sha256(stable({...input,draft:version,sourceChecks:[...input.sourceChecks].sort((a,b)=>a.sourceId.localeCompare(b.sourceId))}));
  const prior=await db.prepare("SELECT request_hash,receipt_json FROM public_research_revisions WHERE report_id=? AND base_version=?").bind(reportId,input.checkpointHash).first<{request_hash:string;receipt_json:string}>();
  if(prior){if(prior.request_hash!==requestHash)throw new Error("Checkpoint already completed; revise the exact returned version for further changes");return JSON.parse(prior.receipt_json);}
  type CompletionRun={run_id:string;report_id:string;input_fingerprint:string;state:string;params_json:string;result_version:string|null};
  const source=await db.prepare("SELECT * FROM public_research_runs WHERE run_id=?").bind(input.sourceRunId).first<CompletionRun>();
  const failed=await db.prepare("SELECT * FROM public_research_runs WHERE run_id=?").bind(input.failedRunId).first<CompletionRun>();
  if(!source||source.report_id!==reportId||source.state!=="stopped"||source.result_version)throw new Error("Completion requires the exact stopped source run without a final version");
  if(!failed||failed.report_id!==reportId||!["failed","review_failed"].includes(failed.state)||failed.result_version)throw new Error("Completion requires a failed enrichment without a final version");
  const original=JSON.parse(source.params_json) as PublicResearchRunSpec,attempt=JSON.parse(failed.params_json) as PublicResearchRunSpec;
  for(const [row,spec] of [[source,original],[failed,attempt]] as const){
    if(spec.runId!==row.run_id||spec.reportId!==reportId||spec.inputFingerprint!==row.input_fingerprint||spec.type!=="industry")throw new Error("Industry run admission identity mismatch");
    if(stable(draft.scope)!==stable(spec.scope)||draft.language!==spec.language)throw new Error("Completion must preserve industry scope and language");
    if(Date.parse(draft.asOf)<Date.parse(spec.asOf))throw new Error("Completion cannot backdate the admitted research cutoff");
  }
  if(original.enrichment||attempt.enrichment?.sourceRunId!==input.sourceRunId||!("checkpointHash" in attempt.enrichment)||attempt.enrichment.checkpointHash!==input.checkpointHash||attempt.enrichmentBase?.checkpointHash!==input.checkpointHash)throw new Error("Failed enrichment does not match the original synthesis checkpoint");
  if(draft.inputFingerprint===source.input_fingerprint||draft.inputFingerprint===failed.input_fingerprint||draft.authorRunId===input.sourceRunId||draft.authorRunId===input.failedRunId)throw new Error("Completion requires an independent author and input fingerprint");
  if(await db.prepare("SELECT 1 FROM public_research_runs WHERE report_id=? AND state IN ('queued','running')").bind(reportId).first())throw new Error("Research for this report is still active");
  if(await db.prepare("SELECT 1 FROM public_research_versions WHERE report_id=? AND input_fingerprint=?").bind(reportId,failed.input_fingerprint).first())throw new Error("Failed enrichment already has a saved draft");
  if(await db.prepare("SELECT 1 FROM public_research_versions WHERE report_id=? AND (version=? OR input_fingerprint=?)").bind(reportId,version,draft.inputFingerprint).first())throw new Error("Completion identity already exists; its review state cannot be reused");
  const runner=(withRuns(env) as AnalysisEnv & {PUBLIC_RESEARCH_WORKFLOW?:Parameters<typeof readStoppedPublicResearchCheckpoint>[3]}).PUBLIC_RESEARCH_WORKFLOW;
  if(!runner)throw new Error("Stopped research storage unavailable");
  const archived=await readStoppedPublicResearchCheckpoint(env,{runId:source.run_id,reportId,inputFingerprint:source.input_fingerprint},"synthesis",runner);
  if(!archived||archived.contentHash!==input.checkpointHash||!archived.checkpoint.stageSubmitted||!archived.checkpoint.draft)throw new Error("Exact complete submitted synthesis checkpoint required");
  const base=archived.checkpoint.draft;
  if(base.type!=="industry"||stable(base.scope)!==stable(draft.scope)||base.language!==draft.language||archived.checkpoint.asOf!==original.asOf||archived.checkpoint.runStartedAt!==original.startedAt)throw new Error("Stopped synthesis scope or time identity mismatch");
  if(!draft.dependencies.length||new Set(draft.dependencies.map(dep=>stable({reportId:dep.reportId,version:dep.version,claimId:dep.claimId}))).size!==draft.dependencies.length)throw new Error("Completion requires distinct frozen macro dependencies");
  for(const dependency of draft.dependencies){
    if(!attempt.dependencies.some(dep=>dep.reportId===dependency.reportId&&dep.version===dependency.version&&dep.claimId===dependency.claimId))throw new Error("Completion dependency was not frozen in the failed enrichment");
    const read=await readPublicResearch(env,dependency.reportId,{version:dependency.version,asOf:draft.asOf}),current=await readPublicResearch(env,dependency.reportId,{version:dependency.version});
    if(!read.report||read.report.type!=="macro"||!publicClaimUsable(read.report,dependency.claimId)||!current.report||!publicClaimUsable(current.report,dependency.claimId)||Date.parse(read.report.publishedAt)>Date.parse(draft.asOf)||Date.parse(read.report.asOf)>Date.parse(draft.asOf))throw new Error("Exact published and valid macro dependency required");
  }
  const checkpoint=archived.key?{key:archived.key}:await savePublicResearchCheckpoint(env,archived.checkpoint);
  const receipt={reportId,baseVersion:input.checkpointHash,version,sourceKind:"stopped-industry-operator-completion",sourceRunId:input.sourceRunId,failedRunId:input.failedRunId,checkpointHash:input.checkpointHash,checkpointKey:checkpoint.key,originalInputFingerprint:source.input_fingerprint,failedInputFingerprint:failed.input_fingerprint,authorRunId:draft.authorRunId,modelVersion:draft.modelVersion,promptVersion:draft.promptVersion,operator:input.operator,reason:input.reason,sourceChecks:input.sourceChecks,completedAt:at,state:"draft",humanReviewRequired:true,externalAssistedCompletion:true};
  // The immutable R2 body precedes one D1 transaction for the audit and draft index; a rejected transaction cannot expose it.
  // Recheck run/identity races in the transaction. Exact concurrent replays keep the first receipt and existing review state.
  const audit=db.prepare(`INSERT INTO public_research_revisions(report_id,base_version,version,request_hash,receipt_json) VALUES(?,?,?,CASE WHEN
    EXISTS(SELECT 1 FROM public_research_revisions WHERE report_id=? AND base_version=? AND request_hash=? AND version=?) OR (
      EXISTS(SELECT 1 FROM public_research_runs WHERE run_id=? AND report_id=? AND state='stopped' AND result_version IS NULL AND params_json=?) AND
      EXISTS(SELECT 1 FROM public_research_runs WHERE run_id=? AND report_id=? AND state=? AND result_version IS NULL AND params_json=?) AND
      NOT EXISTS(SELECT 1 FROM public_research_runs WHERE report_id=? AND state IN ('queued','running')) AND
      NOT EXISTS(SELECT 1 FROM public_research_versions WHERE report_id=? AND (version=? OR input_fingerprint IN (?,?)))
    ) THEN ? ELSE NULL END,?) ON CONFLICT(report_id,base_version) DO UPDATE SET request_hash=CASE WHEN request_hash=excluded.request_hash THEN request_hash ELSE NULL END`)
    .bind(reportId,input.checkpointHash,version,reportId,input.checkpointHash,requestHash,version,source.run_id,reportId,source.params_json,failed.run_id,reportId,failed.state,failed.params_json,reportId,reportId,version,draft.inputFingerprint,failed.input_fingerprint,requestHash,JSON.stringify(receipt));
  await saveDraftWithAudit(env,draft,[audit]);
  const saved=await db.prepare("SELECT receipt_json FROM public_research_revisions WHERE report_id=? AND base_version=?").bind(reportId,input.checkpointHash).first<{receipt_json:string}>();
  return JSON.parse(saved!.receipt_json);
}

export async function readPublicResearchDraft(env: PublicResearchEnv, reportId: string, version: string): Promise<PublicResearchDraft | null> {
  const row = await database(env).prepare("SELECT r2_key FROM public_research_versions WHERE report_id=? AND version=?").bind(reportId,version).first<{r2_key:string}>();
  const body = row ? await env.SEC_FILINGS.get(row.r2_key) : null;
  if (!body) return null;
  const draft = publicResearchDraftSchema.parse(JSON.parse(await body.text()));
  if (await sha256(stable(draft)) !== version) throw new Error("Public research body integrity mismatch");
  return draft;
}
export async function reviewPublicResearch(env: PublicResearchEnv, reportId: string, version: string, review: ResearchReview, now = new Date().toISOString()): Promise<void> {
  const draft = await readPublicResearchDraft(env,reportId,version);
  if (!draft) throw new Error("Public research draft body missing");
  review={...review,mode:review.mode??"human"};
  if(review.mode==="automatic"&&draft.type!=="macro")throw new Error("Automatic review is permitted only for macro reports");
  if(review.conclusion==='rejected'){
    if(!review.reviewer.trim() || review.reviewer===draft.authorRunId || review.authorRunId!==draft.authorRunId || !review.notes.trim())throw new Error("Independent rejection record required");
    await database(env).prepare("UPDATE public_research_versions SET state='failed',review_json=?,error=? WHERE report_id=? AND version=? AND state IN ('draft','reviewing','reviewed')").bind(JSON.stringify(review),review.notes,reportId,version).run();
    return;
  }
  validatePublicResearch(draft,review,now);
  await database(env).prepare("UPDATE public_research_versions SET state='reviewed' ,review_json=? WHERE report_id=? AND version=? AND state IN ('draft','reviewing','reviewed')").bind(JSON.stringify(review),reportId,version).run();
}
export async function publishPublicResearch(env: PublicResearchEnv, reportId: string, version: string, expectedCurrentVersion: string | null, now = new Date().toISOString()): Promise<PublicReportVersion> {
  const db=database(env), row=await db.prepare("SELECT * FROM public_research_versions WHERE report_id=? AND version=?").bind(reportId,version).first<VersionRow>();
  if (!row || !row.review_json || !["reviewed","published"].includes(row.state)) throw new Error("Independent review required before publication");
  const draft=await readPublicResearchDraft(env,reportId,version);
  if (!draft) throw new Error("Publication body missing");
  const review=JSON.parse(row.review_json) as ResearchReview;
  validatePublicResearch(draft,review,now);
  for (const dependency of draft.dependencies) {
    const source=await readPublicResearch(env,dependency.reportId,{version:dependency.version,asOf:draft.asOf});
    if (!source.report || source.status!=="available" || !publicClaimUsable(source.report,dependency.claimId)) throw new Error("Unavailable or invalid public research dependency");
    if(await db.prepare("SELECT 1 FROM public_research_claim_invalidations WHERE report_id=? AND version=? AND claim_id=?").bind(dependency.reportId,dependency.version,dependency.claimId).first())throw new Error("Dependency changed after research began");
    if (source.report.type !== "macro" || draft.type !== "industry") throw new Error("Public dependency must flow macro → industry");
  }
  const previous=expectedCurrentVersion ? await readPublicResearchDraft(env,reportId,expectedCurrentVersion) : null;
  const changed=previous ? changedPublicClaims(previous,draft) : [];
  const statements = [
    db.prepare("UPDATE public_research_reports SET current_version=?,freshness='valid',updated_at=? WHERE report_id=? AND current_version IS ?").bind(version,now,reportId,expectedCurrentVersion),
    db.prepare("UPDATE public_research_versions SET state='published',published_at=COALESCE(published_at,?),supersedes=COALESCE(supersedes,?) WHERE report_id=? AND version=? AND EXISTS(SELECT 1 FROM public_research_reports WHERE report_id=? AND current_version=?)").bind(now,expectedCurrentVersion,reportId,version,reportId,version),
    ...publicResearchAdoptionStatements(db,`${reportId}:${version}`,draft.dependencies),
    ...invalidationStatements(db,reportId,expectedCurrentVersion??"",changed,version),
    ...draft.dependencies.flatMap(dep=>dep.ownerClaimIds.map(ownerClaimId=>db.prepare("INSERT OR IGNORE INTO public_research_dependencies(owner_id,owner_version,source_report_id,source_version,claim_id,owner_claim_id) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM public_research_reports WHERE report_id=? AND current_version=?)").bind(reportId,version,dep.reportId,dep.version,dep.claimId,ownerClaimId,reportId,version))),
  ];
  const result=await db.batch(statements);
  if (!result[0].meta.changes) {
    const current=await db.prepare("SELECT current_version FROM public_research_reports WHERE report_id=?").bind(reportId).first<{current_version:string}>();
    if(current?.current_version!==version) throw new Error("Publication conflict: current version changed; review and retry explicitly");
  }
  const read=await readPublicResearch(env,reportId,{version});
  if(!read.report) throw new Error("Published report unreadable");
  return read.report;
}

async function materializePublished(env: PublicResearchEnv, row: VersionRow, now: string): Promise<PublicReportVersion | null> {
  const draft=await readPublicResearchDraft(env,row.report_id,row.version);
  if(!draft || !row.published_at || !row.review_json) return null;
  const invalid=await database(env).prepare("SELECT claim_id FROM public_research_claim_invalidations WHERE report_id=? AND version=?").bind(row.report_id,row.version).all<{claim_id:string}>();
  const invalidIds=new Set(invalid.results.map(item=>item.claim_id));
  const report: PublicReportVersion={...draft,version:row.version,publishedAt:row.published_at,supersedes:row.supersedes,freshnessStatus:row.state==='withdrawn'?'unavailable':row.freshness??'valid',review:{mode:"human",...JSON.parse(row.review_json)} as ResearchReview,claimStates:Object.fromEntries(draft.claims.map(claim=>[claim.id,invalidIds.has(claim.id)?"review_required":"valid"])),bodyMarkdown:renderPublicResearch(draft)};
  for(const dependency of draft.dependencies){
    const upstream=await readPublicResearch(env,dependency.reportId,{version:dependency.version,asOf:now});
    if(!upstream.report||!publicClaimUsable(upstream.report,dependency.claimId))for(const ownerClaimId of dependency.ownerClaimIds)report.claimStates[ownerClaimId]="review_required";
  }
  report.freshnessStatus=researchFreshness(report,now);
  if(Object.values(report.claimStates).some(state=>state!=="valid") && ["valid","updating"].includes(report.freshnessStatus))report.freshnessStatus="review_required";
  if(["stale","unavailable"].includes(report.freshnessStatus))report.claimStates=Object.fromEntries(draft.claims.map(claim=>[claim.id,"unavailable"]));
  return report;
}
export async function readPublicResearch(env: PublicResearchEnv, reportId: string, options: {version?:string;asOf?:string}={}): Promise<PublicResearchRead> {
  if(!env.DB) return {status:"unavailable",report:null,history:[],reason:"storage_unavailable"};
  const now=options.asOf ? new Date(options.asOf).toISOString() : new Date().toISOString();
  const rows=await env.DB.prepare("SELECT v.*,CASE WHEN r.current_version=v.version THEN r.freshness ELSE 'valid' END freshness FROM public_research_versions v JOIN public_research_reports r ON r.report_id=v.report_id WHERE v.report_id=? AND v.published_at IS NOT NULL AND v.published_at<=? ORDER BY v.published_at DESC,(v.version=r.current_version) DESC,v.rowid DESC").bind(reportId,now).all<VersionRow>();
  const history:PublicReportSummary[]=rows.results.map(row=>({...JSON.parse(row.summary_json),publishedAt:row.published_at,freshnessStatus:row.state==='withdrawn'?'unavailable':row.freshness??'valid'}));
  let row:VersionRow|undefined;
  if(options.version) row=rows.results.find(row=>row.version===options.version);
  else if(options.asOf) row=rows.results.find(row=>row.state!=='withdrawn');
  else { const current=await env.DB.prepare("SELECT current_version FROM public_research_reports WHERE report_id=?").bind(reportId).first<{current_version:string|null}>(); row=rows.results.find(row=>row.version===current?.current_version); }
  if(!row) return {status:"unavailable",report:null,history,reason:"not_published"};
  if(row.state==='withdrawn') return {status:"withdrawn",report:null,history,reason:"withdrawn"};
  const report=await materializePublished(env,row,now);
  return report?{status:"available",report,history}:{status:"unavailable",report:null,history,reason:"body_missing"};
}
export async function listPublicResearch(env:PublicResearchEnv,options:{type?:'macro'|'industry';industryId?:string;asOf?:string}={}):Promise<PublicResearchList>{
  if(!env.DB)return {status:"unavailable",reports:[],reason:"storage_unavailable"};
  const rows=await env.DB.prepare("SELECT report_id,current_version FROM public_research_reports WHERE (? IS NULL OR report_type=?) AND (? IS NULL OR industry_id=?) ORDER BY updated_at DESC").bind(options.type??null,options.type??null,options.industryId??null,options.industryId??null).all<{report_id:string;current_version:string|null}>();
  const reports:PublicReportSummary[]=[];
  for(const row of rows.results){const read=await readPublicResearch(env,row.report_id,{asOf:options.asOf});if(read.report)reports.push(publicReportSummary(read.report));else if(read.status==='withdrawn'){const current=read.history.find(item=>item.version===row.current_version);if(current)reports.push({...current,freshnessStatus:'unavailable'});}}
  return {status:"ready",reports};
}
export async function setPublicResearchFreshness(env:PublicResearchEnv,reportId:string,freshness:ResearchFreshness):Promise<void>{
  const db=database(env),current=await readPublicResearch(env,reportId);
  const invalidate=current.report && ["review_required","stale","unavailable"].includes(freshness) ? invalidationStatements(db,reportId,current.report.version,current.report.claims.map(claim=>claim.id)) : [];
  await db.batch([db.prepare("UPDATE public_research_reports SET freshness=?,updated_at=? WHERE report_id=?").bind(freshness,new Date().toISOString(),reportId),...invalidate]);
}
export async function withdrawPublicResearch(env:PublicResearchEnv,reportId:string,version:string,reason:string):Promise<void>{
  if(!reason.trim())throw new Error("Withdrawal reason required");
  const body=await readPublicResearchDraft(env,reportId,version);
  const db=database(env);await db.batch([
    ...invalidationStatements(db,reportId,version,body?.claims.map(claim=>claim.id)??[]),
    db.prepare("UPDATE public_research_versions SET state='withdrawn',error=? WHERE report_id=? AND version=?").bind(reason,reportId,version),
    db.prepare("UPDATE public_research_reports SET freshness='unavailable',updated_at=? WHERE report_id=? AND current_version=?").bind(new Date().toISOString(),reportId,version),
    db.prepare("UPDATE public_research_dependencies SET status='review_required' WHERE source_report_id=? AND source_version=?").bind(reportId,version),
    db.prepare("UPDATE public_research_reports SET freshness='review_required' WHERE report_id IN (SELECT owner_id FROM public_research_dependencies WHERE source_report_id=? AND source_version=?)").bind(reportId,version),
  ]);
}
/** Rollback only to a complete reviewed publication. Withdrawal remains visible in immutable history. */
export async function restorePublicResearch(env:PublicResearchEnv,reportId:string,version:string):Promise<void>{
  const read=await readPublicResearch(env,reportId,{version});if(!read.report || read.status!=='available')throw new Error("Rollback target is not a complete published version");
  for(const dependency of read.report.dependencies){const source=await readPublicResearch(env,dependency.reportId,{version:dependency.version});if(!source.report||!publicClaimUsable(source.report,dependency.claimId))throw new Error("Rollback dependency unavailable; retain review-required state");}
  await database(env).prepare("UPDATE public_research_reports SET current_version=?,freshness=?,updated_at=? WHERE report_id=?").bind(version,researchFreshness(read.report,new Date().toISOString()),new Date().toISOString(),reportId).run();
}

/** Material changes invalidate only adopted claims; presentation-only changes leave downstream work reusable. */
export function changedPublicClaims(previous:PublicResearchDraft,next:PublicResearchDraft):string[]{
  const normalize=(value:unknown):unknown=>typeof value==='string'?value.replace(/\s+/g,' ').trim().replace(/[，。；！？,;!?]/g,'').replace(/\.$/,''):Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalize(item)])):value;
  const signature=(report:PublicResearchDraft,claim:PublicResearchDraft['claims'][number])=>stable(normalize({claim,observations:report.observations.filter(observation=>claim.observationIds.includes(observation.id)),sources:report.sources.filter(source=>claim.sourceIds.includes(source.id)).map(({id,canonicalId,revision,excerpt,contentHash,availableAt,observationPeriod})=>({id,canonicalId,revision,excerpt,contentHash,availableAt,observationPeriod}))}));
  return previous.claims.filter(claim=>{const current=next.claims.find(item=>item.id===claim.id);return !current||signature(previous,claim)!==signature(next,current);}).map(claim=>claim.id);
}
export async function invalidatePublicClaims(env:PublicResearchEnv,reportId:string,version:string,claimIds:string[]):Promise<{affectedCompanies:string[]}>{
  if(!claimIds.length)return {affectedCompanies:[]};
  const db=database(env),affectedCompanies=await affectedPublicResearchCompanies(db,reportId,version,claimIds);
  await db.batch(invalidationStatements(db,reportId,version,claimIds));
  return {affectedCompanies};
}
async function affectedPublicResearchCompanies(db:D1Database,reportId:string,version:string,claimIds:string[]):Promise<string[]>{
  const placeholders=claimIds.map(()=>'?').join(',');
  const cte=`WITH RECURSIVE affected(owner_id,owner_version,owner_claim_id) AS (
    SELECT owner_id,owner_version,owner_claim_id FROM public_research_dependencies WHERE source_report_id=? AND source_version=? AND claim_id IN (${placeholders})
    UNION SELECT d.owner_id,d.owner_version,d.owner_claim_id FROM public_research_dependencies d JOIN affected a ON d.source_report_id=a.owner_id AND d.source_version=a.owner_version AND (a.owner_claim_id='*' OR d.claim_id=a.owner_claim_id)
  )`;
  const values=[reportId,version,...claimIds];
  const affected=await db.prepare(`${cte} SELECT DISTINCT d.ticker FROM public_research_dependencies d JOIN affected a ON d.owner_id=a.owner_id AND d.owner_version=a.owner_version WHERE d.ticker IS NOT NULL ORDER BY d.ticker`).bind(...values).all<{ticker:string}>();
  return affected.results.map(row=>row.ticker);
}

/** Manual authenticated operator event; publication and generation are deliberately not triggered. */
export async function invalidatePublicResearchEvent(env:PublicResearchEnv,reportId:string,input:{version:string;claimIds:string[];eventId:string;reason:string;sourceUrl:string;occurredAt:string}){
  const db=database(env), normalized={...input,claimIds:[...new Set(input.claimIds)].sort(),occurredAt:new Date(input.occurredAt).toISOString(),reportId};
  if(!normalized.claimIds.length||Date.parse(normalized.occurredAt)>Date.now())throw new Error("Invalid event claims or future occurredAt");
  const fingerprint=await sha256(stable(normalized));
  const prior=await db.prepare("SELECT payload_hash,receipt_json FROM public_research_events WHERE event_id=?").bind(input.eventId).first<{payload_hash:string;receipt_json:string}>();
  if(prior){if(prior.payload_hash!==fingerprint)throw new Error("Event ID already belongs to a different payload");return JSON.parse(prior.receipt_json);}
  const published=await db.prepare("SELECT published_at FROM public_research_versions WHERE report_id=? AND version=?").bind(reportId,input.version).first<{published_at:string|null}>();
  const draft=await readPublicResearchDraft(env,reportId,input.version);
  if(!published?.published_at||!draft)throw new Error("Event requires an existing published report version");
  if(normalized.claimIds.some(id=>!draft.claims.some(claim=>claim.id===id)))throw new Error("Unknown event claim");
  const affectedCompanies=await affectedPublicResearchCompanies(db,reportId,input.version,normalized.claimIds);
  const receipt={...normalized,affectedCompanies,receivedAt:new Date().toISOString(),mode:"manual_operator",status:"invalidated"};
  // A conflicting concurrent event ID violates NOT NULL and rolls back the entire batch.
  await db.batch([
    db.prepare("INSERT INTO public_research_events(event_id,payload_hash,receipt_json) VALUES(?,?,?) ON CONFLICT(event_id) DO UPDATE SET payload_hash=CASE WHEN payload_hash=excluded.payload_hash THEN payload_hash ELSE NULL END").bind(input.eventId,fingerprint,JSON.stringify(receipt)),
    ...invalidationStatements(db,reportId,input.version,normalized.claimIds),
  ]);
  const saved=await db.prepare("SELECT receipt_json FROM public_research_events WHERE event_id=?").bind(input.eventId).first<{receipt_json:string}>();
  return JSON.parse(saved!.receipt_json);
}

function invalidationStatements(db:D1Database,reportId:string,version:string,claimIds:string[],onlyIfCurrent?:string):D1PreparedStatement[]{
  if(!claimIds.length)return [];
  const placeholders=claimIds.map(()=>'?').join(',');
  const cte=`WITH RECURSIVE affected(owner_id,owner_version,owner_claim_id) AS (
    SELECT owner_id,owner_version,owner_claim_id FROM public_research_dependencies WHERE source_report_id=? AND source_version=? AND claim_id IN (${placeholders})
    ${onlyIfCurrent ? 'AND EXISTS(SELECT 1 FROM public_research_reports WHERE report_id=? AND current_version=?)' : ''}
    UNION SELECT d.owner_id,d.owner_version,d.owner_claim_id FROM public_research_dependencies d JOIN affected a ON d.source_report_id=a.owner_id AND d.source_version=a.owner_version AND (a.owner_claim_id='*' OR d.claim_id=a.owner_claim_id)
  )`;
  const values=[reportId,version,...claimIds,...(onlyIfCurrent?[reportId,onlyIfCurrent]:[])];
  return [
    ...claimIds.map(claimId=>db.prepare(`INSERT OR IGNORE INTO public_research_claim_invalidations(report_id,version,claim_id) SELECT ?,?,? ${onlyIfCurrent ? 'WHERE EXISTS(SELECT 1 FROM public_research_reports WHERE report_id=? AND current_version=?)' : ''}`).bind(reportId,version,claimId,...(onlyIfCurrent?[reportId,onlyIfCurrent]:[]))),
    db.prepare(`${cte} INSERT OR IGNORE INTO public_research_claim_invalidations(report_id,version,claim_id) SELECT c.report_id,c.version,c.claim_id FROM public_research_claims c JOIN affected a ON c.report_id=a.owner_id AND c.version=a.owner_version AND (a.owner_claim_id='*' OR c.claim_id=a.owner_claim_id)`).bind(...values),
    db.prepare(`${cte} UPDATE public_research_dependencies SET status='review_required' WHERE (owner_id,owner_version,owner_claim_id) IN (SELECT owner_id,owner_version,owner_claim_id FROM affected)`).bind(...values),
    db.prepare(`${cte} UPDATE public_research_reports SET freshness='review_required' WHERE (report_id,current_version) IN (SELECT owner_id,owner_version FROM affected)`).bind(...values)];
}

export function publicResearchAdoptionStatements(db:D1Database,resultId:string,dependencies:Array<{reportId:string;version:string;claimId:string}>):D1PreparedStatement[]{
  return dependencies.map(dependency=>db.prepare(`WITH RECURSIVE ancestry(report_id,version,claim_id) AS (
      SELECT ?,?,? UNION SELECT d.source_report_id,d.source_version,d.claim_id FROM public_research_dependencies d
      JOIN ancestry a ON d.owner_id=a.report_id AND d.owner_version=a.version AND (d.owner_claim_id='*' OR d.owner_claim_id=a.claim_id)
    ) INSERT INTO public_research_adoption_checks(result_id,report_id,version,claim_id,valid)
    SELECT ?,?,?,?,CASE WHEN NOT EXISTS(SELECT 1 FROM ancestry a LEFT JOIN public_research_versions v ON v.report_id=a.report_id AND v.version=a.version
      WHERE v.version IS NULL OR v.state!='published' OR v.valid_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      OR EXISTS(SELECT 1 FROM public_research_claim_invalidations i WHERE i.report_id=a.report_id AND i.version=a.version AND i.claim_id=a.claim_id)) THEN 1 ELSE 0 END
    ON CONFLICT(result_id,report_id,version,claim_id) DO UPDATE SET valid=excluded.valid`)
    .bind(dependency.reportId,dependency.version,dependency.claimId,resultId,dependency.reportId,dependency.version,dependency.claimId));
}
