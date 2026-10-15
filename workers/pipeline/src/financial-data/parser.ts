import {SEC_DOCUMENT_MAX_BYTES} from '../../../../shared/analysis-runtime/financial-data/limits.ts';
import {readStatementTableFacts} from './statement-table.ts';
import {parseSecBusinessFlow} from '../../../../shared/analysis-runtime/financial-data/business-flow-parser.ts';
import {parseSecEarningsRelease} from '../../../../shared/analysis-runtime/financial-data/business-flow-release.ts';
import {buildPublishedBusinessQuarter} from '../../../../shared/analysis-runtime/financial-data/disclosed-quarter.ts';
import type { BusinessFlowQuarter, FlowAmount, FlowMetric, BusinessSegment } from '../../../../shared/analysis-contract/business-flow.ts';
import { disclosedWholeCompany } from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import {extractFilingDisclosures} from '../../../../shared/analysis-runtime/financial-data/disclosure-extraction.ts';
import {extractFinancialStatements} from '../../../../shared/analysis-runtime/financial-data/financial-statements.ts';
import {memberName} from './member-labels.ts';
import {readIncomeStatementCells} from '../../../../shared/analysis-runtime/financial-data/income-statement.ts';
export interface DocumentSource {url:string;accession:string;filedAt:string;cik:string;industry:'standard'|'financial'|'insurance'|'unknown';fiscalYear?:string;singleSegment?:boolean;
 /** The filing's labels for its dimension members (member-labels.ts); handed to each dimensional fact, not kept on its source. */
 memberLabels?:Record<string,string>;}
export const SEC_FLOW_PARSER_VERSION='deterministic-sec.v12';
/** Issuers read through a disclosure-specific profile; generic statement arithmetic would describe them in another scheme. */
export const hasDisclosureProfile=(cik:string)=>cik==='0001341439';
export interface Fact {source:DocumentSource;operands?:Fact[];formula?:string;precision:number;tag:string;value:number;currency:string;start:string;end:string;context:string;dimensions:Record<string,string>;
 /** The issuer's income statement row printing this fact; flip means the statement shows it with the opposite sign. */
 statementRow?:{order:number;label:string;flip:boolean};
 /** The filing's label for each member of this fact's dimensions. */
 memberLabels?:Record<string,string>;}
