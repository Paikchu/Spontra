
import { selectFlow } from "@/packages/web/src/model/business-flow-model";
import { checkCompleteFlow, newestPair } from "@/shared/analysis-runtime/financial-data/completeness";
import { canonicalTicker } from "@/shared/analysis-runtime/financial-data/policy";
import type { CompleteFlowPublication } from "@/shared/analysis-contract/complete-business-flow";
import {readReportHistory} from "@/shared/analysis-runtime/financial-data/report-history";
import {readHistory} from "@/shared/analysis-runtime/financial-data/history";
import {readCapitalStructure} from "@/shared/analysis-runtime/financial-data/capital-structure";
import type {PublicCapitalStructure} from "@/shared/analysis-contract/capital-structure";
import {readBusinessExplainer} from "@/shared/analysis-runtime/business-explainer";
import type {BusinessExplainer} from "@/shared/analysis-contract/business-explainer";
import {readBusinessTree} from "@/shared/analysis-runtime/business-tree";
import type {BusinessTree} from "@/shared/analysis-contract/business-tree";
import {readGuidancePublication} from "@/shared/analysis-runtime/guidance";
import type {GuidancePublication} from "@/shared/analysis-contract/guidance";
import {readFindingFundamentals,readFindingsPublication,type FindingFundamentals} from "@/shared/analysis-runtime/findings";
import type {FindingPassage,FindingsPublication} from "@/shared/analysis-contract/findings";
import {readPeersPublication} from "@/shared/analysis-runtime/peers";
import type {PeersPublication} from "@/shared/analysis-contract/peers";
import {readEventsPublication} from "@/shared/analysis-runtime/events";
import type {EventsPublication} from "@/shared/analysis-contract/events";
import type {PublicFilingDetail,PublicFilingDigest,PublicFilingDigestPage,PublicFilingPage,PublicSecFiling} from "@/shared/analysis-contract/filings";
import type {LibraryTable,PublicPassage} from "@/shared/analysis-contract/filing-library";
import {formatFilingPeriodLabel} from "@/packages/web/src/model/filing-period-label";
import {formatSecMetricLabel,formatSecMetricValue} from "@/packages/web/src/model/sec-metric-format";
/** The analysis pipeline is reached over its Service Binding; the host is a label the binding ignores. */
const ANALYSIS_ORIGIN="https://spontra-analysis.internal";
export type SiteEnv={ASSETS:{fetch(request:Request):Promise<Response>};PUBLIC_READ_LIMIT:{limit(options:{key:string}):Promise<{success:boolean}>};
 /** Service Binding to the pipeline's `MapReads` named entrypoint; the binding is the credential. Without it every data route answers 503. */
 EARNING_REPORT_PIPELINE?:{fetch(request:Request):Promise<Response>}};
/** Reads go straight to the pipeline's read API over the binding; each call is a fresh request, so nothing from the browser's request is forwarded. */
export function analysisFetcher(env:Pick<SiteEnv,"EARNING_REPORT_PIPELINE">):typeof fetch|null{
 const binding=env.EARNING_REPORT_PIPELINE;
 if(!binding||typeof binding.fetch!=="function")return null;
 return async(input,init)=>{
  const request=new Request(input,init);
  try{
   const response=await binding.fetch(request);
   // A refused read is the operator's signal, not the reader's: the status and route are logged, never a body.
   if(!response.ok)console.warn(JSON.stringify({event:"analysis-read-refused",status:response.status,path:new URL(request.url).pathname}));
   return response;
  }catch(error){
   console.error(JSON.stringify({event:"analysis-binding-failed",path:new URL(request.url).pathname,message:error instanceof Error?error.message:String(error)}));
   throw error;
  }
 };
}
export type SiteContext={waitUntil(promise:Promise<unknown>):void};
const security={"x-content-type-options":"nosniff","referrer-policy":"strict-origin-when-cross-origin","content-security-policy":"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://images.financialmodelingprep.com; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"};
function json(body:unknown,status=200){return Response.json(body,{status,headers:{...security,"cache-control":status===200?"public, max-age=60":"no-store"}});}
/** The only public output is schema-stripped SEC business flow, never the analysis envelope. */
export async function loadPublicFlow(ticker:string,fetcher:typeof fetch=fetch):Promise<CompleteFlowPublication>{
 const response=await fetcher(ANALYSIS_ORIGIN+`/api/v1/companies/${ticker}/business-flow`,{signal:AbortSignal.timeout(12000),headers:{accept:"application/json"}});
 if(!response.ok)throw new Error("Public source unavailable");
 const publication=await response.json() as CompleteFlowPublication;
 if(publication.schemaVersion!=="complete-business-flow.v1"||!['ready','preparing','unavailable'].includes(publication.status))throw new Error('Invalid publication');
 if(publication.status!=='ready')return {schemaVersion:publication.schemaVersion,status:publication.status,flow:null,reasons:publication.reasons,outdated:false,lastAttemptAt:publication.lastAttemptAt};
 const flow=newestPair(selectFlow(publication.flow??undefined,null,ticker));const check=checkCompleteFlow(flow);
 // History is re-validated here and stripped to its schema; an invalid record is dropped, never repaired.
 return {schemaVersion:"complete-business-flow.v1",status:check.complete?"ready":"preparing",flow:check.complete?flow:null,reasons:check.complete&&publication.outdated?publication.reasons:check.reasons,outdated:check.complete&&publication.outdated===true,lastAttemptAt:publication.lastAttemptAt??null,history:check.complete?readHistory(publication.history,ticker):null,...(check.complete&&publication.reports?{reports:readReportHistory(publication.reports,ticker)}:{})};
}

