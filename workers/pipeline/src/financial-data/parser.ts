import {parseSecBusinessFlow} from '../../../../shared/analysis-runtime/financial-data/business-flow-parser.ts';
import {parseSecEarningsRelease} from '../../../../shared/analysis-runtime/financial-data/business-flow-release.ts';
import {buildPublishedBusinessQuarter} from '../../../../shared/analysis-runtime/financial-data/disclosed-quarter.ts';
import type { BusinessFlowQuarter, FlowAmount, FlowMetric, BusinessSegment } from '../../../../shared/analysis-contract/business-flow.ts';
import { disclosedWholeCompany } from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
export interface DocumentSource {url:string;accession:string;filedAt:string;cik:string;industry:'standard'|'financial'|'insurance'|'unknown';}
interface Fact {tag:string;value:number;currency:string;start:string;end:string;context:string;dimensions:Record<string,string>;}
const text=(s:string)=>s.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').trim();
const attrs=(s:string)=>Object.fromEntries([...s.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1].toLowerCase(),m[2]]));
const local=(tag:string)=>tag.split(':').at(-1)!;
const tags:Partial<Record<FlowMetric,string[]>>={revenue:['RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet'],cost:['CostOfRevenue','CostOfGoodsAndServicesSold'],gross:['GrossProfit'],operatingExpenses:['OperatingExpenses'],operating:['OperatingIncomeLoss'],other:['NonoperatingIncomeExpense','OtherNonoperatingIncomeExpense'],pretax:['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest','IncomeLossFromContinuingOperationsIncludingNoncontrollingInterestBeforeIncomeTaxesExtraordinaryItems'],tax:['IncomeTaxExpenseBenefit'],net:['NetIncomeLoss','ProfitLoss'],research:['ResearchAndDevelopmentExpense'],sales:['SellingAndMarketingExpense','SellingExpense'],administration:['GeneralAndAdministrativeExpense']};
const needsRestatementReview=(html:string)=>text(html).replace(/\s+/g,' ').split(/\.(?: |$)/).some(p=>/\bas\s+restated\b|\b(?:prior[- ](?:period|year)|previously reported|comparative|historical)[^.]{0,180}\b(?:recast|restated|reclassified)\b|\b(?:recast|restated)[^.]{0,180}\b(?:income|segment|financial statement)/i.test(p)&&!/no impact on[^.]*consolidated (?:income|statements of income)/i.test(p));
const near=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1,Math.max(Math.abs(a),Math.abs(b))*1e-9);
function extractGenericQuarters(html:string,source:DocumentSource):{quarters:BusinessFlowQuarter[];issues:string[]}{
 const issues:string[]=[];if(html.length>12000000)return {quarters:[],issues:['DOCUMENT_TOO_LARGE']};
 if(needsRestatementReview(html))issues.push('RESTATEMENT_REVIEW_REQUIRED');
 const contexts=new Map<string,{start:string;end:string;dimensions:Record<string,string>}>();
 for(const m of html.matchAll(/<(?:[\w-]+:)?context\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?context\s*>/gi)){
  const a=attrs(m[1]),start=m[2].match(/<(?:[\w-]+:)?startDate[^>]*>([^<]+)/i)?.[1],end=m[2].match(/<(?:[\w-]+:)?endDate[^>]*>([^<]+)/i)?.[1],issuer=m[2].match(/<(?:[\w-]+:)?identifier[^>]*>([^<]+)/i)?.[1];if(!a.id||!start||!end||!issuer||issuer.replace(/^0+/,'')!==source.cik.replace(/^0+/,''))continue;
  const days=(Date.parse(end)-Date.parse(start))/86400000;if(days<70||days>110||!Number.isFinite(days))continue;const dimensions:Record<string,string>={};for(const d of m[2].matchAll(/<(?:[\w-]+:)?explicitMember\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?explicitMember\s*>/gi)){dimensions[attrs(d[1]).dimension]=text(d[2]);}if(/typedMember/i.test(m[2]))continue;contexts.set(a.id,{start,end,dimensions});
 }
 const units=new Map<string,string>();for(const m of html.matchAll(/<(?:[\w-]+:)?unit\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?unit\s*>/gi)){const measure=m[2].match(/<[^>]*measure[^>]*>\s*iso4217:([A-Z]{3})\s*</i)?.[1];if(measure&&!/divide/i.test(m[2]))units.set(attrs(m[1]).id,measure);}
 const buckets=new Map<string,Fact[]>();for(const m of html.matchAll(/<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction\s*>/gi)){
  const a=attrs(m[1]),context=contexts.get(a.contextref),currency=units.get(a.unitref);if(!context||!currency||a['xsi:nil']==='true')continue;let raw=text(m[2]).replace(/[,\s]/g,'');if(local(a.format??'')==='fixed-zero')raw='0';if(/^[–—-]$/.test(raw)&&/(?:zero-?dash|num-?dash)$/i.test(local(a.format??'')))raw='0';if(a.format&&!/^(?:num-?dot-?decimal|zero-?dash|num-?dash|fixed-zero)$/i.test(local(a.format))){issues.push('UNSUPPORTED_NUMBER_FORMAT');continue;}if(!/^\(?[+-]?\d+(\.\d+)?\)?$/.test(raw))continue;const scale=Number(a.scale??0);if(!Number.isInteger(scale)||Math.abs(scale)>18)continue;const value=Math.abs(Number(raw.replace(/[()]/g,'')))*10**scale*(a.sign==='-'||raw.startsWith('(')||raw.startsWith('-')?-1:1);if(!Number.isFinite(value))continue;const fact={tag:a.name,value,currency,...context,context:a.contextref};const key=[context.start,context.end,currency].join('|');buckets.set(key,[...(buckets.get(key)??[]),fact]);
 }
 const fiscalFocus=text(html.match(/<ix:nonNumeric[^>]*name=["']dei:DocumentFiscalYearFocus["'][^>]*>([\s\S]*?)<\/ix:nonNumeric>/i)?.[1]??'');
 const quarters:BusinessFlowQuarter[]=[];
 for(const [key,facts]of buckets){const[start,end,currency]=key.split('|');const consolidated=facts.filter(f=>Object.keys(f.dimensions).length===0);
  const select=(names:string[])=>{for(const name of names){const matches=consolidated.filter(f=>local(f.tag)===name);if(matches.length){if(new Set(matches.map(f=>f.value)).size!==1){issues.push('CONFLICTING_FACT:'+name);return undefined;}return matches[0];}}return undefined;};
  const amount=(f:Fact,definition:string):FlowAmount=>({value:String(f.value),basis:'reported',definition,comparabilityKey:'deterministic-sec-v1:'+definition+':'+f.tag,sourceIds:[source.accession],lineage:[{accession:source.accession,url:source.url,concept:f.tag,contextId:f.context,periodStart:start,periodEnd:end,dimensions:f.dimensions,parserVersion:'deterministic-sec.v1'}]});
  const figures:BusinessFlowQuarter['figures']={};for(const[key,names]of Object.entries(tags)){const f=select(names!);if(f)figures[key as FlowMetric]=amount(f,key);}
  const derive=(definition:string,value:number,terms:FlowAmount[],formula:string):FlowAmount=>({value:String(value),basis:'derived',definition,comparabilityKey:'deterministic-sec-v1:'+definition+':'+terms.map(t=>t.comparabilityKey).join('|'),sourceIds:[...new Set(terms.flatMap(t=>t.sourceIds))],formula,lineage:terms.flatMap(t=>t.lineage??[])});
  const value=(k:FlowMetric)=>figures[k]?.value==null?null:Number(figures[k]!.value);
  let model:BusinessFlowQuarter['incomeModel']='standard';
  const financialExpenses:NonNullable<BusinessFlowQuarter['expenseComponents']>=[];
  if(source.industry==='financial'||source.industry==='insurance'){model=source.industry;const revenue=select(['RevenuesNetOfInterestExpense','Revenues']);const expense=select(['NoninterestExpense','CostsAndExpenses']);if(revenue)figures.revenue=amount(revenue,'net-financial-revenue');if(expense){figures.operatingExpenses=amount(expense,'reported-financial-expenses');financialExpenses.push({id:'noninterest-expense',name:'非利息费用',group:'other',amount:figures.operatingExpenses});const provision=select(['ProvisionForLoanLeaseAndOtherLosses']);if(source.industry==='financial'&&provision&&local(expense.tag)==='NoninterestExpense'){const loss=amount(provision,'credit-loss-provision');financialExpenses.push({id:'credit-loss-provision',name:'信用损失准备',group:'other',amount:loss});figures.operatingExpenses=derive('financial-expenses',expense.value+provision.value,[figures.operatingExpenses,loss],'已披露非利息费用 + 已披露信用损失准备（净收入已扣除利息费用，不重复扣除）');}}}
  else if(value('cost')!=null&&value('revenue')!=null){if(!figures.gross)figures.gross=derive('gross',value('revenue')!-value('cost')!,[figures.revenue!,figures.cost!],'已披露收入 − 已披露完整营业成本');if(!figures.operatingExpenses&&figures.operating)figures.operatingExpenses=derive('operatingExpenses',value('gross')!-value('operating')!,[figures.gross!,figures.operating!],'已披露毛利 − 已披露营业利润（运营费用合计）');}
  else {model='direct_operating';const expense=select(['CostsAndExpenses']);if(expense)figures.operatingExpenses=amount(expense,'reported-costs-and-expenses');}
  if(figures.operating&&figures.pretax)figures.other=derive('other',value('pretax')!-value('operating')!,[figures.pretax!,figures.operating!],'已披露税前利润 − 已披露营业利润（有符号非营业净损益）');
  const revenueNames=source.industry==='financial'?['RevenuesNetOfInterestExpense','Revenues']:tags.revenue!;
  const axes=new Map<string,Map<string,Fact>>();for(const f of facts){const entries=Object.entries(f.dimensions);if(!revenueNames.includes(local(f.tag))||entries.length!==1||!['StatementBusinessSegmentsAxis','ProductOrServiceAxis'].includes(local(entries[0][0])))continue;const [axis,member]=entries[0];const members=axes.get(axis)??new Map();if(members.has(member)&&members.get(member)!.value!==f.value){issues.push('CONFLICTING_SEGMENT');continue;}members.set(member,f);axes.set(axis,members);}
  const matching=[...axes.values()].filter(group=>figures.revenue&&near([...group.values()].reduce((sum,f)=>sum+f.value,0),value('revenue')!));let segments:BusinessSegment[]=[];
  if(matching.length>1)issues.push('AMBIGUOUS_REVENUE_AXIS');else if(matching.length===1)segments=[...matching[0]].map(([member,f])=>({id:member,name:local(member).replace(/Member$/,''),revenue:{...amount(f,'segment:'+member),comparabilityKey:/^\d{4}$/.test(fiscalFocus)?'deterministic-sec-segment:'+fiscalFocus+':'+member+':'+f.tag:null},description:'财报实际披露的部门或产品服务类别；标签名称保留原披露，不自动推定产品或客户。',products:[],customers:null,monetization:null,disclosure:'收入来自财报部门维度，不把合并费用分摊到部门。',sourceIds:[source.accession]}));else if(axes.size)issues.push('SEGMENTS_DO_NOT_RECONCILE');
  const expenses=financialExpenses;const disclosedOperating=['research','sales','administration'].map(k=>({id:k,name:k==='research'?'研发':k==='sales'?'销售与营销':'行政',group:k as 'research'|'sales'|'administration',amount:figures[k as FlowMetric]})).filter((c):c is typeof c & {amount:FlowAmount}=>!!c.amount);if(!expenses.length&&disclosedOperating.length===3&&figures.operatingExpenses&&near(disclosedOperating.reduce((sum,c)=>sum+Number(c.amount.value),0),Number(figures.operatingExpenses.value)))expenses.push(...disclosedOperating);if(!expenses.length&&figures.operatingExpenses)expenses.push({id:'reported-expense-total',name:'财报成本费用合计',group:'other' as const,amount:figures.operatingExpenses});
  let q:BusinessFlowQuarter={id:end,label:`截至 ${end} 的三个月`,periodStart:start,periodEnd:end,periodType:'3M',currency,scale:1,basisLabel:'SEC 财报各期原披露口径 · 确定性提取 · 跨财年部门比较未核验',reportedAt:source.filedAt,figures,segments,segmentsComplete:segments.length>0,expenseComponents:expenses,otherComponents:figures.other?[{id:'reported-net-other',name:'非营业净损益（合计）',amount:figures.other}]:[],incomeModel:model,sources:[{id:source.accession,title:'SEC 财报 '+source.accession,url:source.url,publishedAt:source.filedAt}]};
  if(!figures.revenue)continue;
  if(!axes.size)q=disclosedWholeCompany(q);quarters.push(q);
 }
 return {quarters:issues.length?[]:quarters,issues:!quarters.length&&!issues.length?['NO_DIRECT_COMPARABLE_QUARTER']:issues};
}

/** Known disclosure-profile mappings read actual cells/tags; no ticker or amounts are substituted. */
export function extractDisclosedQuarters(html:string,source:DocumentSource):{quarters:BusinessFlowQuarter[];issues:string[]}{
 if(source.cik==='0001341439' && !needsRestatementReview(html)){
  const inputs={sourceUrl:source.url,accession:source.accession};
  const parsed=/<ix:nonFraction/i.test(html)?parseSecBusinessFlow(html,inputs):parseSecEarningsRelease(html,inputs);
  const quarters=parsed.map(q=>buildPublishedBusinessQuarter(q,source.filedAt)).filter((q):q is BusinessFlowQuarter=>q!==null);
  if(quarters.length)return {quarters,issues:[]};
 }
 return extractGenericQuarters(html,source);
}
