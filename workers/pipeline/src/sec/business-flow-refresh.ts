import type { BusinessFlowQuarter, BusinessSegment, FlowAmount, FlowMetric, PublicBusinessFlow } from '../../../../shared/analysis-contract/business-flow.ts';
import { D1SecRepository } from './d1.ts';
import { parseSecBusinessFlow, type BusinessFact, type ParsedBusinessQuarter } from './business-flow-parser.ts';
import { parseSecEarningsRelease } from './business-flow-release.ts';
import { discoverSecTicker } from './pipeline.ts';
import { streamSecSubmissionParts, type SecFiling, type SecFilingFeed } from './sec.ts';
import { assertTrackedTicker, requireDb } from '../core.ts';
import { normalizeTrackedTicker, parseTrackedTickers } from './config.ts';
import type { SecPipelineEnv } from '../operations.ts';
import { BUSINESS_FLOW_PARSER_VERSION, businessFlowCacheKey } from './business-flow-cache.ts';
const sum = (facts: BusinessFact[]) => facts.reduce((v,f)=>v+f.value,0);
const groupFor = (id: string) => id === 'ResearchAndDevelopmentExpense' ? 'research' : id === 'SellingAndMarketingExpense' ? 'sales' : id === 'GeneralAndAdministrativeExpense' ? 'administration' : ['CloudAndSoftwareExpenses','HardwareExpenses','ServicesExpense'].includes(id) ? 'direct' : 'other';
const canonicalRevenue = (id: string) => id === 'SalesRevenueServicesNet1' ? 'SalesRevenueServicesNet' : id;
export function buildPublishedBusinessQuarter(parsed: ParsedBusinessQuarter, filedAt: string): BusinessFlowQuarter | null {
 if(parsed.profile !== 'direct_operating' || Object.values(parsed.coverage).some(v=>!v) || parsed.issues.length) return null;
 const source = Object.values(parsed.financials)[0]?.lineage;
 if(!source || !parsed.expenses.length || !parsed.revenues.length) return null;
 const amount=(fact:BusinessFact,definition:string,value=fact.value):FlowAmount=>({value:String(value),basis:value===fact.value?'reported':'derived',definition:`${BUSINESS_FLOW_PARSER_VERSION}:${definition}`,comparabilityKey:`${BUSINESS_FLOW_PARSER_VERSION}:${definition}:original-disclosure`,sourceIds:[fact.lineage.accession],lineage:[{accession:fact.lineage.accession,url:fact.lineage.sourceUrl,concept:fact.lineage.tag,contextId:fact.lineage.contextId,periodStart:fact.lineage.start,periodEnd:fact.lineage.end,dimensions:fact.lineage.dimensions,parserVersion:BUSINESS_FLOW_PARSER_VERSION}]});
 const f=parsed.financials;
 const figures:BusinessFlowQuarter['figures']={};
 for(const [target,field] of [['revenue','revenue'],['operatingExpenses','totalOperatingExpenses'],['operating','operatingIncome'],['pretax','pretaxIncome'],['tax','taxExpense'],['net','netIncome']] as const) if(f[field])figures[target]=amount(f[field],target);
 if(!f.interestExpense || !f.otherIncome) return null;
 const otherComponents=[{id:'interest',name:'利息费用',amount:amount(f.interestExpense,'interest',-f.interestExpense.value)},{id:'nonoperating',name:'其他非营业损益',amount:amount(f.otherIncome,'nonoperating')}];
 figures.other={...amount(f.otherIncome,'other',f.otherIncome.value-f.interestExpense.value),basis:'derived',formula:'其他非营业损益 − 利息费用',lineage:otherComponents.flatMap(c=>c.amount.lineage??[])};
 const expenseComponents=parsed.expenses.map(c=>({id:c.id,name:c.label,group:groupFor(c.id) as 'direct'|'research'|'sales'|'administration'|'other',amount:amount(c.fact,c.id)}));
 for(const [key,group] of [['research','research'],['sales','sales'],['administration','administration']] as const){const c=expenseComponents.find(c=>c.group===group);if(c)figures[key]=c.amount;}
 const revenueGroups = new Map<string, typeof parsed.revenues>();
 for(const leaf of parsed.revenues){const id=canonicalRevenue(leaf.id);const key=['CloudApplications','CloudInfrastructure','CloudRevenues'].includes(id)?'cloud':['SoftwareLicense','SoftwareSupport','SoftwareRevenues'].includes(id)?'software':id;revenueGroups.set(key,[...(revenueGroups.get(key)??[]),leaf]);}
 const segments:BusinessSegment[]=[...revenueGroups].map(([id,leaves])=>{
  const children=leaves.map(l=>({id:canonicalRevenue(l.id),name:l.label,revenue:amount(l.fact,canonicalRevenue(l.id))}));
  const total=sum(leaves.map(l=>l.fact));
  const revenue=leaves.length===1?children[0].revenue:{...amount(leaves[0].fact,`revenue-group:${id}`,total),basis:'derived' as const,formula:children.map(l=>l.name).join(' + '),lineage:children.flatMap(l=>l.revenue.lineage??[])};
  return {id,name:id==='cloud'?'云服务':id==='software'?'软件':leaves[0].label,revenue,children:leaves.length>1?children:undefined,description:'原始财报按产品或服务类别披露的业务收入；包含的具体产品以原文业务说明为准。',products:children.map(l=>l.name),customers:null,monetization:'此类别收入来自相应产品、许可、支持或服务；单个产品的收入未单独披露时不分配比例。',disclosure:'季度收入叶子不重叠；分类加总对应公司收入。费用仅在合并层面绘制，不臆分到产品。',sourceIds:[source.accession]};
 });
 const values=(keys:FlowMetric[])=>keys.map(k=>Number(figures[k]?.value));
 const [r,o,p,t,n]=values(['revenue','operating','pretax','tax','net']);
 const tolerance=Math.max(1,Math.abs(r)*1e-9);
 if([r,o,p,t,n].some(v=>!Number.isFinite(v)) || Math.abs(r-sum(parsed.expenses.map(c=>c.fact))-o)>tolerance || Math.abs(o-f.interestExpense.value+f.otherIncome.value-p)>tolerance || Math.abs(p-t-n)>tolerance)return null;
 return {id:parsed.end,incomeModel:'direct_operating',label:`截至 ${parsed.end} 的三个月`,periodStart:parsed.start,periodEnd:parsed.end,periodType:'3M',currency:parsed.currency,scale:1,basisLabel:'SEC 原始季度披露 · 直接营业费用口径（未披露 GAAP 毛利）· 各期原披露分类对比',reportedAt:filedAt,figures,segments,segmentsComplete:true,expenseComponents,otherComponents,sources:[{id:source.accession,title:`SEC 原文 ${source.accession}`,url:source.sourceUrl,publishedAt:filedAt}]};
}
/** Bounded, deterministic SEC extraction. No model calls, workflows or account data. */
export async function refreshSecBusinessFlow(env:SecPipelineEnv,ticker:string,fetcher:typeof fetch=fetch):Promise<{ticker:string;quarters:number;issues:string[]}> {
 assertTrackedTicker(env,ticker);const repository=new D1SecRepository(requireDb(env));
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
 try{assertTrackedTicker(env,ticker);}catch{return Response.json({error:'Ticker is not tracked'},{status:403});}
 try{return Response.json(await refreshSecBusinessFlow(env,ticker));}catch{return Response.json({error:'SEC financial refresh failed; previous disclosure retained'},{status:503});}
}
export async function runBusinessFlowBootstrap(env:SecPipelineEnv):Promise<{results:unknown[]}>{
 const targets=parseTrackedTickers((env as SecPipelineEnv & {SEC_BUSINESS_FLOW_BOOTSTRAP_TICKERS?:string}).SEC_BUSINESS_FLOW_BOOTSTRAP_TICKERS).slice(0,1);const results:unknown[]=[];
 for(const ticker of targets){assertTrackedTicker(env,ticker);const previous=await new D1SecRepository(requireDb(env)).getCache<PublicBusinessFlow>(businessFlowCacheKey(ticker));if(previous&&Date.now()-Date.parse(previous.fetchedAt)<24*60*60_000)continue;results.push(await refreshSecBusinessFlow(env,ticker));}return {results};
}
