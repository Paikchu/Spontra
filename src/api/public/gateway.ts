import { publicResearchListSchema, publicResearchReadSchema } from "@/src/domains/public-research/schema.ts";
import { priceImpactOf } from "@/src/domains/valuation/price-impact-runtime.ts";
import type { PublishedArtifact } from "@/src/domains/publishing/artifact-contract.ts";
import { readPriceGuide } from "@/src/domains/valuation/runtime/price-guide.ts";

import { readValuationPublication } from "@/src/domains/valuation/runtime/read.ts";
import { selectFlow } from "@/src/api/public/business-flow-model.ts";
import { checkCompleteFlow, newestPair } from "@/src/domains/financials/runtime/completeness.ts";
import { canonicalTicker } from "@/src/domains/financials/runtime/policy.ts";
import type { CompleteFlowPublication } from "@/src/domains/financials/complete-business-flow-contract.ts";
import {LAYERS,type Layer} from "@/src/domains/business-map/features-contract.ts";
import {readReportHistory} from "@/src/domains/financials/runtime/report-history.ts";
import {readHistory} from "@/src/domains/financials/runtime/history.ts";
import {readCapitalStructure} from "@/src/domains/financials/runtime/capital-structure.ts";
import type {PublicCapitalStructure} from "@/src/domains/financials/capital-structure-contract.ts";
import {readBusinessExplainer} from "@/src/domains/business-map/explainer-runtime.ts";
import type {BusinessExplainer} from "@/src/domains/business-map/explainer-contract.ts";
import {readBusinessTree} from "@/src/domains/business-map/tree-runtime.ts";
import type {BusinessTree} from "@/src/domains/business-map/tree-contract.ts";
import {readEventsPublication,trimEventsForRail} from "@/src/domains/financials/events-runtime.ts";
import type {EventsPublication} from "@/src/domains/financials/events-contract.ts";
import type {PublicFilingDetail,PublicFilingDigest,PublicFilingDigestPage,PublicFilingPage,PublicSecFiling} from "@/src/domains/filing-analysis/filings-contract.ts";
import {filingFiscalFields,formatFilingPeriodLabel} from "@/src/api/public/filing-period-label.ts";
import {formatSecMetricLabel,formatSecMetricValue} from "@/src/api/public/sec-metric-format.ts";
import { isLocale, type Locale } from "@/src/lib/locale.ts";
import { homeLocale, parseHomeDigest, unavailableHome } from "./home-model.ts";
import { handleMapRead, type AnalysisReadEnv } from "./router.ts";
import { DISPLAY_CONFIG_TOKEN, MAP_RESOURCES, REVISION, type MapResource, type MapRevisions } from "@/src/domains/publishing/revisions-contract.ts";
/** Internal origin label used when dispatching public reads to `handleMapRead`. */
const ANALYSIS_ORIGIN = "https://spontra-analysis.internal";
/** A read in the reader's language: Spontra Analysis applies its translations of the generated prose. English needs no parameter. */
const inLocale = (path: string, locale: Locale | null) => locale && locale !== "en" ? `${path}${path.includes("?") ? "&" : "?"}locale=${locale}` : path;
export type SiteEnv = AnalysisReadEnv & {
  ASSETS?: { fetch(request: Request): Promise<Response> };
  PUBLIC_READ_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  SPONTRA_ANALYSIS?: { fetch(request: Request): Promise<Response> };
};
/** Routes public read requests through `handleMapRead` in-process (or an explicit `SPONTRA_ANALYSIS` binding if supplied). */
export function analysisFetcher(env: SiteEnv): typeof fetch {
  const binding = env.SPONTRA_ANALYSIS;
  return async (input, init) => {
    const request = new Request(input, init);
    try {
      const response = binding && typeof binding.fetch === "function"
        ? await binding.fetch(request)
        : await handleMapRead(request, env);
      if (!response.ok) console.warn(JSON.stringify({ event: "analysis-read-refused", status: response.status, path: new URL(request.url).pathname }));
      return response;
    } catch (error) {
      console.error(JSON.stringify({ event: "analysis-read-failed", path: new URL(request.url).pathname, message: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  };
}
export function isPublicSitePath(pathname: string): boolean {
  return pathname.startsWith("/api/business/v1/")
    || pathname === "/spontra-ios" || pathname.startsWith("/spontra-ios/")
    || pathname === "/article-preview" || pathname === "/article-preview/"
    || pathname === "/artifact-frame" || pathname === "/artifact-frame.html"
    || pathname === "/theme.js"
    || pathname.startsWith("/assets/");
}
export type SiteContext={waitUntil(promise:Promise<unknown>):void};
const security={"x-content-type-options":"nosniff","referrer-policy":"strict-origin-when-cross-origin","content-security-policy":"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://images.financialmodelingprep.com; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"};
function json(body:unknown,status=200){return Response.json(body,{status,headers:{...security,...(status===429?{"retry-after":"60"}:{}),"cache-control":status===200?"public, max-age=14400":"no-store"}});}
/** The only public output is schema-stripped SEC business flow, never the analysis envelope. */
export async function loadPublicFlow(ticker:string,fetcher:typeof fetch=fetch,locale:Locale|null=null):Promise<CompleteFlowPublication>{
 const response=await fetcher(ANALYSIS_ORIGIN+inLocale(`/api/v1/companies/${ticker}/business-flow`,locale),{signal:AbortSignal.timeout(12000),headers:{accept:"application/json"}});
 if(!response.ok)throw new Error("Public source unavailable");
 const publication=await response.json() as CompleteFlowPublication;
 if(publication.schemaVersion!=="complete-business-flow.v1"||!['ready','preparing','unavailable'].includes(publication.status))throw new Error('Invalid publication');
 // The issuer's fiscal calendar labels every period on the page; kept only in its own shape.
 const issuer=publicIssuer(publication.issuer);
 const layers=publicLayers(publication.layers);
 const controls={...(layers?{layers}:{}),...(typeof publication.stageEnabled==="boolean"?{stageEnabled:publication.stageEnabled}:{})};
 if(publication.status!=='ready')return {schemaVersion:publication.schemaVersion,status:publication.status,flow:null,reasons:publication.reasons,outdated:false,lastAttemptAt:publication.lastAttemptAt,...controls,...(issuer?{issuer}:{})};
 const flow=newestPair(selectFlow(publication.flow??undefined,null,ticker));const check=checkCompleteFlow(flow);
 // History is re-validated here and stripped to its schema; an invalid record is dropped, never repaired.
 return {schemaVersion:"complete-business-flow.v1",status:check.complete?"ready":"preparing",flow:check.complete?flow:null,reasons:check.complete&&publication.outdated?publication.reasons:check.reasons,outdated:check.complete&&publication.outdated===true,lastAttemptAt:publication.lastAttemptAt??null,history:check.complete?readHistory(publication.history,ticker):null,...controls,...(check.complete&&publication.reports?{reports:readReportHistory(publication.reports,ticker)}:{}),...(issuer?{issuer}:{})};
}
function publicLayers(value:unknown):Record<Layer,boolean>|null{
 if(!value||typeof value!=="object")return null;
 const layers=value as Record<string,unknown>;
 return LAYERS.every(layer=>typeof layers[layer]==="boolean")?Object.fromEntries(LAYERS.map(layer=>[layer,layers[layer]])) as Record<Layer,boolean>:null;
}
function publicIssuer(value:unknown):CompleteFlowPublication["issuer"]|null{
 if(!value||typeof value!=="object")return null;
 const {fiscalYearEndMonth:month,name,annualForm:form}=value as {fiscalYearEndMonth?:unknown;name?:unknown;annualForm?:unknown};
 return {fiscalYearEndMonth:typeof month==="number"&&Number.isInteger(month)&&month>=1&&month<=12?month:null,name:typeof name==="string"&&name.trim()?name.trim().slice(0,120):null,annualForm:typeof form==="string"&&/^(?:10-K|20-F|40-F)$/.test(form)?form:null};
}

/** Supplementary: an unavailable or invalid explanation reads as null and never fails the flow. */
export async function loadExplainer(ticker:string,fetcher:typeof fetch=fetch,locale:Locale|null=null):Promise<BusinessExplainer|null>{
 try{
  const response=await fetcher(ANALYSIS_ORIGIN+inLocale(`/api/v1/companies/${ticker}/business-explainer`,locale),{signal:AbortSignal.timeout(8000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const body=await response.json() as {schemaVersion?:string;status?:string;explainer?:unknown};
  return body.schemaVersion==="business-explainer-response.v1"&&body.status==="ready"?readBusinessExplainer(body.explainer,ticker):null;
 }catch{return null;}
}

/** The business breakdown the map draws as a mind map beside a picked business; re-validated, and without the agent's trace. */
export async function loadTree(ticker:string,fetcher:typeof fetch=fetch,locale:Locale|null=null):Promise<BusinessTree|null>{
 try{
  const response=await fetcher(ANALYSIS_ORIGIN+inLocale(`/api/v1/companies/${ticker}/business-tree`,locale),{signal:AbortSignal.timeout(8000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const body=await response.json() as {schemaVersion?:string;status?:string;tree?:unknown};
  return body.schemaVersion==="business-tree-response.v1"&&body.status==="ready"?readBusinessTree(body.tree,ticker):null;
 }catch{return null;}
}

/**
 * Supplementary and loaded on its own, so the map never waits for it; anything that fails re-validation reads as null.
 */
export async function loadCapital(ticker:string,fetcher:typeof fetch=fetch):Promise<PublicCapitalStructure|null>{
 try{
  const response=await fetcher(ANALYSIS_ORIGIN+`/api/v1/companies/${ticker}/capital`,{signal:AbortSignal.timeout(25000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const body=await response.json() as {schemaVersion?:string;status?:string;capital?:unknown};
  const capital=body.schemaVersion==="capital-response.v1"&&body.status==="ready"?readCapitalStructure(body.capital,ticker):null;
  return capital;
 }catch{return null;}
}

/** Filed events (8-K and Form 4), re-validated and trimmed to rail summaries; unavailable reads as null. */
export async function loadEvents(ticker:string,fetcher:typeof fetch=fetch,locale:Locale|null=null):Promise<EventsPublication|null>{
 try{
  const response=await fetcher(ANALYSIS_ORIGIN+inLocale(`/api/v1/companies/${ticker}/events`,locale),{signal:AbortSignal.timeout(8000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const body=await response.json() as {schemaVersion?:string;status?:string;events?:unknown};
  const parsed=body.schemaVersion==="events-response.v1"&&body.status==="ready"?readEventsPublication(body.events,ticker):null;
  return parsed?trimEventsForRail(parsed):null;
 }catch{return null;}
}

const ACCESSION=/^\d{10}-\d{2}-\d{6}$/;
/** One filing as the map lists it: labels instead of metric keys, text instead of evidence ids, and never the analysis envelope. */
export function digestFiling(filing:PublicSecFiling,locale:Locale="en"):PublicFilingDigest{
 const summary=filing.summary,analysis=filing.analysis;
 const fields=filingFiscalFields(filing);
 const published=analysis?.publication;
 const text=(v:unknown)=>typeof v==="string"?v:"";
 return {
  accessionNumber:filing.accessionNumber,form:filing.form,filingDate:filing.filingDate,reportDate:filing.reportDate,
  periodEnd:fields?.periodEnd??null,periodLabel:fields?formatFilingPeriodLabel(filing,locale):null,
  fiscalYear:fields?.fiscalYear??null,fiscalQuarter:fields?.fiscalQuarter??null,fiscalYearEndMonth:fields?.fiscalYearEndMonth??null,labelSource:fields?.labelSource,
  date:filing.filingDate,
  headline:text(summary?.headline)||text(analysis?.headline),
  bullets:(summary?.bullets??[]).map(b=>({label:text(b.label),detail:text(b.detail),importance:b.importance})).slice(0,12),
  analystView:text(summary?.analystView),
  warnings:[...(summary?.discovery?.warnings??[]),...(analysis?.dataQuality.warnings??[])].filter(w=>typeof w==="string").slice(0,8),
  generatedAt:summary?.generatedAt??null,
  keyMetrics:(analysis?.keyMetrics??[]).slice(0,8).map(m=>({key:m.metricKey,label:formatSecMetricLabel(m.metricKey,locale),value:formatSecMetricValue(m.metricKey,m.currentValue,m.unit,m.currency,locale),yoy:m.yoy??null,qoq:m.qoq??null,status:m.status})),
  changes:[...(analysis?.changes.qoq??[]).map(c=>({compare:"QoQ" as const,...c})),...(analysis?.changes.yoy??[]).map(c=>({compare:"YoY" as const,...c}))]
   .filter(c=>c.changeType!=="not_mentioned"&&(c.currentStatement||c.priorStatement)).slice(0,8).map(c=>({compare:c.compare,topic:c.topicKey,statement:c.currentStatement??c.priorStatement??""})),
  risks:(analysis?.changes.risks??[]).map(c=>text(c.statement)).filter(Boolean).slice(0,6),
  guidance:(analysis?.changes.guidance??[]).map(c=>text(c.statement)).filter(Boolean).slice(0,6),
  verification:analysis?.dataQuality.verificationStatus??null,analysisStatus:filing.analysisStatus,
  hasReport:!!summary?.report,
  snapshot:published&&analysis?{accession:published.filing.accessionNumber,reportDate:published.filing.reportDate||published.filing.filingDate,reportVersion:analysis.reportVersion}:null,
  edgarUrl:filing.edgarUrl,documentUrl:filing.documentUrl,
  ...(filing.reportBundle ? { reportBundle: filing.reportBundle } : {}),
 };
}

/** The company's filings as digests: one upstream page of up to fifty, newest first. */
export async function loadFilings(ticker:string,fetcher:typeof fetch=fetch,locale:Locale|null=null):Promise<PublicFilingDigestPage|null>{
 try{
  const response=await fetcher(ANALYSIS_ORIGIN+inLocale(`/api/v1/companies/${ticker}/filings?limit=50`,locale),{signal:AbortSignal.timeout(12000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const page=await response.json() as PublicFilingPage;
  if(page.ticker!==ticker||!Array.isArray(page.filings))return null;
  const filings=page.filings.filter(f=>f&&f.ticker===ticker&&ACCESSION.test(f.accessionNumber)).map(f=>digestFiling(f,locale??"en"));
  return {schemaVersion:"filing-digests.v1",ticker,filings,total:page.total??null,checkedAt:page.checkedAt??null};
 }catch{return null;}
}

const artifactSettled=(artifact:PublishedArtifact)=>!artifact.translation||artifact.translation.status==="ready";
export async function loadFilingDetail(ticker:string,accession:string,snapshot:{reportDate:string;reportVersion:string}|null,fetcher:typeof fetch=fetch,locale:Locale|null=null,edition:{artifactVersion:string;artifactHash:string}|null=null):Promise<PublicFilingDetail|null>{
 if(!ACCESSION.test(accession))return null;
  const params=new URLSearchParams({...snapshot,...edition});
  const query=params.size?"?"+params:"";
  const response=await fetcher(ANALYSIS_ORIGIN+inLocale(`/api/v1/companies/${ticker}/filings/${accession}${query}`,locale),{signal:AbortSignal.timeout(12000),headers:{accept:"application/json"}});
  if(response.status===404)return null;
  if(!response.ok)throw new Error("Filing detail source unavailable");
  const detail=await response.json() as PublicFilingDetail;
  if(detail.ticker!==ticker||detail.filing?.ticker!==ticker)return null;
  const artifact=detail.artifact&&typeof detail.artifact.html==="string"&&typeof detail.artifact.css==="string"?detail.artifact:null;
  return {apiSchemaVersion:detail.apiSchemaVersion,ticker,company:detail.company?{ticker:detail.company.ticker,name:detail.company.name,cik:detail.company.cik}:null,filing:detail.filing,artifact};
}

/**
 * The valuation assessment and its history, re-validated: the current report and each version through the contract reader, the
 * version list and evidence snapshots as served. A hidden company answers hidden; an upstream failure reads as null.
 */
export async function loadValuation(ticker:string,path:string,params:URLSearchParams,fetcher:typeof fetch=fetch,locale:Locale|null=null):Promise<Record<string,unknown>|null>{
 try{
  const query=path==="/valuation/versions"?`?${new URLSearchParams([...params.entries()].filter(([k])=>k==="before"||k==="limit")).toString()}`:"";
  const target=path==="/valuation/versions"?`/api/v1/companies/${ticker}/valuation/versions${query}`:inLocale(`/api/v1/companies/${ticker}${path}`,locale);
  const response=await fetcher(ANALYSIS_ORIGIN+target,{signal:AbortSignal.timeout(8000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const body=await response.json() as Record<string,unknown>;
  if(path==="/valuation"){
   if(body.schemaVersion!=="valuation-response.v1"||typeof body.availability!=="string")return null;
   const report=readValuationPublication(body.report,ticker);
   return {schemaVersion:"valuation-response.v1",ticker,availability:report?body.availability:body.availability==="ready"||body.availability==="insufficient"?"preparing":body.availability,report,priceGuide:readPriceGuide(body.priceGuide),priceImpact:report?priceImpactOf(report,{latestQuote:readPriceGuide(body.priceGuide)?.quote,outdated:body.outdated===true,dependencyStatus:body.researchStatus==="valid"?"valid":body.researchStatus==="review_required"?"review_required":"unavailable"}):undefined,researchStatus:body.researchStatus==="valid"?"valid":body.researchStatus==="review_required"?"review_required":"unavailable",latestAttempt:body.latestAttempt??null,outdated:body.outdated===true,versions:Array.isArray(body.versions)?body.versions.slice(0,50):[]};
  }
  if(path==="/valuation/versions")return body.schemaVersion==="valuation-versions.v1"?{schemaVersion:"valuation-versions.v1",ticker,items:Array.isArray(body.items)?body.items.slice(0,50):[],nextCursor:typeof body.nextCursor==="string"?body.nextCursor:null}:null;
  if(path.includes("/evidence/"))return body.schemaVersion==="valuation-evidence.v1"&&body.evidence&&typeof body.evidence==="object"?{schemaVersion:"valuation-evidence.v1",ticker,evidence:body.evidence}:null;
  const report=readValuationPublication(body.report,ticker);
  return report?{schemaVersion:"valuation-version.v1",ticker,report,researchStatus:body.researchStatus==="valid"?"valid":body.researchStatus==="review_required"?"review_required":"unavailable"}:null;
 }catch{return null;}
}

/** The company's publication revisions and live display-switch fingerprint; only well-formed values pass through. */
async function loadRevisionState(ticker:string,fetcher:typeof fetch=fetch):Promise<{revisions:MapRevisions;config:string|null}|null>{
 try{
  const response=await fetcher(ANALYSIS_ORIGIN+`/api/v1/companies/${ticker}/revisions`,{signal:AbortSignal.timeout(5000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const body=await response.json() as {schemaVersion?:unknown;revisions?:unknown;config?:unknown};
  if(body.schemaVersion!=="revisions.v1"||!body.revisions||typeof body.revisions!=="object")return null;
  const source=body.revisions as Record<string,unknown>,revisions:MapRevisions={};
  for(const resource of MAP_RESOURCES){const value=source[resource];if(typeof value==="string"&&REVISION.test(value))revisions[resource]=value;}
  const config=typeof body.config==="string"&&DISPLAY_CONFIG_TOKEN.test(body.config)?body.config:null;
  return {revisions,config};
 }catch{return null;}
}
export async function loadRevisions(ticker:string,fetcher:typeof fetch=fetch):Promise<MapRevisions|null>{
 return (await loadRevisionState(ticker,fetcher))?.revisions??null;
}

const sha256Hex=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,"0")).join("");
/** The home digest lists newly added companies, so the edge keeps it half a minute and browsers revalidate it by ETag every time. */
const HOME_EDGE_SECONDS=30;
function revalidated(request:Request,response:Response):Response{
 const etag=response.headers.get("etag");
 const asked=request.headers.get("if-none-match");
 if(etag&&asked&&asked.split(",").some(tag=>tag.trim().replace(/^W\//,"")===etag.replace(/^W\//,"")))return new Response(null,{status:304,headers:{...security,etag,"cache-control":"no-cache"}});
 const out=new Response(response.body,response);
 out.headers.set("cache-control","no-cache");
 return out;
}

function companyRevalidated(request:Request,response:Response):Response{
 const etag=response.headers.get("etag");
 const asked=request.headers.get("if-none-match");
 if(etag&&asked&&asked.split(",").some(tag=>tag.trim().replace(/^W\//,"")===etag.replace(/^W\//,"")))return new Response(null,{status:304,headers:{...security,etag,"cache-control":"private, no-cache"}});
 const out=new Response(response.body,response);
 out.headers.set("cache-control","private, no-cache");
 return out;
}
function companyResourceOf(subpath?:string):MapResource|null{
 if(!subpath)return "company";
 if(subpath==="/capital"||subpath==="/events"||subpath==="/filings"||subpath==="/valuation")return subpath.slice(1) as MapResource;
 return null;
}
function companyCacheKey(url:URL,liveConfig:string,liveRev?:string):Request{
 const key=new URL(url.href);
 key.searchParams.set("cfg",liveConfig);
 if(liveRev&&!key.searchParams.has("rev"))key.searchParams.set("rev",liveRev);
 key.searchParams.sort();
 return new Request(key.href,{method:"GET"});
}
async function finalizeCompanyResponse(request:Request,response:Response,cacheKey:Request|null,cache:Cache|undefined,ctx:SiteContext,privateRead:boolean):Promise<Response>{
 const cc=response.headers.get("cache-control")??"";
 if(!response.ok||cc.includes("no-store")){
  const out=new Response(response.body,response);
  out.headers.set("cache-control","private, no-store");
  return out;
 }
 if(privateRead){
  const out=new Response(response.body,response);
  out.headers.set("cache-control","private, max-age=30");
  return out;
 }
 const text=await response.text();
 const headers=new Headers(response.headers);
 headers.set("etag",`W/"${(await sha256Hex(text)).slice(0,32)}"`);
 headers.set("cache-control","public, max-age=14400");
 const edge=new Response(text,{status:response.status,headers});
 if(cache&&cacheKey)ctx.waitUntil(cache.put(cacheKey,edge.clone()));
 return companyRevalidated(request,edge);
}

export async function handle(request:Request,env:SiteEnv,ctx:SiteContext,upstream?:typeof fetch,cache?:Cache):Promise<Response>{
 return handleRequest(request,env,ctx,upstream,cache);
}
async function handleRequest(request:Request,env:SiteEnv,ctx:SiteContext,upstream?:typeof fetch,cache?:Cache,trustedConfig?:string|null):Promise<Response>{
 const url=new URL(request.url);
 if(url.pathname.startsWith("/api/")){
  const source=upstream??analysisFetcher(env);
  let readFailureStatus=0, readRetryAfter:string|null=null;
  const fetcher:typeof fetch|null=source?async(input,init)=>{try{const response=await source(input,init);if(!response.ok){readFailureStatus=response.status===429?429:503;readRetryAfter=response.headers.get("retry-after");}return response;}catch(error){readFailureStatus=503;throw error;}}:null;
  const moduleJson=(body:unknown)=>{const response=json(body,readFailureStatus||200);if(readFailureStatus===429)response.headers.set("retry-after",readRetryAfter??"60");return response;};
  if(!fetcher||!source)return json({error:"Read service unavailable"},503);
  // An analysis draft opened by the visual review through its signed, short-lived link (docs/analysis-html-artifact.md §7.1).
  const preview=url.pathname.match(/^\/api\/business\/v1\/artifact-preview\/([A-Za-z0-9_.-]{20,1000})$/);
  if(preview){
   if(request.method!=="GET")return json({error:"Method not allowed"},405);
   try{const response=await fetcher(ANALYSIS_ORIGIN+`/api/v1/artifact-preview/${preview[1]}`,{signal:AbortSignal.timeout(12000),headers:{accept:"application/json"}});
    const out=response.ok?json(await response.json()):json({error:"Not found"},404);out.headers.set("cache-control","no-store");return out;}
   catch{return json({error:"Preview unavailable"},503);}
  }
  // Public research is read-only; requests never enqueue research or refresh source dates.
  const research=url.pathname.match(/^\/api\/business\/v1\/research(?:\/([^/]+))?\/?$/);
  if(research){
   try{if(research[1]){research[1]=decodeURIComponent(research[1]);if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(research[1]))return json({error:"Not found"},404);}}catch{return json({error:"Not found"},404);}
   if(request.method!=="GET")return json({error:"Method not allowed"},405);
   if(url.href.length>2048||[...url.searchParams.keys()].some(k=>!["type","industryId","version"].includes(k)))return json({error:"Not found"},404);
   try{
    if(!env.PUBLIC_READ_LIMIT||!(await env.PUBLIC_READ_LIMIT.limit({key:request.headers.get("cf-connecting-ip")??"anonymous"})).success)return json({error:"Too many requests"},429);
    const response=await fetcher(ANALYSIS_ORIGIN+"/api/v1/research"+(research[1]?`/${research[1]}`:"")+url.search,{signal:AbortSignal.timeout(12000),headers:{accept:"application/json"}});
    const body=await response.json();
    if(!response.ok){const out=json({error:"Research unavailable"},response.status);out.headers.set("cache-control","private, no-store");return out;}
    const parsed=(research[1]?publicResearchReadSchema:publicResearchListSchema).safeParse(body);
    const out=parsed.success?json(parsed.data):json({error:"Research response could not be verified"},503);out.headers.set("cache-control","private, no-store");return out;
   }catch{return json({error:"Research unavailable"},503);}
  }
  // The companies with published findings, for the home page; the list follows the admin's AI switch.
  if(url.pathname==="/api/business/v1/home"){
   if(request.method!=="GET")return json({error:"Method not allowed"},405);
   const locale=homeLocale(url.searchParams);
   if(locale==="reject")return json({error:"Not found"},404);
   try{if(!env.PUBLIC_READ_LIMIT||!(await env.PUBLIC_READ_LIMIT.limit({key:request.headers.get("cf-connecting-ip")??"anonymous"})).success)return json({error:"Too many requests"},429);}catch{return json({error:"Read service unavailable"},503);}
   const key=new Request(url.href,{method:"GET"});const cached=await cache?.match(key);if(cached)return revalidated(request,cached);
   let digest=null;
   try{
    const response=await fetcher(ANALYSIS_ORIGIN+inLocale("/api/v1/home",locale),{signal:AbortSignal.timeout(12000),headers:{accept:"application/json"}});
    digest=response.ok?parseHomeDigest(await response.json()):null;
   }catch{digest=null;}
   if(!digest){const failed=readFailureStatus?moduleJson(unavailableHome()):json(unavailableHome(),503);failed.headers.set("cache-control","no-store");return failed;}
   const response=json(digest);response.headers.set("cache-control",`public, max-age=${HOME_EDGE_SECONDS}`);response.headers.set("etag",`W/"${(await sha256Hex(JSON.stringify(digest))).slice(0,32)}"`);
   if(cache)ctx.waitUntil(cache.put(key,response.clone()));
   return revalidated(request,response);
  }
  const match=url.pathname.match(/^\/api\/business\/v1\/companies\/([A-Z][A-Z0-9.-]{0,11})(\/revision|\/capital|\/events|\/filings|\/filings\/\d{10}-\d{2}-\d{6}|\/market-daily|\/valuation|\/valuation\/versions|\/valuation\/versions\/[0-9a-f]{8,64}|\/valuation\/versions\/[0-9a-f]{8,64}\/evidence\/e[0-9a-f]{6,20})?$/);
  const detail=match?.[2]?.startsWith("/filings/")?match[2].slice("/filings/".length):null;
  // The reader pins a report to its published revision; a resource is asked for at its publication revision (`rev`), which
  // only keys the cache: a newer revision is a new address, so no cached copy can answer it with older data.
  const allowed=match?.[2]==="/revision"||match?.[2]==="/market-daily"?new Set<string>():detail?new Set(["reportDate","reportVersion","artifactVersion","artifactHash","lang","rev","cfg","schema"]):match?.[2]==="/valuation/versions"?new Set<string>(["before","limit"]):new Set<string>(["lang","rev","cfg"]);
  allowed.add("schema");
  if(!match||[...url.searchParams.keys()].some(k=>!allowed.has(k)))return json({error:"Not found"},404);
  const rev=url.searchParams.get("rev");
  if(rev!=null&&!REVISION.test(rev))return json({error:"Not found"},404);
  const cfg=url.searchParams.get("cfg");
  if(cfg!=null&&!DISPLAY_CONFIG_TOKEN.test(cfg))return json({error:"Not found"},404);
  // `?lang=zh-CN` reads the generated prose in Chinese where it has been translated; the cache keys on the full URL.
  const lang=url.searchParams.get("lang");
  if(lang!=null&&!isLocale(lang))return json({error:"Not found"},404);
  const schema=url.searchParams.get("schema");
  if(schema!=null&&schema!=="artifact-i18n-v1"&&schema!=="artifact-i18n-v2-layers")return json({error:"Not found"},404);
  const locale:Locale|null=isLocale(lang)&&lang!=="en"?lang:null;
  match[1]=canonicalTicker(match[1]);
  if(request.method!=="GET")return json({error:"Method not allowed"},405);
  try{if(!env.PUBLIC_READ_LIMIT||!(await env.PUBLIC_READ_LIMIT.limit({key:request.headers.get("cf-connecting-ip")??"anonymous"})).success)return json({error:"Too many requests"},429);}catch{return json({error:"Read service unavailable"},503);}
  // What changed since the page loaded: answered fresh every time, never from a cache.
  if(match[2]==="/revision"){const state=await loadRevisionState(match[1],source);const response=json({schemaVersion:"revisions.v1",ticker:match[1],revisions:state?.revisions??{},...(state?.config?{config:state.config}:{})},state?200:503);response.headers.set("cache-control","private, no-store");return response;}
  // Live / latest daily candlesticks for the valuation chart: short edge cache so intraday price stays fresh.
  if(match[2]==="/market-daily"){
   const cacheKey=new Request(`${url.origin}/api/business/v1/companies/${match[1]}/market-daily`,{method:"GET"});
   const hit=await cache?.match(cacheKey);
   if(hit)return hit;
   try{
    const upstream=await source(ANALYSIS_ORIGIN+`/api/v1/companies/${match[1]}/market-daily`,{signal:AbortSignal.timeout(8000),headers:{accept:"application/json"}});
    if(!upstream.ok)return json({error:"Market data temporarily unavailable"},503);
    const body=await upstream.json() as {schemaVersion?:unknown;bars?:unknown};
    if(body?.schemaVersion!=="market-daily.v1"||!Array.isArray(body.bars))return json({error:"Market data temporarily unavailable"},503);
    const response=json(body);
    response.headers.set("cache-control","public, max-age=60, stale-while-revalidate=60");
    if(cache)ctx.waitUntil(cache.put(cacheKey,response.clone()));
    return response;
   }catch{return json({error:"Market data temporarily unavailable"},503);}
  }
  const resourceKind=companyResourceOf(match[2]);
  // Every cached company read verifies the live display-switch fingerprint so admin changes take effect immediately.
  const liveState=cache&&trustedConfig===undefined?await loadRevisionState(match[1],source):null;
  const liveConfig=trustedConfig!==undefined?trustedConfig:liveState?.config??null;
  const liveRev=rev??(resourceKind?liveState?.revisions[resourceKind]:undefined);
  const canUseEdgeCache=Boolean(cache&&liveConfig&&!liveConfig.startsWith("0")&&(liveRev||!resourceKind));
  const key=canUseEdgeCache?companyCacheKey(url,liveConfig!,liveRev):null;
  const cached=key?await cache?.match(key):undefined;
  if(cached)return companyRevalidated(request,cached);
  const finish=(response:Response)=>finalizeCompanyResponse(request,response,key,cache,ctx,false);
  if(match[2]){
   // Supplementary resources answer on their own and are cached only when they have something to say.
   const supplementary=async<T>(name:string,version:string,load:()=>Promise<T|null>,cacheable?:(body:T)=>boolean)=>{const body=await load();const response=moduleJson({schemaVersion:version,status:body?"ready":"unavailable",[name]:body});const canCache=!!body&&(!cacheable||cacheable(body));if(!canCache)response.headers.set("cache-control","no-store");return finish(response);};
   if(match[2]==="/capital"){const body=await loadCapital(match[1],fetcher);const response=moduleJson({schemaVersion:"capital-response.v1",status:body?"ready":"unavailable",capital:body});if(!body)response.headers.set("cache-control","no-store");return finish(response);}
   if(match[2]==="/events")return supplementary("events","events-response.v1",()=>loadEvents(match[1],fetcher,locale));
   if(match[2]==="/filings")return supplementary("filings","filing-digests-response.v1",()=>loadFilings(match[1],fetcher,locale));
   // The valuation answers in every availability, so the page can say preparing, insufficient or failed; only a read that failed is uncached.
   if(match[2].startsWith("/valuation")){const body=await loadValuation(match[1],match[2],url.searchParams,fetcher,locale);if(!body)return finish(readFailureStatus?moduleJson({error:"Valuation temporarily unavailable"}):json({error:"Valuation temporarily unavailable"},503));const response=json(body);const cacheable=match[2]==="/valuation"?(body as {availability?:string}).availability==="ready":match[2]!=="/valuation/versions";if(!cacheable)response.headers.set("cache-control","no-store");return finish(response);}
   if(detail){try{const reportDate=url.searchParams.get("reportDate"),reportVersion=url.searchParams.get("reportVersion");
    const artifactVersion=url.searchParams.get("artifactVersion"),artifactHash=url.searchParams.get("artifactHash");
    if((artifactVersion!==null||artifactHash!==null)&&(!artifactVersion||!/^[1-9]\d{0,8}$/.test(artifactVersion)||!artifactHash||!/^[0-9a-f]{64}$/.test(artifactHash)))return finish(json({error:"Not found"},404));
    const body=await loadFilingDetail(match[1],detail,reportDate&&reportVersion?{reportDate,reportVersion}:null,fetcher,locale,artifactVersion&&artifactHash?{artifactVersion,artifactHash}:null);
    if(!body)return finish(json({error:"Not found"},404));
    const response=json(body);const canCache=!body.artifact?.filingImpact&&(!body.artifact||artifactSettled(body.artifact));if(!canCache)response.headers.set("cache-control","no-store");return finish(response);}catch{return finish(readFailureStatus?moduleJson({error:"Filing detail temporarily unavailable"}):json({error:"Filing detail temporarily unavailable"},503));}}
   return finish(json({error:"Not found"},404));
  }
  try{const flow=await loadPublicFlow(match[1],fetcher,locale);
   let supplementalFailed=false;
   const optionalSource:typeof fetch=async(input,init)=>{try{const r=await source(input,init);if(!r.ok&&r.status!==404)supplementalFailed=true;return r;}catch(error){supplementalFailed=true;throw error;}};
   // Optional explainer/tree failures never poison the primary flow response, only skip edge caching.
   const [explainer,tree]=flow.layers?.tree===false||flow.layers?.map===false?[null,null]:await Promise.all([loadExplainer(match[1],optionalSource,locale),loadTree(match[1],optionalSource,locale)]);
   const response=moduleJson({...flow,explainer,tree});
   // An incomplete answer is never cached, so one slow upstream read cannot pin "preparing" for four hours.
   const cacheable=flow.status==="ready"&&!readFailureStatus&&!supplementalFailed;
   if(!cacheable)response.headers.set("cache-control","no-store");
   return finish(response);}catch{return finish(readFailureStatus?moduleJson({error:"Public company data temporarily unavailable"}):json({error:"Public company data temporarily unavailable"},503));}
 }
const artifactFrameSecurity={"x-content-type-options":"nosniff","referrer-policy":"strict-origin-when-cross-origin","content-security-policy":"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"};
 async function serveAsset(assetRequest:Request,env:SiteEnv,extraHeaders:Record<string,string>):Promise<Response>{
  if(!env.ASSETS)return new Response("Assets unavailable",{status:503,headers:{...security,"cache-control":"no-store"}});
  const response=await env.ASSETS.fetch(assetRequest);
  const headers=new Headers(response.headers);
  for(const [name,value]of Object.entries(extraHeaders))headers.set(name,value);
  return new Response(response.body,{status:response.status,headers});
 }
 if(request.method!=="GET"&&request.method!=="HEAD")return json({error:"Method not allowed"},405);
 if(url.pathname==="/spontra-ios"||url.pathname==="/spontra-ios/"||url.pathname==="/spontra-ios/index.html"){
  return serveAsset(new Request(new URL("/spontra-ios/",url),request),env,security);
 }
 if(url.pathname==="/article-preview"||url.pathname==="/article-preview/"){
  return serveAsset(new Request(new URL("/preview",url),request),env,{...security,"cache-control":"no-store"});
 }
 if(url.pathname==="/artifact-frame"||url.pathname==="/artifact-frame.html"){
  return serveAsset(new Request(new URL("/artifact-frame",url),request),env,artifactFrameSecurity);
 }
 if(url.pathname==="/theme.js"){
  return serveAsset(request,env,security);
 }
 if(url.pathname.startsWith("/assets/")){
  return serveAsset(request,env,{"x-content-type-options":"nosniff","access-control-allow-origin":"*","cache-control":"public, max-age=31536000, immutable"});
 }
 return new Response("Not found",{status:404,headers:{...security,"cache-control":"no-store"}});
}
