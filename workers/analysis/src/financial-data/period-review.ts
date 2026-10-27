import {extractVerifiedCurrentQuarters,type Fact,type DocumentSource} from './parser.ts';
import {checkCompleteFlow} from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import type {IncomeCalculation,RevenueStructure} from './calculation.ts';
import type {BridgeStructure} from './bridge.ts';
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
/** A face-statement line may be tagged with a member; its printed row still belongs to the statement. */
const statementFacts=(facts:Fact[])=>facts.filter(f=>f.statementRow||Object.keys(f.dimensions).every(a=>['StatementBusinessSegmentsAxis','ProductOrServiceAxis','ConsolidationItemsAxis'].includes(a.split(':').at(-1)!)));
/** Q4 is FY minus nine months, using the exact same monetary concept, currency and dimensions. */
function fourthQuarterFacts(annuals:Fact[],facts:Fact[]):Fact[]{
 const derived:Fact[]=[];
 for(const annual of annuals){
  const prior=facts.find(f=>f.start===annual.start&&key(f)===key(annual)&&days(f.start,f.end)>230&&days(f.start,f.end)<310&&days(f.end,annual.end)>=70&&days(f.end,annual.end)<=110);
  if(prior)derived.push({...annual,start:nextDay(prior.end),context:`derived:${annual.context}-${prior.context}`,value:annual.value-prior.value,precision:Math.min(annual.precision,prior.precision),operands:[annual,prior],formula:`Fourth quarter ${annual.value-prior.value} = full fiscal year ${annual.value} − first nine months ${prior.value}, same fiscal year, currency, concept and dimensions`});
 }
 return derived;
}
/**
 * Every fiscal fourth quarter an annual report and the third-quarter report before it can establish: each year the annual
 * report presents, current and comparative, less the same year's nine months as the third-quarter report presents them.
 * Both reports present the comparative year on the current year's basis, so a fourth quarter and its year-ago quarter compare.
 */
export function fiscalFourthQuarters(annualReport:Fact[],thirdQuarterReport:Fact[],revenueStructure:RevenueStructure|null=null):BusinessFlowQuarter[]{
 const facts=precisionSelect([...annualReport,...thirdQuarterReport]);if(!facts)return [];
 const annuals=statementFacts(facts).filter(f=>annualReport.includes(f)&&days(f.start,f.end)>330);
 const byEnd=new Map<string,Fact[]>();
 for(const f of fourthQuarterFacts(annuals,facts))byEnd.set(f.end,[...(byEnd.get(f.end)??[]),f]);
 return [...byEnd.values()].flatMap(q=>extractVerifiedCurrentQuarters({...q[0].source,revenueStructure},q).quarters).map(q=>({...q,basisLabel:q.basisLabel+' · fourth quarter = full year − first nine months, same basis'}));
}
/** Every source line an amount of the quarters rests on, as concept and dimensions. */
const usedLines=(value:unknown,found=new Set<string>()):Set<string>=>{
 if(Array.isArray(value))for(const v of value)usedLines(v,found);
 else if(value&&typeof value==='object'){const o=value as Record<string,unknown>;if(typeof o.concept==='string'&&o.dimensions&&typeof o.dimensions==='object')found.add([o.concept,JSON.stringify(Object.entries(o.dimensions as Record<string,string>).sort())].join('|'));for(const v of Object.values(o))usedLines(v,found);}
 return found;
};
/**
 * Whether an annual report left every line its fourth quarters use as the previous annual report presented it, for the
 * fiscal years both present. A note that prior periods were reclassified or recast then moved none of those lines (a
 * cash-flow line, a geographic attribution), so the third-quarter report's nine months are on the annual report's basis.
 * Lines are compared by concept and dimensions, never by the note's wording; with no shared year nothing is proven.
 */
export function priorYearsUnchanged(quarters:BusinessFlowQuarter[],annualReport:Fact[],priorAnnualReport:Fact[]):boolean{
 const used=usedLines(quarters),line=(f:Fact)=>[f.tag,JSON.stringify(Object.entries(f.dimensions).sort())].join('|'),at=(f:Fact)=>[line(f),f.currency,f.start,f.end].join('|');
 const prior=new Map<string,Fact>();
 for(const f of priorAnnualReport){if(f.operands||days(f.start,f.end)<=330)continue;const old=prior.get(at(f));if(!old||f.precision>old.precision)prior.set(at(f),f);}
 let compared=0;
 for(const f of annualReport){
  if(f.operands||days(f.start,f.end)<=330||!used.has(line(f)))continue;
  const p=prior.get(at(f));if(!p)continue;compared++;
  const rounding=10**-Math.min(f.precision,p.precision);
  if(Math.abs(f.value-p.value)>Math.max(1,Number.isFinite(rounding)?rounding*1.5:1))return false;
 }
 return compared>0;
}
/** The quarter before each current quarter as the same filing's two-quarter cumulative period less that quarter, same concept, currency and dimensions. */
function earlierQuarterFacts(current:Fact[],facts:Fact[],previousEnd:string):Fact[]{
 const derived:Fact[]=[];
 for(const q of current){
  const cumulative=facts.find(f=>f.end===q.end&&f.start<q.start&&key(f)===key(q)&&f.source.accession===q.source.accession&&days(f.start,previousEnd)>=70&&days(f.start,previousEnd)<=110);
  if(cumulative)derived.push({...cumulative,end:previousEnd,context:`derived:${cumulative.context}-${q.context}`,value:Math.round((cumulative.value-q.value)*1e6)/1e6,precision:Math.min(cumulative.precision,q.precision),operands:[cumulative,q],formula:`First quarter = six months to date ${cumulative.value} − second quarter ${q.value}, same filing, concept and dimensions`});
 }
 return derived;
}
/**
 * The verified newest quarter and the quarter before it. `firstReport` says no earlier periodic report is listed for the
 * issuer (a newly listed company's first 10-Q): the quarter before then comes from that report's own cumulative period.
 */
