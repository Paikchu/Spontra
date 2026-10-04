import type {PublicBusinessFlow} from "@/shared/analysis-contract/business-flow";
import { selectFlow } from "@/lib/earning-report/web/business-flow-model";
import { checkCompleteFlow, newestPair } from "@/shared/analysis-runtime/financial-data/completeness";
import type { CompleteFlowPublication } from "@/shared/analysis-contract/complete-business-flow";
import {withLegacyInterestFormula} from "@/shared/analysis-runtime/financial-data/disclosed-quarter";
import {readHistory} from "@/shared/analysis-runtime/financial-data/history";
import {readBusinessExplainer} from "@/shared/analysis-runtime/business-explainer";
import type {BusinessExplainer} from "@/shared/analysis-contract/business-explainer";
import {readGuidancePublication} from "@/shared/analysis-runtime/guidance";
import type {GuidancePublication} from "@/shared/analysis-contract/guidance";
const PUBLIC_ORIGIN="https://spontra-app.max-zhangyuchen.workers.dev";
export type SiteEnv={ASSETS:{fetch(request:Request):Promise<Response>};PUBLIC_READ_LIMIT:{limit(options:{key:string}):Promise<{success:boolean}>}};
export type SiteContext={waitUntil(promise:Promise<unknown>):void};
const security={"x-content-type-options":"nosniff","referrer-policy":"strict-origin-when-cross-origin","content-security-policy":"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://images.financialmodelingprep.com; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"};
function json(body:unknown,status=200){return Response.json(body,{status,headers:{...security,"cache-control":status===200?"public, max-age=60":"no-store"}});}
/** The only public output is schema-stripped SEC business flow, never the analysis envelope. */
export async function loadPublicFlow(ticker:string,fetcher:typeof fetch=fetch):Promise<CompleteFlowPublication>{
 try{
 const response=await fetcher(PUBLIC_ORIGIN+`/api/analysis/v1/companies/${ticker}/business-flow`,{signal:AbortSignal.timeout(12000),headers:{accept:"application/json"}});
 if(!response.ok)throw new Error("Public source unavailable");
 const publication=await response.json() as CompleteFlowPublication;
 if(publication.schemaVersion!=="complete-business-flow.v1"||!['ready','preparing','unavailable'].includes(publication.status))throw new Error('Invalid publication');
 if(publication.status!=='ready')return {schemaVersion:publication.schemaVersion,status:publication.status,flow:null,reasons:publication.reasons,outdated:false,lastAttemptAt:publication.lastAttemptAt};
 const flow=newestPair(withLegacyInterestFormula(selectFlow(publication.flow??undefined,null,ticker)));const check=checkCompleteFlow(flow);
 // History is re-validated here and stripped to its schema; an invalid record is dropped, never repaired.
 return {schemaVersion:"complete-business-flow.v1",status:check.complete?"ready":"preparing",flow:check.complete?flow:null,reasons:check.complete&&publication.outdated?publication.reasons:check.reasons,outdated:check.complete&&publication.outdated===true,lastAttemptAt:publication.lastAttemptAt??null,history:check.complete?readHistory(publication.history,ticker):null};
 }catch{
  // Rollout compatibility: only a verified complete legacy SEC projection may survive a new API outage.
  const legacy=await fetcher(PUBLIC_ORIGIN+`/api/analysis/v1/companies/${ticker}/analysis`,{signal:AbortSignal.timeout(12000),headers:{accept:"application/json"}});
  if(!legacy.ok)throw new Error("Public source unavailable");
  const raw=await legacy.json() as {businessFlow?:PublicBusinessFlow};
  const flow=newestPair(withLegacyInterestFormula(selectFlow(raw.businessFlow,null,ticker)));const check=checkCompleteFlow(flow);
  return {schemaVersion:"complete-business-flow.v1",status:check.complete?"ready":"preparing",flow:check.complete?flow:null,reasons:check.complete?["PREPARING"]:check.reasons,outdated:check.complete,lastAttemptAt:null};
 }
}

/** Supplementary: an unavailable or invalid explanation reads as null and never fails the flow. */
export async function loadExplainer(ticker:string,fetcher:typeof fetch=fetch):Promise<BusinessExplainer|null>{
 try{
  const response=await fetcher(PUBLIC_ORIGIN+`/api/analysis/v1/companies/${ticker}/business-explainer`,{signal:AbortSignal.timeout(8000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const body=await response.json() as {schemaVersion?:string;status?:string;explainer?:unknown};
  return body.schemaVersion==="business-explainer-response.v1"&&body.status==="ready"?readBusinessExplainer(body.explainer,ticker):null;
 }catch{return null;}
}

/** Supplementary, like the explainer: unavailable or invalid guidance reads as null. */
export async function loadGuidance(ticker:string,fetcher:typeof fetch=fetch):Promise<GuidancePublication|null>{
 try{
  const response=await fetcher(PUBLIC_ORIGIN+`/api/analysis/v1/companies/${ticker}/guidance`,{signal:AbortSignal.timeout(8000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const body=await response.json() as {schemaVersion?:string;status?:string;guidance?:unknown};
  return body.schemaVersion==="guidance-response.v1"&&body.status==="ready"?readGuidancePublication(body.guidance,ticker):null;
 }catch{return null;}
}

export async function handle(request:Request,env:SiteEnv,ctx:SiteContext,fetcher:typeof fetch=fetch,cache?:Cache):Promise<Response>{
 const url=new URL(request.url);
 if(url.pathname.startsWith("/api/")){
  const match=url.pathname.match(/^\/api\/business\/v1\/companies\/([A-Z][A-Z0-9.-]{0,11})$/);
  if(!match||url.search)return json({error:"Not found"},404);
  if(request.method!=="GET")return json({error:"Method not allowed"},405);
  try{if(!env.PUBLIC_READ_LIMIT||!(await env.PUBLIC_READ_LIMIT.limit({key:request.headers.get("cf-connecting-ip")??"anonymous"})).success)return json({error:"Too many requests"},429);}catch{return json({error:"Read service unavailable"},503);}
  const key=new Request(url.href,{method:"GET"});const cached=await cache?.match(key);if(cached)return cached;
  try{const [flow,explainer,guidance]=await Promise.all([loadPublicFlow(match[1],fetcher),loadExplainer(match[1],fetcher),loadGuidance(match[1],fetcher)]);const response=json({...flow,explainer,guidance});if(cache)ctx.waitUntil(cache.put(key,response.clone()));return response;}catch{return json({error:"Public company data temporarily unavailable"},503);}
 }
 if(request.method!=="GET"&&request.method!=="HEAD")return json({error:"Method not allowed"},405);
 const response=await env.ASSETS.fetch(request);const headers=new Headers(response.headers);for(const [name,value]of Object.entries(security))headers.set(name,value);return new Response(response.body,{status:response.status,headers});
}
const worker = {fetch(request:Request,env:SiteEnv,ctx:SiteContext){return handle(request,env,ctx,fetch,(caches as CacheStorage & {default:Cache}).default);}};

export default worker;
