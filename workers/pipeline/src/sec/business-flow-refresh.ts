import type { BusinessFlowQuarter, PublicBusinessFlow } from '../../../../shared/analysis-contract/business-flow.ts';
import { D1SecRepository } from './d1.ts';
import { parseSecBusinessFlow } from './business-flow-parser.ts';
import { parseSecEarningsRelease } from './business-flow-release.ts';
import { discoverSecTicker } from './pipeline.ts';
import { streamSecSubmissionParts, type SecFiling, type SecFilingFeed } from './sec.ts';
import { assertDataTicker, requireDb } from '../core.ts';
import { normalizeTrackedTicker, parseTrackedTickers } from './config.ts';
import type { SecPipelineEnv } from '../operations.ts';
import { businessFlowCacheKey } from './business-flow-cache.ts';
export {buildPublishedBusinessQuarter} from '../../../../shared/analysis-runtime/financial-data/disclosed-quarter.ts';
import {buildPublishedBusinessQuarter} from '../../../../shared/analysis-runtime/financial-data/disclosed-quarter.ts';
/** Bounded, deterministic SEC extraction. No model calls, workflows or account data. */
export async function refreshSecBusinessFlow(env:SecPipelineEnv,ticker:string,fetcher:typeof fetch=fetch):Promise<{ticker:string;quarters:number;issues:string[]}> {
 assertDataTicker(env,ticker);const repository=new D1SecRepository(requireDb(env));
 const cachedFeed=await repository.getCache<SecFilingFeed>(`sec:filings:${ticker}`);
 const feed=cachedFeed?.payload ?? (await discoverSecTicker(ticker,{userAgent:env.SEC_USER_AGENT,fetcher})).feed;
 const filings=feed.filings as SecFiling[];
 const events=filings.filter(f=>/^8-K(\/A)?$/.test(f.form));
 const selected=[...filings.filter(f=>/^(10-Q|10-K)(\/A)?$/.test(f.form)).slice(0,2),...events.filter(f=>/2\.02/.test(f.items)).slice(0,2),...events.slice(0,4)].filter((f,i,all)=>all.findIndex(a=>a.accessionNumber===f.accessionNumber)===i);
 const quarters=new Map<string,BusinessFlowQuarter>();const issues:string[]=[];
 for(const filing of selected){
  try {
   let documents:Array<{url:string;html:string}>;
   if(/^10-/.test(filing.form)){
    const url=new URL(filing.documentUrl);if(url.origin!=='https://www.sec.gov'||!url.pathname.startsWith('/Archives/'))throw new Error('Invalid SEC source');
    const response=await fetcher(url,{headers:{'user-agent':env.SEC_USER_AGENT,accept:'text/html'},signal:AbortSignal.timeout(25000)});if(!response.ok)throw new Error(`SEC HTTP ${response.status}`);const html=await response.text();if(html.length>6_000_000)throw new Error('SEC document exceeds extraction limit');documents=[{url:url.href,html}];
   }else{
    const parts=await streamSecSubmissionParts(Number(filing.cik),filing.accessionNumber,fetcher,env.SEC_USER_AGENT);
    documents=parts.filter(p=>/^EX-99/.test(p.type)&&/^[\w.-]+\.html?$/.test(p.filename)).slice(0,2).map(p=>({url:`https://www.sec.gov/Archives/edgar/data/${Number(filing.cik)}/${filing.accessionNumber.replaceAll('-','')}/${p.filename}`,html:p.text}));
   }
   for(const document of documents){
    const source={sourceUrl:document.url,accession:filing.accessionNumber,...(/^10-Q/.test(filing.form)&&filing.reportDate?{periodEnd:filing.reportDate}:{})};
    const parsed=document.html.includes('ix:nonFraction')?parseSecBusinessFlow(document.html,source):parseSecEarningsRelease(document.html,source);
    for(const item of parsed){const quarter=buildPublishedBusinessQuarter(item,filing.filingDate);if(quarter && !quarters.has(quarter.id))quarters.set(quarter.id,quarter);}
   }
   const dates=[...quarters.keys()].sort().reverse();if(dates.length>=2&&(Date.parse(dates[0])-Date.parse(dates[1]))/86400000<111)break;
  }catch{issues.push(`未能解析 ${filing.accessionNumber}；保留已核验披露。`);}
 }
 if(!quarters.size) return {ticker,quarters:0,issues};
 const previous=await repository.getCache<PublicBusinessFlow>(businessFlowCacheKey(ticker));
 for(const q of previous?.payload.quarters??[])if(!quarters.has(q.id))quarters.set(q.id,q);
 const fetchedAt=new Date().toISOString();const flow:PublicBusinessFlow={schemaVersion:'business-flow.v1',ticker,fetchedAt,quarters:[...quarters.values()].sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd)).slice(0,8)};
 await repository.setCache(businessFlowCacheKey(ticker),flow,fetchedAt);return {ticker,quarters:flow.quarters.length,issues};
}
export async function handleBusinessFlowRefresh(request:Request,env:SecPipelineEnv):Promise<Response>{
 if(request.method!=='POST')return new Response('Not found',{status:404});
 if(!env.SEC_REFRESH_KEY||request.headers.get('x-sec-refresh-key')!==env.SEC_REFRESH_KEY)return Response.json({error:'Unauthorized'},{status:401});
 const ticker=normalizeTrackedTicker(new URL(request.url).pathname.split('/').at(-1));if(!ticker)return Response.json({error:'Invalid ticker'},{status:400});
 try{assertDataTicker(env,ticker);}catch{return Response.json({error:'Ticker is not tracked'},{status:403});}
 try{return Response.json(await refreshSecBusinessFlow(env,ticker));}catch{return Response.json({error:'SEC financial refresh failed; previous disclosure retained'},{status:503});}
}
export async function runBusinessFlowBootstrap(env:SecPipelineEnv):Promise<{results:unknown[]}>{
 const targets=parseTrackedTickers((env as SecPipelineEnv & {SEC_BUSINESS_FLOW_BOOTSTRAP_TICKERS?:string}).SEC_BUSINESS_FLOW_BOOTSTRAP_TICKERS).slice(0,1);const results:unknown[]=[];
 for(const ticker of targets){assertDataTicker(env,ticker);const previous=await new D1SecRepository(requireDb(env)).getCache<PublicBusinessFlow>(businessFlowCacheKey(ticker));if(previous&&Date.now()-Date.parse(previous.fetchedAt)<24*60*60_000)continue;results.push(await refreshSecBusinessFlow(env,ticker));}return {results};
}