export function reviewedCurrentPair(all:Fact[],expected:string,documents:Array<{source:DocumentSource;html?:string;eligible:boolean}>,calculations:Record<string,IncomeCalculation>={},presentation:{structure:BridgeStructure;version:string}|null=null,revenueStructures:Record<string,RevenueStructure>={},firstReport=false):{quarters:BusinessFlowQuarter[];reviewed:boolean}{
 const facts=precisionSelect(all);if(!facts)return {quarters:[],reviewed:false};
 const usable=statementFacts(facts);
 const current=usable.filter(f=>f.end===expected&&days(f.start,f.end)>=70&&days(f.start,f.end)<=110);
 let quarterFacts=current;
 if(!quarterFacts.length)quarterFacts=fourthQuarterFacts(usable.filter(f=>f.end===expected&&days(f.start,f.end)>330),facts);
 if(!quarterFacts.length)return {quarters:[],reviewed:false};
 const start=quarterFacts[0].start,previousEnd=new Date(Date.parse(start)-86400000).toISOString().slice(0,10);
 let directPrevious=usable.filter(f=>f.end===previousEnd&&days(f.start,f.end)>=70&&days(f.start,f.end)<=110);
 if(!directPrevious.length&&firstReport)directPrevious=earlierQuarterFacts(quarterFacts.filter(f=>!f.operands),usable,previousEnd);
 if(!directPrevious.length)return {quarters:[],reviewed:false};
 const pool=[...facts,...directPrevious.filter(f=>f.operands)];
 const required=(items:Fact[])=>items.filter(f=>Object.keys(f.dimensions).length===0&&/^(?:RevenueFromContractWithCustomerExcludingAssessedTax|Revenues|SalesRevenueNet|CostOfRevenue|CostOfGoodsAndServicesSold|GrossProfit|OperatingExpenses|OperatingIncomeLoss|IncomeTaxExpenseBenefit|NetIncomeLoss|ProfitLoss|ResearchAndDevelopmentExpense|SellingAndMarketingExpense|GeneralAndAdministrativeExpense|IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest|Revenue|RevenueFromContractsWithCustomers|CostOfSales|ProfitLossFromOperatingActivities|ProfitLossBeforeTax|IncomeTaxExpenseContinuingOperations)$/.test(f.tag.split(':').at(-1)!));
 // Current cumulative minus the disclosed current quarter must equal the prior filing cumulative.
 // This checks the prior-period presentation in every used statement and segment concept, not a note keyword alone.
 for(const q of quarterFacts){if(q.operands)continue;const cumulative=facts.find(f=>f.end===expected&&f.start<q.start&&key(f)===key(q));const prior=cumulative&&pool.find(f=>f.start===cumulative.start&&f.end===previousEnd&&key(f)===key(q));
  if(!cumulative||!prior){if(required([q]).length)return {quarters:[],reviewed:false};continue;}
  const rounding=10**(-Math.min(q.precision,cumulative.precision,prior.precision));if(Math.abs(cumulative.value-q.value-prior.value)>Math.max(1,rounding*1.5))return {quarters:[],reviewed:false};
 }
 // Arithmetic is the review: a line whose earlier period moved fails the check above, whatever the filing's notes say.
 if(!required(quarterFacts).length)return {quarters:[],reviewed:false};
 const latestSource=quarterFacts[0].source,previousSource=directPrevious[0].source;
 const extract=(source:DocumentSource,items:Fact[])=>extractVerifiedCurrentQuarters({...source,calculation:calculations[source.accession]??null,revenueStructure:revenueStructures[source.accession]??null,presentation},items).quarters;
 const quarters=[...extract(latestSource,quarterFacts),...extract(previousSource,directPrevious)].filter(q=>q.periodEnd===expected||q.periodEnd===previousEnd);
 for(const q of quarters){q.basisLabel=(q.incomeModel==='insurance'?'Insurance and diversified operations · investment gains shown separately · net income includes noncontrolling interests · ':'')+'As reported in the current fiscal year\'s SEC filings · verified against adjacent cumulative periods; a fourth quarter is derived only as the full year less nine months on the same basis';
  for(const document of documents)if(!q.sources.some(s=>s.id===document.source.accession))q.sources.push({id:document.source.accession,title:'SEC cumulative and reclassification check '+document.source.accession,url:document.source.url,publishedAt:document.source.filedAt});}
 return {quarters,reviewed:checkCompleteFlow({schemaVersion:'business-flow.v1',ticker:latestSource.cik,fetchedAt:null,quarters}).complete};
}
