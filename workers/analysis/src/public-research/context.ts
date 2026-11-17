import type { CompanyResearchExposure, FrozenCompanyResearch, ResearchDependency } from "../../../../shared/analysis-contract/public-research.ts";
import { sha256 } from "../sha256.ts";
import { validateExposure, publicClaimUsable } from "../../../../shared/analysis-runtime/public-research.ts";
import { listPublicResearch, readPublicResearch, publicResearchAdoptionStatements, type PublicResearchEnv } from "./store.ts";
import { exposureBusinessMeaning, projectVerifiedBusinessTag, resolveCompanyExposure, stableResearchValue } from "./tag-exposure.ts";

/** Explicit, evidenced relationships only. No ticker classification or guessed equal weights. */
export async function saveCompanyResearchExposure(env:PublicResearchEnv,input:CompanyResearchExposure):Promise<void>{
  if(!env.DB)throw new Error("Public research storage unavailable");
  const exposure=validateExposure(input);
  if(await sha256(exposure.source.excerpt)!==exposure.source.contentHash)throw new Error("Exposure source hash mismatch");
  if(exposure.tagBinding){
    const tag=await projectVerifiedBusinessTag(env,exposure.companyId,exposure.tagBinding.tagId);
    const ordered=(sources:typeof tag.bindings)=>[...sources].sort((a,b)=>stableResearchValue(a).localeCompare(stableResearchValue(b)));
    const original=tag.sources.some(source=>["id","canonicalId","uri","locator","excerpt","contentHash","revision","publishedAt","availableAt"].every(key=>source[key as keyof typeof source]===exposure.source[key as keyof typeof source]));
    if(exposure.status!=="verified"||tag.fingerprint!==exposure.tagBinding.fingerprint||stableResearchValue(ordered(exposure.tagBinding.sources))!==stableResearchValue(ordered(tag.bindings))||!original)throw new Error("Tag-bound exposure must use the current server-verified business tag and originals");
  }
  const existing=await env.DB.prepare("SELECT body_json FROM company_research_exposures WHERE exposure_id=? AND version=?").bind(exposure.id,exposure.version).first<{body_json:string}>();
  if(existing && JSON.stringify(validateExposure(JSON.parse(existing.body_json)))!==JSON.stringify(exposure))throw new Error("Exposure version is immutable; create a new version");
  await insertExposure(env,exposure);
}
async function insertExposure(env:PublicResearchEnv,exposure:CompanyResearchExposure){
  await env.DB!.prepare("INSERT INTO company_research_exposures(exposure_id,version,company_id,industry_id,valid_from,valid_until,status,body_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(exposure_id,version) DO NOTHING")
    .bind(exposure.id,exposure.version,exposure.companyId,exposure.industryId,exposure.validFrom,exposure.validUntil,exposure.status,JSON.stringify(exposure)).run();
}
/** Attach authoritative existing tag evidence to the same relationship, without reclassifying or guessing weights. */
export async function bindCompanyExposureFromTag(env:PublicResearchEnv,input:{exposureId:string;baseVersion:string;tagId:string}){
  if(!env.DB)throw new Error("Public research storage unavailable");
  const rows=(await env.DB.prepare("SELECT body_json FROM company_research_exposures WHERE exposure_id=? ORDER BY valid_from DESC,rowid DESC").bind(input.exposureId).all<{body_json:string}>()).results.map(row=>validateExposure(JSON.parse(row.body_json)));
  const base=rows.find(item=>item.version===input.baseVersion),now=new Date().toISOString();
  if(!base||base.status!=="verified"||base.validFrom>now||base.validUntil&&base.validUntil<=now)throw new Error("Exact currently verified exposure base required");
  const tag=await projectVerifiedBusinessTag(env,base.companyId,input.tagId);
  const binding={tagId:tag.tagId,fingerprint:tag.fingerprint,algorithmVersion:tag.algorithmVersion,baseVersion:base.version,sources:tag.bindings};
  const version=await sha256(stableResearchValue({adapter:"company-exposure.from-tag.v1",exposureId:base.id,baseVersion:base.version,businessMeaning:exposureBusinessMeaning(base),tagId:tag.tagId,fingerprint:tag.fingerprint}));
  const prior=rows.find(item=>item.version===version);
  if(prior)return {saved:true,reused:true,exposure:prior};
  if(rows[0]?.version!==base.version)throw new Error("Exposure base changed; select its current exact version");
  if(base.tagBinding?.tagId===tag.tagId&&base.tagBinding.fingerprint===tag.fingerprint)return {saved:true,reused:true,exposure:base};
  if(base.tagBinding)throw new Error("Business tag changed; review the relationship before binding a new semantic version");
  const exposure=validateExposure({...base,version,validFrom:now,source:tag.sources[0],status:"verified",tagBinding:binding});
  // Stable semantic version, first immutable body wins even for simultaneous identical requests.
  await insertExposure(env,exposure);
  const stored=await env.DB.prepare("SELECT body_json FROM company_research_exposures WHERE exposure_id=? AND version=?").bind(base.id,version).first<{body_json:string}>();
  return {saved:true,reused:false,exposure:validateExposure(JSON.parse(stored!.body_json))};
}
export async function freezeCompanyResearch(env:PublicResearchEnv,ticker:string,asOf:string):Promise<FrozenCompanyResearch>{
  if(!Number.isFinite(Date.parse(asOf)))throw new Error("Invalid company research as-of time");
  asOf=new Date(asOf).toISOString();
  const context:FrozenCompanyResearch={ticker,asOf,frozenAt:new Date().toISOString(),mappingVersions:[],reports:[],gaps:[]};
  if(!env.DB){context.gaps.push({kind:"macro",industryId:null,reason:"storage_unavailable"},{kind:"industry",industryId:null,reason:"uncovered"});return context;}
  const rows=await env.DB.prepare("SELECT body_json FROM company_research_exposures WHERE company_id=? ORDER BY valid_from DESC,rowid DESC").bind(ticker).all<{body_json:string}>();
  const all=rows.results.map(row=>validateExposure(JSON.parse(row.body_json)));
  const selected=new Map<string,CompanyResearchExposure>();
  for(const exposure of all)if(exposure.validFrom<=asOf&&!selected.has(exposure.id))selected.set(exposure.id,exposure);
  const exposures:CompanyResearchExposure[]=[],projections=new Map<string,ReturnType<typeof projectVerifiedBusinessTag>>();
  for(const exposure of selected.values()){
    const resolved=await resolveCompanyExposure(env,exposure,all.filter(item=>item.id===exposure.id),asOf,projections);
    if(resolved.status!=="valid"||!resolved.exposure){context.gaps.push({kind:"industry",industryId:exposure.industryId,reason:`review_required: ${resolved.reason}`});continue;}
    if(resolved.exposure.source.availableAt<=asOf)exposures.push(resolved.exposure);
  }
  context.mappingVersions=exposures.map(exposure=>`${exposure.id}:${exposure.version}`);
  const macro=await listPublicResearch(env,{type:'macro',asOf});
  if(!macro.reports.length)context.gaps.push({kind:'macro',industryId:null,reason:'uncovered'});
  const industryIds=[...new Set(exposures.map(exposure=>exposure.industryId))];
  if(!industryIds.length)context.gaps.push({kind:'industry',industryId:null,reason:'uncovered: no verified business exposure mapping'});
  const candidates=macro.reports.map(summary=>({summary,exposures:[] as CompanyResearchExposure[]}));
  for(const industryId of industryIds){
    const list=await listPublicResearch(env,{type:'industry',industryId,asOf});
    if(!list.reports.length)context.gaps.push({kind:'industry',industryId,reason:'uncovered'});
    candidates.push(...list.reports.map(summary=>({summary,exposures:exposures.filter(exposure=>exposure.industryId===industryId)})));
  }
  for(const candidate of candidates){
    const read=await readPublicResearch(env,candidate.summary.reportId,{version:candidate.summary.version,asOf});
    if(!read.report || !read.report.claims.some(claim=>publicClaimUsable(read.report!,claim.id))){
      context.gaps.push({kind:candidate.summary.type,industryId:candidate.summary.scope.industryId,reason:read.report?.freshnessStatus??read.reason??'unavailable'});continue;
    }
    if(read.report.freshnessStatus==='review_required')context.gaps.push({kind:read.report.type,industryId:read.report.scope.industryId,reason:'Some public claims require review; only claimStates.valid may be adopted'});
    context.reports.push({report:read.report,exposures:candidate.exposures,applicability:'requires_company_review'});
  }
  return context;
}
/** Record only the claims actually adopted; a mere background read creates no quantitative dependency. */
export type CompanyDependencyInput = {ticker:string;resultId:string;dependencies:ResearchDependency[];mappingVersions:string[]};
export async function companyExposureMappingStatus(env:PublicResearchEnv,ticker:string,mappingVersions:string[]){
  if(!env.DB)return {status:"unavailable" as const,mappings:[]};
  if(!mappingVersions.length)return {status:"valid" as const,mappings:[]};
  const all=(await env.DB.prepare("SELECT body_json FROM company_research_exposures WHERE company_id=? ORDER BY valid_from DESC,rowid DESC").bind(ticker).all<{body_json:string}>()).results.map(row=>validateExposure(JSON.parse(row.body_json)));
  const projections=new Map<string,ReturnType<typeof projectVerifiedBusinessTag>>(),mappings:Array<{mappingVersion:string;status:"valid"|"review_required";reason?:string}>=[];
  for(const mappingVersion of mappingVersions){
    const matches=all.filter(item=>`${item.id}:${item.version}`===mappingVersion);
    if(matches.length!==1){mappings.push({mappingVersion,status:"review_required",reason:"exposure_mapping_missing_or_ambiguous"});continue;}
    const exposure=matches[0]!,resolved=await resolveCompanyExposure(env,exposure,all.filter(item=>item.id===exposure.id),new Date().toISOString(),projections);
    mappings.push({mappingVersion,status:resolved.status,...(resolved.status==="review_required"?{reason:resolved.reason}:{})});
  }
  return {status:mappings.some(item=>item.status!=="valid")?"review_required" as const:"valid" as const,mappings};
}
export async function companyResearchDependencyStatements(env:PublicResearchEnv,input:CompanyDependencyInput):Promise<D1PreparedStatement[]>{
  if(!env.DB)throw new Error("Public research storage unavailable");
  const mappings=await companyExposureMappingStatus(env,input.ticker,input.mappingVersions);
  if(mappings.status!=="valid")throw new Error("Company exposure mapping requires review; cannot adopt research with stale tag evidence");
  const statements:D1PreparedStatement[]=[];
  for(const dependency of input.dependencies){
    const read=await readPublicResearch(env,dependency.reportId,{version:dependency.version});
    if(!read.report || !publicClaimUsable(read.report,dependency.claimId))throw new Error("Cannot adopt unavailable public claim");
    const invalid=await env.DB.prepare("SELECT 1 revoked FROM public_research_claim_invalidations WHERE report_id=? AND version=? AND claim_id=?").bind(dependency.reportId,dependency.version,dependency.claimId).first();
    if(invalid)throw new Error("Public claim changed or was revoked after task began; review required");
    statements.push(...publicResearchAdoptionStatements(env.DB,input.resultId,[dependency]));
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO public_research_dependencies(owner_id,owner_version,source_report_id,source_version,claim_id,ticker) VALUES(?,?,?,?,?,?)")
      .bind(`company:${input.ticker}`,input.resultId,dependency.reportId,dependency.version,dependency.claimId,input.ticker));
  }
  statements.push(env.DB.prepare("INSERT INTO company_research_contexts(result_id,ticker,mapping_versions,created_at) VALUES(?,?,?,?) ON CONFLICT(result_id) DO NOTHING").bind(input.resultId,input.ticker,JSON.stringify(input.mappingVersions),new Date().toISOString()));
  return statements;
}
export async function recordCompanyResearchDependencies(env:PublicResearchEnv,input:CompanyDependencyInput):Promise<void>{
  const statements=await companyResearchDependencyStatements(env,input);
  await env.DB!.batch(statements);
}
export async function companyResearchDependencyStatus(env:PublicResearchEnv,resultId:string){
  if(!env.DB)return {status:'unavailable' as const,dependencies:[]};
  const rows=await env.DB.prepare("SELECT source_report_id reportId,source_version version,claim_id claimId,status FROM public_research_dependencies WHERE owner_version=?").bind(resultId).all<ResearchDependency & {status:string}>();
  for(const row of rows.results){if(row.status!=='valid')continue;const source=await readPublicResearch(env,row.reportId,{version:row.version});const invalid=await env.DB.prepare('SELECT 1 FROM public_research_claim_invalidations WHERE report_id=? AND version=? AND claim_id=?').bind(row.reportId,row.version,row.claimId).first();if(invalid||!source.report||!publicClaimUsable(source.report,row.claimId))row.status='review_required';}
  const context=await env.DB.prepare("SELECT ticker,mapping_versions FROM company_research_contexts WHERE result_id=?").bind(resultId).first<{ticker:string;mapping_versions:string}>();
  const mappings=context?await companyExposureMappingStatus(env,context.ticker,JSON.parse(context.mapping_versions)):null;
  return {status:rows.results.some(row=>row.status!=='valid')||mappings&&mappings.status!=="valid"?'review_required' as const:'valid' as const,dependencies:rows.results,mappings:mappings?.mappings??[]};
}