const text=(s:string)=>s.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').trim();
const attrs=(s:string)=>Object.fromEntries([...s.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1].toLowerCase(),m[2]]));
const local=(tag:string)=>tag.split(':').at(-1)!;
const tags:Partial<Record<FlowMetric,string[]>>={revenue:['RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet'],cost:['CostOfRevenue','CostOfGoodsAndServicesSold'],gross:['GrossProfit'],operatingExpenses:['OperatingExpenses'],operating:['OperatingIncomeLoss'],other:['NonoperatingIncomeExpense','OtherNonoperatingIncomeExpense'],pretax:['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest','IncomeLossFromContinuingOperationsIncludingNoncontrollingInterestBeforeIncomeTaxesExtraordinaryItems'],tax:['IncomeTaxExpenseBenefit'],net:['IncomeLossFromContinuingOperations','NetIncomeLoss','ProfitLoss'],research:['ResearchAndDevelopmentExpense'],sales:['SellingAndMarketingExpense','SellingExpense'],administration:['GeneralAndAdministrativeExpense']};
const flowConcepts=new Set([...Object.values(tags).flat(), 'RevenuesNetOfInterestExpense','NoninterestExpense','CostsAndExpenses','ProvisionForLoanLeaseAndOtherLosses','SellingGeneralAndAdministrativeExpense','GainLossOnInvestments','IncomeLossFromEquityMethodInvestments']);
const needsRestatementReview=(html:string)=>text(html).replace(/\s+/g,' ').split(/\.(?: |$)/).some(p=>/\bas\s+restated\b|\b(?:prior[- ](?:period|year)|previously reported|comparative|historical)[^.]{0,180}\b(?:recast|restated|reclassified)\b|\b(?:recast|restated)[^.]{0,180}\b(?:income|segment|financial statement)/i.test(p)&&!/no impact on[^.]*consolidated (?:income|statements of income)/i.test(p));
const near=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1,Math.max(Math.abs(a),Math.abs(b))*1e-9);
export function readReportedFacts(html:string,source:DocumentSource):{facts:Fact[];issues:string[]}{
 if(!/<ix:nonFraction/i.test(html))return {facts:readStatementTableFacts(html,source),issues:[]};
 source={...source,singleSegment:/the company operates (?:its business )?in (?:one|a single) operating segment/i.test(text(html).replace(/\s+/g,' ')),fiscalYear:text(html.match(/<ix:nonNumeric[^>]*name=["\']dei:DocumentFiscalYearFocus["\'][^>]*>([\s\S]*?)<\/ix:nonNumeric>/i)?.[1]??'')};
 const {memberLabels,...factSource}=source;source=factSource;
 const issues:string[]=[];
 const contexts=new Map<string,{start:string;end:string;dimensions:Record<string,string>}>();
 for(const m of html.matchAll(/<(?:[\w-]+:)?context\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?context\s*>/gi)){
  const a=attrs(m[1]),start=m[2].match(/<(?:[\w-]+:)?startDate[^>]*>([^<]+)/i)?.[1],end=m[2].match(/<(?:[\w-]+:)?endDate[^>]*>([^<]+)/i)?.[1],issuer=m[2].match(/<(?:[\w-]+:)?identifier[^>]*>([^<]+)/i)?.[1];if(!a.id||!start||!end||!issuer||issuer.replace(/^0+/,'')!==source.cik.replace(/^0+/,''))continue;
  const days=(Date.parse(end)-Date.parse(start))/86400000;if(days<70||days>380||!Number.isFinite(days))continue;const dimensions:Record<string,string>={};for(const d of m[2].matchAll(/<(?:[\w-]+:)?explicitMember\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?explicitMember\s*>/gi)){dimensions[attrs(d[1]).dimension]=text(d[2]);}if(/typedMember/i.test(m[2]))continue;contexts.set(a.id,{start,end,dimensions});
 }
 const units=new Map<string,string>();for(const m of html.matchAll(/<(?:[\w-]+:)?unit\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?unit\s*>/gi)){const measure=m[2].match(/<[^>]*measure[^>]*>\s*iso4217:([A-Z]{3})\s*</i)?.[1];if(measure&&!/divide/i.test(m[2]))units.set(attrs(m[1]).id,measure);}
 const buckets=new Map<string,Fact[]>();for(const m of html.matchAll(/<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction\s*>/gi)){
  const a=attrs(m[1]);if(!flowConcepts.has(local(a.name??'')))continue;const context=contexts.get(a.contextref),currency=units.get(a.unitref);if(!context||!currency||a['xsi:nil']==='true')continue;let raw=text(m[2]).replace(/[,\s]/g,'');if(local(a.format??'')==='fixed-zero')raw='0';if(/^[–—-]$/.test(raw)&&/(?:zero-?dash|num-?dash)$/i.test(local(a.format??'')))raw='0';if(a.format&&!/^(?:num-?dot-?decimal|zero-?dash|num-?dash|fixed-zero)$/i.test(local(a.format))){issues.push('UNSUPPORTED_NUMBER_FORMAT');continue;}if(!/^\(?[+-]?\d+(\.\d+)?\)?$/.test(raw))continue;const scale=Number(a.scale??0);if(!Number.isInteger(scale)||Math.abs(scale)>18)continue;const value=Math.abs(Number(raw.replace(/[()]/g,'')))*10**scale*(a.sign==='-'||raw.startsWith('(')||raw.startsWith('-')?-1:1);if(!Number.isFinite(value))continue;const precision=a.decimals==='INF'?Number.MAX_SAFE_INTEGER:/^-?\d+$/.test(a.decimals??'')?Number(a.decimals):Number.MIN_SAFE_INTEGER;const fact={precision,tag:a.name,value,currency,...context,context:a.contextref,source};const key=[context.start,context.end,currency].join('|');buckets.set(key,[...(buckets.get(key)??[]),fact]);
 }
 const facts=[...buckets.values()].flat();
 // Income statement rows keep the issuer's own lines, including custom concepts the flow tags do not name.
 const inventory=extractFilingDisclosures(html,{ticker:'',accessionNumber:source.accession,documentUrl:source.url,form:'',reportDate:'',filedAt:source.filedAt}),byId=new Map(inventory.facts.map(f=>[f.id,f]));
 for(const cell of readIncomeStatementCells(extractFinancialStatements(html,inventory))){
  const fact=byId.get(cell.factId),contextRef=fact?.contextRef;if(!fact||!contextRef)continue;
  const statementRow={order:cell.order,label:cell.label,flip:cell.flip},same=facts.filter(f=>f.tag===cell.concept&&f.context===contextRef);
  if(same.length){for(const f of same)f.statementRow=statementRow;continue;}
  const context=contexts.get(contextRef),currency=units.get(fact.unitRef??''),value=Number(fact.numericValue);
  if(!context||!currency||fact.numericValue===null||!Number.isFinite(value))continue;
  facts.push({precision:fact.decimals==='INF'?Number.MAX_SAFE_INTEGER:/^-?\d+$/.test(fact.decimals??'')?Number(fact.decimals):Number.MIN_SAFE_INTEGER,tag:cell.concept,value,currency,...context,context:contextRef,source,statementRow});
 }
 if(memberLabels)for(const f of facts){const own=Object.fromEntries(Object.values(f.dimensions).flatMap(m=>memberLabels[m]?[[m,memberLabels[m]]]:[]));if(Object.keys(own).length)f.memberLabels=own;}
 return {facts,issues};
}
/** A row equal to the sum of the rows directly above it is an unlabelled subtotal; it is dropped only when that makes the lines reconcile. */
function reconcile<T extends {value:number}>(items:T[],total:number):T[]|null{
 const sum=(rows:T[])=>rows.reduce((n,r)=>n+r.value,0);if(near(sum(items),total))return items;
 const kept:T[]=[];let runStart=0;
 for(const item of items){let subtotal=false;for(let j=runStart;j<=kept.length-2&&!subtotal;j++)subtotal=near(sum(kept.slice(j)),item.value);if(subtotal)runStart=kept.length;else kept.push(item);}
 return near(sum(kept),total)?kept:null;
}
const expenseGroup=(f:Fact):'research'|'sales'|'administration'|'other'=>{const name=local(f.tag),label=f.statementRow?.label??'';
 return /^ResearchAndDevelopmentExpense/.test(name)||/^research and development$/i.test(label)?'research'
  :/^(?:SellingAndMarketingExpense|SellingExpense|MarketingExpense)$/.test(name)||/^(?:(?:sales|selling) and marketing|selling|marketing)$/i.test(label)?'sales'
  :name==='GeneralAndAdministrativeExpense'||/^general and administrative$/i.test(label)?'administration':'other';};
function extractGenericQuarters(html:string,source:DocumentSource,supplemental:Fact[]=[],reviewVerified=false):{quarters:BusinessFlowQuarter[];issues:string[]}{
 const issues:string[]=[];if(html.length>SEC_DOCUMENT_MAX_BYTES)return {quarters:[],issues:['DOCUMENT_TOO_LARGE']};
 if(!reviewVerified&&needsRestatementReview(html))issues.push('RESTATEMENT_REVIEW_REQUIRED');
 const reported=readReportedFacts(html,source);issues.push(...reported.issues);const buckets=new Map<string,Fact[]>();for(const fact of [...reported.facts,...supplemental]){const days=(Date.parse(fact.end)-Date.parse(fact.start))/86400000;if(days<70||days>110)continue;const key=[fact.start,fact.end,fact.currency].join('|');buckets.set(key,[...(buckets.get(key)??[]),fact]);}
 const fiscalFocus=source.fiscalYear??text(html.match(/<ix:nonNumeric[^>]*name=["']dei:DocumentFiscalYearFocus["'][^>]*>([\s\S]*?)<\/ix:nonNumeric>/i)?.[1]??'');
 const quarters:BusinessFlowQuarter[]=[];
 for(const [key,facts]of buckets){const[start,end,currency]=key.split('|');const consolidated=facts.filter(f=>Object.keys(f.dimensions).length===0);
  const select=(names:string[])=>{for(const name of names){const matches=consolidated.filter(f=>local(f.tag)===name);if(matches.length){const bestPrecision=Math.max(...matches.map(f=>f.precision));const precise=matches.filter(f=>f.precision===bestPrecision);if(new Set(precise.map(f=>f.value)).size!==1){issues.push('CONFLICTING_FACT:'+name);return undefined;}return precise[0];}}return undefined;};
  const factLineage=(f:Fact):NonNullable<FlowAmount['lineage']>=>[{accession:f.source.accession,url:f.source.url,concept:f.tag,contextId:f.context,periodStart:f.start,periodEnd:f.end,dimensions:f.dimensions,parserVersion:SEC_FLOW_PARSER_VERSION}];
  const amount=(f:Fact,definition:string):FlowAmount=>({value:String(f.value),basis:f.operands?'derived':'reported',definition,comparabilityKey:'deterministic-sec-v1:'+definition+':'+f.tag,sourceIds:[...new Set((f.operands??[f]).map(v=>v.source.accession))],...(f.formula?{formula:f.formula}:{}),lineage:(f.operands??[f]).flatMap(factLineage)});
  const figures:BusinessFlowQuarter['figures']={};for(const[key,names]of Object.entries(tags)){const f=select(names!);if(f)figures[key as FlowMetric]=amount(f,key);}
  const derive=(definition:string,value:number,terms:FlowAmount[],formula:string):FlowAmount=>({value:String(value),basis:'derived',definition,comparabilityKey:'deterministic-sec-v1:'+definition+':'+terms.map(t=>t.comparabilityKey).join('|'),sourceIds:[...new Set(terms.flatMap(t=>t.sourceIds))],formula,lineage:terms.flatMap(t=>t.lineage??[])});
  const value=(k:FlowMetric)=>figures[k]?.value==null?null:Number(figures[k]!.value);
  let model:BusinessFlowQuarter['incomeModel']='standard';
  const financialExpenses:NonNullable<BusinessFlowQuarter['expenseComponents']>=[];
  if(source.industry==='financial'||source.industry==='insurance'){model=source.industry;const revenue=select(['RevenuesNetOfInterestExpense','Revenues']);const expense=select(['NoninterestExpense','CostsAndExpenses']);if(source.industry==='insurance'){const profit=select(['ProfitLoss']);if(profit)figures.net=amount(profit,'consolidated-net-including-noncontrolling-interest');const gain=select(['GainLossOnInvestments']),equity=select(['IncomeLossFromEquityMethodInvestments']);if(gain&&equity)figures.other=derive('insurance-investment-and-equity-income',gain.value+equity.value,[amount(gain,'investment-gains'),amount(equity,'equity-method-income')],'Reported investment gains (losses) + reported equity-method income');}if(revenue)figures.revenue=amount(revenue,'net-financial-revenue');if(expense){figures.operatingExpenses=amount(expense,'reported-financial-expenses');financialExpenses.push({id:source.industry==='insurance'?'reported-costs-and-expenses':'noninterest-expense',name:source.industry==='insurance'?'Reported costs and expenses':'Noninterest expense',group:'other',amount:figures.operatingExpenses});const provision=select(['ProvisionForLoanLeaseAndOtherLosses']);if(source.industry==='financial'&&provision&&local(expense.tag)==='NoninterestExpense'){const loss=amount(provision,'credit-loss-provision');financialExpenses.push({id:'credit-loss-provision',name:'Provision for credit losses',group:'other',amount:loss});figures.operatingExpenses=derive('financial-expenses',expense.value+provision.value,[figures.operatingExpenses,loss],'Reported noninterest expense + reported provision for credit losses (net revenue is already net of interest expense)');}}}
  else if(value('cost')!=null&&value('revenue')!=null){if(!figures.gross)figures.gross=derive('gross',value('revenue')!-value('cost')!,[figures.revenue!,figures.cost!],'Reported revenue − reported total cost of revenue');if(!figures.operatingExpenses&&figures.operating)figures.operatingExpenses=derive('operatingExpenses',value('gross')!-value('operating')!,[figures.gross!,figures.operating!],'Reported gross profit − reported operating income (total operating expenses)');}
  else {model='direct_operating';const expense=select(['CostsAndExpenses']);if(expense)figures.operatingExpenses=amount(expense,'reported-costs-and-expenses');}
  if(figures.operating&&figures.pretax)figures.other=derive('other',value('pretax')!-value('operating')!,[figures.pretax!,figures.operating!],'Reported income before income taxes − reported operating income (signed other income, net)');
  const revenueNames=source.industry==='financial'?['RevenuesNetOfInterestExpense','Revenues']:source.industry==='insurance'?['Revenues']:tags.revenue!;
  const eliminationFacts=facts.filter(f=>revenueNames.includes(local(f.tag))&&Object.entries(f.dimensions).length===1&&Object.entries(f.dimensions).some(([axis,member])=>['ConsolidationItemsAxis','StatementBusinessSegmentsAxis','ProductOrServiceAxis'].includes(local(axis))&&/eliminat/i.test(member)));
  if(new Set(eliminationFacts.map(f=>f.value)).size>1)issues.push('CONFLICTING_REVENUE_ELIMINATIONS');
  const elimination=eliminationFacts.sort((a,b)=>b.precision-a.precision)[0];
  const revenueAdjustments:NonNullable<BusinessFlowQuarter['revenueAdjustments']>=elimination?[{id:'intersegment-eliminations',name:'Intersegment eliminations',amount:amount(elimination,'revenue-eliminations')}]:[];
  // A bank reports its segments on a managed basis: they reach reported revenue only with its corporate line and the
  // reconciling items, each a fact on the consolidation axis alone. Used only when the segments do not reconcile without them.
  const consolidationOnly=(test:(member:string)=>boolean)=>facts.filter(f=>revenueNames.includes(local(f.tag))&&Object.entries(f.dimensions).length===1&&Object.entries(f.dimensions).some(([axis,member])=>local(axis)==='ConsolidationItemsAxis'&&test(local(member))));
  const single=(list:Fact[],code:string)=>{if(new Set(list.map(f=>f.value)).size>1){issues.push(code);return undefined;}return list.sort((a,b)=>b.precision-a.precision)[0];};
  const corporate=single(consolidationOnly(m=>m==='CorporateNonSegmentMember'),'CONFLICTING_CORPORATE_REVENUE');
  const reconciling=single(consolidationOnly(m=>/ReconcilingItems?Member$/.test(m)&&!/eliminat/i.test(m)),'CONFLICTING_RECONCILING_ITEMS');
  const axes=new Map<string,Map<string,Fact>>();for(const f of facts){if(eliminationFacts.includes(f))continue;const entries=Object.entries(f.dimensions).filter(([axis,member])=>!(local(axis)==='ConsolidationItemsAxis'&&local(member)==='OperatingSegmentsMember'));if(!revenueNames.includes(local(f.tag))||entries.length!==1||!['StatementBusinessSegmentsAxis','ProductOrServiceAxis'].includes(local(entries[0][0])))continue;const [axis,member]=entries[0];if(source.cik==='0000769397'&&local(axis)==='ProductOrServiceAxis'&&!['ArchitectureEngineeringConstructionAndOperationsMember','AutoCADandAutoCADLTFamilyMember','ManufacturingMember','MediaAndEntertainmentMember','OtherMember'].includes(local(member)))continue;const axisKey=axis+'|'+Object.entries(f.dimensions).filter(([a])=>local(a)==='ConsolidationItemsAxis').map(([a,m])=>a+':'+m).join(',');const members=axes.get(axisKey)??new Map();const old=members.get(member);if(old&&old.precision>f.precision)continue;if(old&&old.precision===f.precision&&old.value!==f.value){issues.push('CONFLICTING_SEGMENT');continue;}members.set(member,f);axes.set(axisKey,members);}
  let matching=[...axes.entries()].filter(([,group])=>figures.revenue&&near([...group.values()].reduce((sum,f)=>sum+f.value,0)+(elimination?.value??0),value('revenue')!)).map(([axis,group])=>({axis,group}));
  let managed=false;
  if(!matching.length&&(corporate||reconciling)&&figures.revenue){
   matching=[...axes.entries()].filter(([axis,group])=>local(axis.split('|')[0])==='StatementBusinessSegmentsAxis'&&group.size>1&&near([...group.values()].reduce((sum,f)=>sum+f.value,0)+(elimination?.value??0)+(corporate?.value??0)+(reconciling?.value??0),value('revenue')!)).map(([axis,group])=>({axis,group}));
   if(matching.length===1){
    managed=true;
    if(corporate){if(corporate.value>=0)matching[0].group=new Map([...matching[0].group,['corporate',corporate]]);else revenueAdjustments.push({id:'corporate',name:'Corporate',amount:amount(corporate,'revenue-corporate')});}
    if(reconciling)revenueAdjustments.push({id:'reconciling-items',name:'Reconciling items',amount:amount(reconciling,'revenue-reconciling-items')});
   }
  }const detailed=matching.filter(m=>m.group.size>1);if(detailed.length)matching=detailed;const business=matching.filter(m=>local(m.axis.split('|')[0])==='StatementBusinessSegmentsAxis');if(business.length)matching=business;let segments:BusinessSegment[]=[];
  if(matching.length>1)issues.push('AMBIGUOUS_REVENUE_AXIS');else if(matching.length===1)segments=[...matching[0].group].map(([member,f])=>({id:member,name:member==='corporate'?'Corporate':memberName(member,f.memberLabels),revenue:{...amount(f,'segment:'+member),comparabilityKey:f.tag.startsWith('table:')?'table-segment:'+source.accession+':'+member+':'+f.tag:/^\d{4}$/.test(fiscalFocus)?'deterministic-sec-segment:'+fiscalFocus+':'+member+':'+f.tag:null},description:'A segment or product and service category as the filing discloses it, named by the filing; products and customers are not inferred.',products:[],customers:null,monetization:null,disclosure:managed?'Segment revenue as the filing manages it; the corporate line and the reconciling items to reported revenue are shown separately, and consolidated expenses are not allocated to segments.':revenueAdjustments.length?'Segment revenue includes intersegment sales; eliminations are shown separately, and neither they nor consolidated expenses are allocated to segments.':'Revenue from the filing\'s segment disclosure; consolidated expenses are not allocated to segments.',sourceIds:[source.accession]}));// Non-reconciling department/management revenue is not substituted for GAAP consolidated revenue.

  const expenses=financialExpenses;
  // Operating expense lines printed between cost of revenue (or gross profit) and operating income, used only when they add up to the operating expense total.
  const statementExpenses=():typeof expenses=>{
   if(model!=='standard'||!figures.operatingExpenses)return [];
   const operatingRow=facts.find(f=>f.statementRow&&local(f.tag)==='OperatingIncomeLoss'&&!Object.keys(f.dimensions).length);if(!operatingRow)return [];
   const byOrder=new Map<number,Fact>();
   for(const f of facts){if(!f.statementRow||f.source.url!==operatingRow.source.url)continue;const old=byOrder.get(f.statementRow.order);if(old&&(old.tag!==f.tag||old.value!==f.value))return [];if(!old||f.precision>old.precision)byOrder.set(f.statementRow.order,f);}
   const rows=[...byOrder].sort((a,b)=>a[0]-b[0]).map(([,f])=>f),end=rows.findIndex(f=>local(f.tag)==='OperatingIncomeLoss');
   const start=rows.slice(0,end).findLastIndex(f=>[...tags.cost!,...tags.gross!].includes(local(f.tag))&&!Object.keys(f.dimensions).length);if(start<0)return [];
   const lines=rows.slice(start+1,end).filter(f=>!['OperatingExpenses','CostsAndExpenses'].includes(local(f.tag))&&!/^total\b/i.test(f.statementRow!.label)).map(fact=>({fact,value:fact.statementRow!.flip?-fact.value:fact.value}));
   // Statements that print expenses as deductions reconcile with the opposite orientation.
   const kept=[1,-1].map(sign=>reconcile(lines.map(l=>({...l,value:l.value*sign})),Number(figures.operatingExpenses!.value))).find(k=>k?.length);if(!kept)return [];
   const seen=new Map<string,number>();
   return kept.filter(l=>l.value!==0).map(({fact,value})=>{const base=local(fact.tag),count=(seen.get(base)??0)+1;seen.set(base,count);const id=count>1?`${base}~${count}`:base;return {id,name:fact.statementRow!.label||base,group:expenseGroup(fact),amount:{...amount(fact,'expense:'+id),value:String(value)}};});
  };
  if(!expenses.length){const lines=statementExpenses();if(lines.length){expenses.push(...lines);for(const key of ['research','sales','administration'] as const){const matches=lines.filter(c=>c.group===key);if(matches.length===1)figures[key]=matches[0].amount;else delete figures[key];}}}
  const combinedSalesAdministration=select(['SellingGeneralAndAdministrativeExpense','GainLossOnInvestments','IncomeLossFromEquityMethodInvestments']);const disclosedOperating=['research','sales','administration'].map(k=>({id:k,name:k==='research'?'Research and development':k==='sales'?'Sales and marketing':'General and administrative',group:k as 'research'|'sales'|'administration',amount:figures[k as FlowMetric]})).filter((c):c is typeof c & {amount:FlowAmount}=>!!c.amount);if(!expenses.length&&figures.research&&combinedSalesAdministration&&figures.operatingExpenses&&near(Number(figures.research.value)+combinedSalesAdministration.value,Number(figures.operatingExpenses.value))){expenses.push({id:'research',name:'Research and development',group:'research',amount:figures.research},{id:'sales-general-administration',name:'Selling, general and administrative',group:'other',amount:amount(combinedSalesAdministration,'sales-general-administration')});}if(!expenses.length&&disclosedOperating.length===3&&figures.operatingExpenses&&near(disclosedOperating.reduce((sum,c)=>sum+Number(c.amount.value),0),Number(figures.operatingExpenses.value)))expenses.push(...disclosedOperating);if(!expenses.length&&figures.operatingExpenses)expenses.push({id:'reported-expense-total',name:'Total costs and expenses',group:'other' as const,amount:figures.operatingExpenses});
  let q:BusinessFlowQuarter={id:end,label:`Three months ended ${end}`,periodStart:start,periodEnd:end,periodType:'3M',currency,scale:1,basisLabel:source.industry==='insurance'?'As reported to the SEC · investment and equity-method income shown separately · net income includes noncontrolling interests':'As reported in each SEC filing · deterministic extraction · segment comparisons across fiscal years not verified',reportedAt:source.filedAt,figures,segments,segmentsComplete:segments.length>0,...(facts.some(f=>f.source.singleSegment)?{segmentDisclosure:'single_reportable_segment' as const}:{}),...(segments.length&&revenueAdjustments.length?{revenueAdjustments}:{}),expenseComponents:expenses,otherComponents:figures.other?[{id:'reported-net-other',name:'Other income (expense), net',amount:figures.other}]:[],incomeModel:model,sources:[...new Map(facts.flatMap(f=>f.operands??[f]).map(f=>[f.source.accession,{id:f.source.accession,title:'SEC filing '+f.source.accession,url:f.source.url,publishedAt:f.source.filedAt}])).values()]};
  if(figures.net?.lineage?.every(l=>local(l.concept)==='IncomeLossFromContinuingOperations'))q.basisLabel+=' · income from continuing operations (excludes discontinued operations)';
  if(!figures.revenue)continue;
  if(!segments.length)q=disclosedWholeCompany(q);quarters.push(q);
 }
 return {quarters:issues.length?[]:quarters,issues:!quarters.length&&!issues.length?['NO_DIRECT_COMPARABLE_QUARTER']:issues};
}

/**
 * Known disclosure-profile mappings read actual cells/tags; no ticker or amounts are substituted.
 * `presentationReviewed`: the caller established that the filing only reclassified prior periods to its current presentation.
 */
export function extractDisclosedQuarters(html:string,source:DocumentSource,supplemental:Fact[]=[],presentationReviewed=false):{quarters:BusinessFlowQuarter[];issues:string[]}{
 if(hasDisclosureProfile(source.cik) && (presentationReviewed || !needsRestatementReview(html))){
  const inputs={sourceUrl:source.url,accession:source.accession};
  const parsed=/<ix:nonFraction/i.test(html)?parseSecBusinessFlow(html,inputs):parseSecEarningsRelease(html,inputs);
  const quarters=parsed.map(q=>buildPublishedBusinessQuarter(q,source.filedAt)).filter((q):q is BusinessFlowQuarter=>q!==null);
  if(quarters.length)return {quarters,issues:[]};
 }
 if(!/<ix:nonFraction/i.test(html)){const facts=readStatementTableFacts(html,source);if(facts.length)return extractGenericQuarters('',source,facts,true);}
 return extractGenericQuarters(html,source,supplemental,presentationReviewed);
}

/** Internal entry for facts reviewed by the cumulative-period verifier. */
export function extractVerifiedCurrentQuarters(source:DocumentSource,facts:Fact[]){return extractGenericQuarters('',source,facts,true);}
