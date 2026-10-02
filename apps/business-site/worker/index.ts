import type {PublicBusinessFlow} from "@/shared/analysis-contract/business-flow";
import { selectFlow } from "@/lib/earning-report/web/business-flow-model";
import { checkCompleteFlow, newestPair } from "@/shared/analysis-runtime/financial-data/completeness";
import type { CompleteFlowPublication } from "@/shared/analysis-contract/complete-business-flow";
import {withLegacyInterestFormula} from "@/shared/analysis-runtime/financial-data/disclosed-quarter";
const PUBLIC_ORIGIN="https://spontra-app.max-zhangyuchen.workers.dev";
export type SiteEnv={ASSETS:{fetch(request:Request):Promise<Response>};PUBLIC_READ_LIMIT:{limit(options:{key:string}):Promise<{success:boolean}>}};
export type SiteContext={waitUntil(promise:Promise<unknown>):void};
const security={"x-content-type-options":"nosniff","referrer-policy":"strict-origin-when-cross-origin","content-security-policy":"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"};
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
 return {schemaVersion:"complete-business-flow.v1",status:check.complete?"ready":"preparing",flow:check.complete?flow:null,reasons:check.complete&&publication.outdated?publication.reasons:check.reasons,outdated:check.complete&&publication.outdated===true,lastAttemptAt:publication.lastAttemptAt??null};
 }catch{
  // Rollout compatibility: only a verified complete legacy SEC projection may survive a new API outage.
  const legacy=await fetcher(PUBLIC_ORIGIN+`/api/analysis/v1/companies/${ticker}/analysis`,{signal:AbortSignal.timeout(12000),headers:{accept:"application/json"}});
  if(!legacy.ok)throw new Error("Public source unavailable");
  const raw=await legacy.json() as {businessFlow?:PublicBusinessFlow};
  const flow=newestPair(withLegacyInterestFormula(selectFlow(raw.businessFlow,null,ticker)));const check=checkCompleteFlow(flow);
  return {schemaVersion:"complete-business-flow.v1",status:check.complete?"ready":"preparing",flow:check.complete?flow:null,reasons:check.complete?["PREPARING"]:check.reasons,outdated:check.complete,lastAttemptAt:null};
 }
}

export async function handle(request:Request,env:SiteEnv,ctx:SiteContext,fetcher:typeof fetch=fetch,cache?:Cache):Promise<Response>{
 const url=new URL(request.url);
 if(url.pathname.startsWith("/api/")){
  const match=url.pathname.match(/^\/api\/business\/v1\/companies\/([A-Z][A-Z0-9.-]{0,11})$/);
  if(!match||url.search)return json({error:"Not found"},404);
  if(request.method!=="GET")return json({error:"Method not allowed"},405);
  try{if(!env.PUBLIC_READ_LIMIT||!(await env.PUBLIC_READ_LIMIT.limit({key:request.headers.get("cf-connecting-ip")??"anonymous"})).success)return json({error:"Too many requests"},429);}catch{return json({error:"Read service unavailable"},503);}
  const key=new Request(url.href,{method:"GET"});const cached=await cache?.match(key);if(cached)return cached;
  try{const response=json(await loadPublicFlow(match[1],fetcher));if(cache)ctx.waitUntil(cache.put(key,response.clone()));return response;}catch{return json({error:"Public company data temporarily unavailable"},503);}
 }
 if(request.method!=="GET"&&request.method!=="HEAD")return json({error:"Method not allowed"},405);
 const response=await env.ASSETS.fetch(request);const headers=new Headers(response.headers);for(const [name,value]of Object.entries(security))headers.set(name,value);return new Response(response.body,{status:response.status,headers});
}
const worker = {fetch(request:Request,env:SiteEnv,ctx:SiteContext){return handle(request,env,ctx,fetch,(caches as CacheStorage & {default:Cache}).default);}};

export default worker;
