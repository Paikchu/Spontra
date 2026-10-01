import {extractVerifiedCurrentQuarters,type Fact,type DocumentSource} from './parser.ts';
import {checkCompleteFlow} from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import type {BusinessFlowQuarter} from '../../../../shared/analysis-contract/business-flow.ts';
const key=(f:Fact)=>[f.tag,f.currency,JSON.stringify(Object.entries(f.dimensions).sort())].join('|');
const days=(start:string,end:string)=>(Date.parse(end)-Date.parse(start))/86400000;
const nextDay=(date:string)=>new Date(Date.parse(date)+86400000).toISOString().slice(0,10);
const precisionSelect=(facts:Fact[])=>{
 const selected=new Map<string,Fact>();
 for(const f of facts){const id=[f.start,f.end,key(f)].join('|'),old=selected.get(id);if(!old||f.precision>old.precision)selected.set(id,f);else if(old.precision===f.precision&&old.value!==f.value)return null;}
 return [...selected.values()];
};
/** Only presentation changes to prior periods are eligible for quantitative review.
 * True income-statement restatements stay terminal until a disclosure-specific review exists. */
export function priorPresentationOnly(html:string):boolean{
 const text=html.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ');
 const scrub=text.replace(/(?:Recast of Certain Prior Period Information )?We have recast certain prior period amounts on our consolidated cash flows statements[^.]*\.\s*The recast of these prior period amounts had no impact on our consolidated balance sheets, consolidated income statements[^.]*\./gi,'');
 const matches=scrub.split(/\.(?: |$)/).filter(s=>/\bas\s+restated\b|\b(?:prior[- ](?:period|year)|previously reported|comparative|historical)[^.]{0,180}\b(?:recast|restated|reclassified)\b|\b(?:recast|restated)[^.]{0,180}\b(?:income|segment|financial statement)/i.test(s));
 if(matches.length&&/<ix:nonNumeric[^>]*name=["']dei:DocumentFiscalPeriodFocus["'][^>]*>\s*FY\s*<\/ix:nonNumeric>/i.test(html))return false;
 return matches.every(s=>/prior period amounts[^.]*have been reclassified to conform to the current period(?:&#8217;s|'s)? presentation/i.test(s));
}
export function reviewedCurrentPair(all:Fact[],expected:string,documents:Array<{source:DocumentSource;html?:string;eligible:boolean}>):{quarters:BusinessFlowQuarter[];reviewed:boolean}{
 const facts=precisionSelect(all);if(!facts)return {quarters:[],reviewed:false};
 const usable=facts.filter(f=>Object.keys(f.dimensions).every(a=>['StatementBusinessSegmentsAxis','ProductOrServiceAxis','ConsolidationItemsAxis'].includes(a.split(':').at(-1)!)));
 const current=usable.filter(f=>f.end===expected&&days(f.start,f.end)>=70&&days(f.start,f.end)<=110);
 let quarterFacts=current;
 // Q4 is FY minus nine months, using the exact same monetary concept, currency and dimensions.
 if(!quarterFacts.length){const derived:Fact[]=[];for(const annual of usable.filter(f=>f.end===expected&&days(f.start,f.end)>330)){
   const prior=facts.find(f=>f.start===annual.start&&key(f)===key(annual)&&days(f.start,f.end)>230&&days(f.start,f.end)<310&&days(f.end,annual.end)>=70&&days(f.end,annual.end)<=110);
   if(prior)derived.push({...annual,start:nextDay(prior.end),context:`derived:${annual.context}-${prior.context}`,value:annual.value-prior.value,precision:Math.min(annual.precision,prior.precision),operands:[annual,prior],formula:`同一财年、币种、概念和维度的全年累计 ${annual.value} − 前九个月累计 ${prior.value} = 第四季度 ${annual.value-prior.value}`});
  }quarterFacts=derived;}
 if(!quarterFacts.length)return {quarters:[],reviewed:false};
 const start=quarterFacts[0].start,previousEnd=new Date(Date.parse(start)-86400000).toISOString().slice(0,10);
 const directPrevious=usable.filter(f=>f.end===previousEnd&&days(f.start,f.end)>=70&&days(f.start,f.end)<=110);
 if(!directPrevious.length)return {quarters:[],reviewed:false};
 const required=(items:Fact[])=>items.filter(f=>Object.keys(f.dimensions).length===0&&/^(?:RevenueFromContractWithCustomerExcludingAssessedTax|Revenues|SalesRevenueNet|CostOfRevenue|CostOfGoodsAndServicesSold|GrossProfit|OperatingExpenses|OperatingIncomeLoss|IncomeTaxExpenseBenefit|NetIncomeLoss|ProfitLoss|ResearchAndDevelopmentExpense|SellingAndMarketingExpense|GeneralAndAdministrativeExpense|IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest)$/.test(f.tag.split(':').at(-1)!));
 // Current cumulative minus the disclosed current quarter must equal the prior filing cumulative.
 // This checks the prior-period presentation in every used statement and segment concept, not a note keyword alone.
 for(const q of quarterFacts){if(q.operands)continue;const cumulative=facts.find(f=>f.end===expected&&f.start<q.start&&key(f)===key(q));const prior=cumulative&&facts.find(f=>f.start===cumulative.start&&f.end===previousEnd&&key(f)===key(q));
  if(!cumulative||!prior){if(required([q]).length)return {quarters:[],reviewed:false};continue;}
  const rounding=10**(-Math.min(q.precision,cumulative.precision,prior.precision));if(Math.abs(cumulative.value-q.value-prior.value)>Math.max(1,rounding*1.5))return {quarters:[],reviewed:false};
 }
 if(!required(quarterFacts).length||documents.some(d=>!d.eligible))return {quarters:[],reviewed:false};
 const latestSource=quarterFacts[0].source,previousSource=directPrevious[0].source;
 const extract=(source:DocumentSource,items:Fact[])=>extractVerifiedCurrentQuarters(source,items).quarters;
 const quarters=[...extract(latestSource,quarterFacts),...extract(previousSource,directPrevious)].filter(q=>q.periodEnd===expected||q.periodEnd===previousEnd);
 for(const q of quarters){q.basisLabel=(q.incomeModel==='insurance'?'保险及综合业务 · 投资损益单列 · 净利润含少数股东权益 · ':'')+'SEC 当前财年原披露口径 · 相邻期间累计桥核验；第四季度仅按同口径全年减九个月推导';
  for(const document of documents)if(!q.sources.some(s=>s.id===document.source.accession))q.sources.push({id:document.source.accession,title:'SEC 累计与重分类范围核验 '+document.source.accession,url:document.source.url,publishedAt:document.source.filedAt});}
 return {quarters,reviewed:checkCompleteFlow({schemaVersion:'business-flow.v1',ticker:latestSource.cik,fetchedAt:null,quarters}).complete};
}