/** Supplementary: an unavailable or invalid explanation reads as null and never fails the flow. */
export async function loadExplainer(ticker:string,fetcher:typeof fetch=fetch):Promise<BusinessExplainer|null>{
 try{
  const response=await fetcher(ANALYSIS_ORIGIN+`/api/v1/companies/${ticker}/business-explainer`,{signal:AbortSignal.timeout(8000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const body=await response.json() as {schemaVersion?:string;status?:string;explainer?:unknown};
  return body.schemaVersion==="business-explainer-response.v1"&&body.status==="ready"?readBusinessExplainer(body.explainer,ticker):null;
 }catch{return null;}
}

/** The business breakdown the map draws as a mind map beside a picked business; re-validated, and without the agent's trace. */
export async function loadTree(ticker:string,fetcher:typeof fetch=fetch):Promise<BusinessTree|null>{
 try{
  const response=await fetcher(ANALYSIS_ORIGIN+`/api/v1/companies/${ticker}/business-tree`,{signal:AbortSignal.timeout(8000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const body=await response.json() as {schemaVersion?:string;status?:string;tree?:unknown};
  return body.schemaVersion==="business-tree-response.v1"&&body.status==="ready"?readBusinessTree(body.tree,ticker):null;
 }catch{return null;}
}

/** Supplementary and loaded on its own, so the map never waits for it; anything that fails re-validation reads as null. */
export async function loadCapital(ticker:string,fetcher:typeof fetch=fetch):Promise<PublicCapitalStructure|null>{
 try{
  const response=await fetcher(ANALYSIS_ORIGIN+`/api/v1/companies/${ticker}/capital`,{signal:AbortSignal.timeout(25000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const body=await response.json() as {schemaVersion?:string;status?:string;capital?:unknown};
  return body.schemaVersion==="capital-response.v1"&&body.status==="ready"?readCapitalStructure(body.capital,ticker):null;
 }catch{return null;}
}

/** Supplementary, like the explainer: unavailable or invalid guidance reads as null. */
export async function loadGuidance(ticker:string,fetcher:typeof fetch=fetch):Promise<GuidancePublication|null>{
 try{
  const response=await fetcher(ANALYSIS_ORIGIN+`/api/v1/companies/${ticker}/guidance`,{signal:AbortSignal.timeout(8000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const body=await response.json() as {schemaVersion?:string;status?:string;guidance?:unknown};
  return body.schemaVersion==="guidance-response.v1"&&body.status==="ready"?readGuidancePublication(body.guidance,ticker):null;
 }catch{return null;}
}

/** The findings with what their lens documents rest on: the quoted passages as the library serves them now, and the peers projection. */
export type FindingsBundle={findings:FindingsPublication;passages:FindingPassage[];peers:PeersPublication|null};
const asText=(v:unknown)=>typeof v==="string"?v:null;
/** A served passage, rebuilt field by field; a malformed one is left out, and a malformed table drops the table alone. */
function readFindingPassage(value:unknown):FindingPassage|null{
 const p=value as Record<string,unknown>|null;
 const passageId=asText(p?.passageId),documentId=asText(p?.documentId),title=asText(p?.title),form=asText(p?.form),filedAt=asText(p?.filedAt),url=asText(p?.url),text=asText(p?.text);
 if(!p||!passageId||!/^p[0-9a-f]{14,32}$/.test(passageId)||!documentId||!title||!form||!filedAt||!url||!text||text.length>20000)return null;
 const path=Array.isArray(p.path)?p.path.filter((x):x is string=>typeof x==="string").slice(0,12):[];
 const t=p.table as Record<string,unknown>|null;
 const rows=t&&Array.isArray(t.rows)?t.rows.map(r=>{const row=r as Record<string,unknown>;const label=asText(row?.label);const cells=Array.isArray(row?.cells)?row.cells.map(c=>{const cell=c as Record<string,unknown>;const text=asText(cell?.text);return text==null?null:{text,value:typeof cell.value==="number"&&Number.isFinite(cell.value)?cell.value:null};}):null;return label==null||!cells||cells.some(c=>c==null)?null:{label,cells:cells as Array<{text:string;value:number|null}>};}):null;
 const columns=t&&Array.isArray(t.columns)?t.columns.filter((x):x is string=>typeof x==="string"):null;
 const table=t&&rows&&columns&&!rows.some(r=>r==null)?{unit:asText(t.unit),columns,rows:rows as Array<{label:string;cells:Array<{text:string;value:number|null}>}>}:null;
 return {passageId,documentId,title,form,filedAt,url,path,text,table};
}
export async function loadFindings(ticker:string,fetcher:typeof fetch=fetch):Promise<FindingsBundle|null>{
 try{
  const response=await fetcher(ANALYSIS_ORIGIN+`/api/v1/companies/${ticker}/findings`,{signal:AbortSignal.timeout(8000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const body=await response.json() as {schemaVersion?:string;status?:string;findings?:unknown;passages?:unknown;peers?:unknown};
  const findings=body.schemaVersion==="findings-response.v1"&&body.status==="ready"?readFindingsPublication(body.findings,ticker):null;
  if(!findings)return null;
  const passages=(Array.isArray(body.passages)?body.passages:[]).map(readFindingPassage).filter((p):p is FindingPassage=>p!=null).slice(0,60);
  return {findings,passages,peers:readPeersPublication(body.peers)};
 }catch{return null;}
}

/** Filed events (8-K and Form 4), re-validated; unavailable reads as null. */
export async function loadEvents(ticker:string,fetcher:typeof fetch=fetch):Promise<EventsPublication|null>{
 try{
  const response=await fetcher(ANALYSIS_ORIGIN+`/api/v1/companies/${ticker}/events`,{signal:AbortSignal.timeout(8000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const body=await response.json() as {schemaVersion?:string;status?:string;events?:unknown};
  return body.schemaVersion==="events-response.v1"&&body.status==="ready"?readEventsPublication(body.events,ticker):null;
 }catch{return null;}
}

const ACCESSION=/^\d{10}-\d{2}-\d{6}$/;
const isPeriodic=(form:string)=>/^(10-Q|10-K|20-F)(\/A)?$/.test(form);
/** One filing as the map lists it: labels instead of metric keys, text instead of evidence ids, and never the analysis envelope. */
export function digestFiling(filing:PublicSecFiling):PublicFilingDigest{
 const group=filing.earningsGroup,summary=filing.summary,analysis=filing.analysis;
 const periodic=!!group||isPeriodic(filing.form);
 const published=analysis?.publication;
 const text=(v:unknown)=>typeof v==="string"?v:"";
 return {
  accessionNumber:filing.accessionNumber,form:filing.form,filingDate:filing.filingDate,reportDate:filing.reportDate,
  periodEnd:periodic?group?.periodEnd??filing.fiscalPeriod?.periodEnd??filing.reportDate:null,periodLabel:periodic?formatFilingPeriodLabel(filing):null,
  date:group?.earningsDate??filing.filingDate,
  sources:(group?.sources??[]).map(s=>({form:s.form,filingDate:s.filingDate,accessionNumber:s.accessionNumber,indexUrl:s.indexUrl})),
  headline:text(summary?.headline)||text(analysis?.headline),
  bullets:(summary?.bullets??[]).map(b=>({label:text(b.label),detail:text(b.detail),importance:b.importance})).slice(0,12),
  analystView:text(summary?.analystView),report:text(summary?.report)||null,
  warnings:[...(summary?.discovery?.warnings??[]),...(analysis?.dataQuality.warnings??[])].filter(w=>typeof w==="string").slice(0,8),
  generatedAt:summary?.generatedAt??null,
  keyMetrics:(analysis?.keyMetrics??[]).slice(0,8).map(m=>({key:m.metricKey,label:formatSecMetricLabel(m.metricKey),value:formatSecMetricValue(m.metricKey,m.currentValue,m.unit,m.currency),yoy:m.yoy??null,qoq:m.qoq??null,status:m.status})),
  changes:[...(analysis?.changes.qoq??[]).map(c=>({compare:"QoQ" as const,...c})),...(analysis?.changes.yoy??[]).map(c=>({compare:"YoY" as const,...c}))]
   .filter(c=>c.changeType!=="not_mentioned"&&(c.currentStatement||c.priorStatement)).slice(0,8).map(c=>({compare:c.compare,topic:c.topicKey,statement:c.currentStatement??c.priorStatement??""})),
  risks:(analysis?.changes.risks??[]).map(c=>text(c.statement)).filter(Boolean).slice(0,6),
  guidance:(analysis?.changes.guidance??[]).map(c=>text(c.statement)).filter(Boolean).slice(0,6),
  verification:analysis?.dataQuality.verificationStatus??null,analysisStatus:filing.analysisStatus,
  hasReport:!!summary?.report,
  snapshot:published&&analysis?{accession:published.filing.accessionNumber,reportDate:published.filing.reportDate||published.filing.filingDate,reportVersion:analysis.reportVersion}:null,
  edgarUrl:filing.edgarUrl,documentUrl:filing.documentUrl,
 };
}

/** The company's filings as digests: one upstream page of up to fifty, newest first. */
export async function loadFilings(ticker:string,fetcher:typeof fetch=fetch):Promise<PublicFilingDigestPage|null>{
 try{
  const response=await fetcher(ANALYSIS_ORIGIN+`/api/v1/companies/${ticker}/filings?limit=50`,{signal:AbortSignal.timeout(12000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const page=await response.json() as PublicFilingPage;
  if(page.ticker!==ticker||!Array.isArray(page.filings))return null;
  const filings=page.filings.filter(f=>f&&f.ticker===ticker&&ACCESSION.test(f.accessionNumber)).map(digestFiling);
  return {schemaVersion:"filing-digests.v1",ticker,filings,total:page.total??null,checkedAt:page.checkedAt??null};
 }catch{return null;}
}

/** One filing with its full published report, for the in-page reader; only the documented envelope passes through. */
export async function loadFilingDetail(ticker:string,accession:string,snapshot:{reportDate:string;reportVersion:string}|null,fetcher:typeof fetch=fetch):Promise<PublicFilingDetail|null>{
 if(!ACCESSION.test(accession))return null;
 try{
  const query=snapshot?"?"+new URLSearchParams(snapshot):"";
  const response=await fetcher(ANALYSIS_ORIGIN+`/api/v1/companies/${ticker}/filings/${accession}${query}`,{signal:AbortSignal.timeout(12000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const detail=await response.json() as PublicFilingDetail;
  if(detail.ticker!==ticker||detail.filing?.ticker!==ticker)return null;
  return {apiSchemaVersion:detail.apiSchemaVersion,ticker,company:detail.company?{ticker:detail.company.ticker,name:detail.company.name,cik:detail.company.cik}:null,filing:detail.filing};
 }catch{return null;}
}

/** A passage id is `p` and fourteen hex digits; the page links a quote to nothing else. */
const PASSAGE_ID=/^p[0-9a-f]{14,32}$/;
const str=(v:unknown):v is string=>typeof v==="string";
const strings=(v:unknown):string[]=>Array.isArray(v)?v.filter(str):[];
const neighbours=(v:unknown):Array<{passageId:string;text:string}>=>Array.isArray(v)?v.flatMap(n=>n&&typeof n==="object"&&PASSAGE_ID.test(String((n as {passageId?:unknown}).passageId))&&str((n as {text?:unknown}).text)?[{passageId:(n as {passageId:string}).passageId,text:(n as {text:string}).text}]:[]):[];
/** A passage table rebuilt cell by cell; a row or cell of the wrong shape drops the whole table rather than passing through. */
function readTable(v:unknown):LibraryTable|null{
 if(!v||typeof v!=="object")return null;
 const t=v as {unit?:unknown;columns?:unknown;rows?:unknown;notes?:unknown;xbrlBlock?:unknown};
 if(!Array.isArray(t.columns)||!t.columns.every(str)||!Array.isArray(t.rows))return null;
 const rows:LibraryTable["rows"]=[];
 for(const r of t.rows as unknown[]){
  if(!r||typeof r!=="object")return null;
  const row=r as {label?:unknown;path?:unknown;cells?:unknown};
  if(!str(row.label)||!Array.isArray(row.cells))return null;
  const cells:LibraryTable["rows"][number]["cells"]=[];
  for(const c of row.cells as unknown[]){
   if(!c||typeof c!=="object")return null;
   const cell=c as {text?:unknown;value?:unknown};
   if(!str(cell.text)||!(cell.value===null||typeof cell.value==="number"&&Number.isFinite(cell.value)))return null;
   cells.push({text:cell.text,value:cell.value});
  }
  rows.push({label:row.label,path:strings(row.path),cells});
 }
 return {unit:str(t.unit)?t.unit:null,columns:t.columns,rows,notes:strings(t.notes),xbrlBlock:str(t.xbrlBlock)?t.xbrlBlock:null};
}
/** One filing-library passage with its neighbours, for a quote that links to the filing's own words; only the typed fields pass through. */
export async function loadPassage(ticker:string,passageId:string,fetcher:typeof fetch=fetch):Promise<PublicPassage|null>{
 if(!PASSAGE_ID.test(passageId))return null;
 try{
  const response=await fetcher(ANALYSIS_ORIGIN+`/api/v1/companies/${ticker}/passages/${passageId}`,{signal:AbortSignal.timeout(8000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  const body=await response.json() as {schemaVersion?:unknown;status?:unknown;passage?:unknown};
  if(body.schemaVersion!=="passage-response.v1"||body.status!=="ready"||!body.passage||typeof body.passage!=="object")return null;
  const p=body.passage as {passageId?:unknown;ticker?:unknown;document?:unknown;path?:unknown;text?:unknown;table?:unknown;before?:unknown;after?:unknown};
  const d=(p.document&&typeof p.document==="object"?p.document:{}) as {documentId?:unknown;form?:unknown;docType?:unknown;filedAt?:unknown;reportDate?:unknown;url?:unknown};
  if(p.passageId!==passageId||p.ticker!==ticker||!str(p.text)||!str(d.documentId)||!str(d.form)||!str(d.docType)||!str(d.filedAt)||!str(d.reportDate)||!str(d.url))return null;
  return {passageId,ticker,document:{documentId:d.documentId,form:d.form,docType:d.docType,filedAt:d.filedAt,reportDate:d.reportDate,url:d.url},
   path:strings(p.path),text:p.text,table:p.table==null?null:readTable(p.table),before:neighbours(p.before),after:neighbours(p.after)};
 }catch{return null;}
}

/** SEC fundamentals series, stripped to the fields findings resolve against; provider and refresh state never pass through. */
export async function loadFundamentals(ticker:string,fetcher:typeof fetch=fetch):Promise<FindingFundamentals|null>{
 try{
  const response=await fetcher(ANALYSIS_ORIGIN+`/api/v1/companies/${ticker}/fundamentals?periodCount=12`,{signal:AbortSignal.timeout(12000),headers:{accept:"application/json"}});
  if(!response.ok)return null;
  return readFindingFundamentals(await response.json(),ticker);
 }catch{return null;}
}

export async function handle(request:Request,env:SiteEnv,ctx:SiteContext,upstream?:typeof fetch,cache?:Cache):Promise<Response>{
 const url=new URL(request.url);
 if(url.pathname.startsWith("/api/")){
  const fetcher=upstream??analysisFetcher(env);
  if(!fetcher)return json({error:"Read service unavailable"},503);
  const match=url.pathname.match(/^\/api\/business\/v1\/companies\/([A-Z][A-Z0-9.-]{0,11})(\/capital|\/findings|\/fundamentals|\/events|\/filings|\/filings\/\d{10}-\d{2}-\d{6}|\/passages\/p[0-9a-f]{14,32})?$/);
  const detail=match?.[2]?.startsWith("/filings/")?match[2].slice("/filings/".length):null;
  // The reader pins a report to its published revision; nothing else takes a query.
  const allowed=detail?new Set(["reportDate","reportVersion"]):new Set<string>();
  if(!match||[...url.searchParams.keys()].some(k=>!allowed.has(k)))return json({error:"Not found"},404);
  // A second share class reads as the class the data is kept under.
  match[1]=canonicalTicker(match[1]);
  if(request.method!=="GET")return json({error:"Method not allowed"},405);
  try{if(!env.PUBLIC_READ_LIMIT||!(await env.PUBLIC_READ_LIMIT.limit({key:request.headers.get("cf-connecting-ip")??"anonymous"})).success)return json({error:"Too many requests"},429);}catch{return json({error:"Read service unavailable"},503);}
  const key=new Request(url.href,{method:"GET"});const cached=await cache?.match(key);if(cached)return cached;
  if(match[2]){
   // Supplementary resources answer on their own and are cached only when they have something to say.
   const supplementary=async<T>(name:string,version:string,load:()=>Promise<T|null>)=>{const body=await load();const response=json({schemaVersion:version,status:body?"ready":"unavailable",[name]:body});if(!body)response.headers.set("cache-control","no-store");if(cache&&body)ctx.waitUntil(cache.put(key,response.clone()));return response;};
   if(match[2]==="/capital")return supplementary("capital","capital-response.v1",()=>loadCapital(match[1],fetcher));
   if(match[2]==="/findings"){const bundle=await loadFindings(match[1],fetcher);const response=json({schemaVersion:"findings-response.v1",status:bundle?"ready":"unavailable",findings:bundle?.findings??null,passages:bundle?.passages??[],peers:bundle?.peers??null});if(!bundle)response.headers.set("cache-control","no-store");if(cache&&bundle)ctx.waitUntil(cache.put(key,response.clone()));return response;}
   if(match[2]==="/events")return supplementary("events","events-response.v1",()=>loadEvents(match[1],fetcher));
   if(match[2]==="/filings")return supplementary("filings","filing-digests-response.v1",()=>loadFilings(match[1],fetcher));
   if(match[2].startsWith("/passages/"))return supplementary("passage","passage-response.v1",()=>loadPassage(match[1],match[2]!.slice("/passages/".length),fetcher));
   if(detail){const reportDate=url.searchParams.get("reportDate"),reportVersion=url.searchParams.get("reportVersion");
    const body=await loadFilingDetail(match[1],detail,reportDate&&reportVersion?{reportDate,reportVersion}:null,fetcher);
    if(!body)return json({error:"Not found"},404);
    const response=json(body);if(cache)ctx.waitUntil(cache.put(key,response.clone()));return response;}
   return supplementary("fundamentals","fundamentals-response.v1",()=>loadFundamentals(match[1],fetcher));
  }
  try{const [flow,explainer,guidance,tree]=await Promise.all([loadPublicFlow(match[1],fetcher),loadExplainer(match[1],fetcher),loadGuidance(match[1],fetcher),loadTree(match[1],fetcher)]);const response=json({...flow,explainer,guidance,tree});
   // An incomplete answer is never cached, so one slow upstream read cannot pin "preparing" for a minute.
   const cacheable=flow.status==="ready";
   if(!cacheable)response.headers.set("cache-control","no-store");
   if(cache&&cacheable)ctx.waitUntil(cache.put(key,response.clone()));return response;}catch{return json({error:"Public company data temporarily unavailable"},503);}
 }
 if(request.method!=="GET"&&request.method!=="HEAD")return json({error:"Method not allowed"},405);
 const response=await env.ASSETS.fetch(request);const headers=new Headers(response.headers);for(const [name,value]of Object.entries(security))headers.set(name,value);return new Response(response.body,{status:response.status,headers});
}
// No upstream fetcher is passed here on purpose: the data routes must read over the binding, never the public internet.
const worker = {fetch(request:Request,env:SiteEnv,ctx:SiteContext){return handle(request,env,ctx,undefined,typeof caches==="undefined"?undefined:(caches as CacheStorage & {default:Cache}).default);}};

export default worker;
