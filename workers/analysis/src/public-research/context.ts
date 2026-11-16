import type { CompanyResearchExposure, FrozenCompanyResearch, ResearchDependency } from "../../../../shared/analysis-contract/public-research.ts";
import { sha256 } from "../sha256.ts";
import { validateExposure, publicClaimUsable } from "../../../../shared/analysis-runtime/public-research.ts";
import { listPublicResearch, readPublicResearch, publicResearchAdoptionStatements, type PublicResearchEnv } from "./store.ts";

/** Explicit, evidenced relationships only. No ticker classification or guessed equal weights. */
export async function saveCompanyResearchExposure(env:PublicResearchEnv,input:CompanyResearchExposure):Promise<void>{
  if(!env.DB)throw new Error("Public research storage unavailable");
  const exposure=validateExposure(input);
  if(await sha256(exposure.source.excerpt)!==exposure.source.contentHash)throw new Error("Exposure source hash mismatch");
  const existing=await env.DB.prepare("SELECT body_json FROM company_research_exposures WHERE exposure_id=? AND version=?").bind(exposure.id,exposure.version).first<{body_json:string}>();
  if(existing && JSON.stringify(validateExposure(JSON.parse(existing.body_json)))!==JSON.stringify(exposure))throw new Error("Exposure version is immutable; create a new version");
  await env.DB.prepare("INSERT INTO company_research_exposures(exposure_id,version,company_id,industry_id,valid_from,valid_until,status,body_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(exposure_id,version) DO NOTHING")
    .bind(exposure.id,exposure.version,exposure.companyId,exposure.industryId,exposure.validFrom,exposure.validUntil,exposure.status,JSON.stringify(exposure)).run();
}
export async function freezeCompanyResearch(env:PublicResearchEnv,ticker:string,asOf:string):Promise<FrozenCompanyResearch>{
  if(!Number.isFinite(Date.parse(asOf)))throw new Error("Invalid company research as-of time");
  asOf=new Date(asOf).toISOString();
  const context:FrozenCompanyResearch={ticker,asOf,frozenAt:new Date().toISOString(),mappingVersions:[],reports:[],gaps:[]};
  if(!env.DB){context.gaps.push({kind:"macro",industryId:null,reason:"storage_unavailable"},{kind:"industry",industryId:null,reason:"uncovered"});return context;}
  const rows=await env.DB.prepare("SELECT body_json FROM company_research_exposures WHERE company_id=? AND valid_from<=? ORDER BY valid_from DESC,rowid DESC").bind(ticker,asOf).all<{body_json:string}>();
  const selected=new Map<string,CompanyResearchExposure>();
  for(const row of rows.results){const exposure=validateExposure(JSON.parse(row.body_json));if(!selected.has(exposure.id))selected.set(exposure.id,exposure);}
  const exposures=[...selected.values()].filter(exposure=>exposure.status==='verified' && (!exposure.validUntil || exposure.validUntil>asOf) && exposure.source.availableAt<=asOf);
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
export async function companyResearchDependencyStatements(env:PublicResearchEnv,input:CompanyDependencyInput):Promise<D1PreparedStatement[]>{
  if(!env.DB)throw new Error("Public research storage unavailable");
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
  return {status:rows.results.some(row=>row.status!=='valid')?'review_required' as const:'valid' as const,dependencies:rows.results};
}
