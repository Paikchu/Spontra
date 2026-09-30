/** Conservative inline-XBRL extraction. Values remain in the disclosed currency's base unit. */
export interface FactLineage { sourceUrl: string; accession: string; tag: string; contextId: string; start: string; end: string; dimensions: Record<string, string>; }
export interface BusinessFact { value: number; currency: string; lineage: FactLineage; }
export interface BusinessLeaf { id: string; label: string; fact: BusinessFact; }
export interface ParsedBusinessQuarter { start: string; end: string; currency: string; financials: Record<string, BusinessFact>; revenues: BusinessLeaf[]; expenses: BusinessLeaf[]; issues: string[]; profile: "direct_operating" | "gross_profit" | "partial"; coverage: { revenueSplitComplete: boolean; expenseSplitComplete: boolean; operatingEquationComplete: boolean; netEquationComplete: boolean }; }
export interface ParserSource { sourceUrl: string; accession: string; periodEnd?: string; }
const decode = (s: string) => s.replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_, x, n) => String.fromCodePoint(parseInt(x ?? n, x ? 16 : 10))).replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"');
const plain = (s: string) => decode(s.replace(/<[^>]*>/g, '')).trim();
function attributes(s: string): Record<string, string> { const a: Record<string,string> = {}; for (const m of s.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) a[m[1].toLowerCase()] = decode(m[2]); return a; }
const local = (s: string) => s.split(':').at(-1) ?? s;
const financialTags: Record<string,string[]> = {
 revenue:['RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet'],
 totalOperatingExpenses:['CostsAndExpenses'], operatingIncome:['OperatingIncomeLoss'],
 interestExpense:['InterestExpense','InterestAndDebtExpense'],
 otherIncome:['NonoperatingIncomeExpenseIncludingEliminationOfNetIncomeLossAttributableToNoncontrollingInterests','OtherNonoperatingIncomeExpense'],
 pretaxIncome:['IncomeLossFromContinuingOperationsIncludingNoncontrollingInterestBeforeIncomeTaxesExtraordinaryItems','IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest'],
 taxExpense:['IncomeTaxExpenseBenefit'], netIncome:['NetIncomeLoss','ProfitLoss'], grossProfit:['GrossProfit'], costOfRevenue:['CostOfRevenue','CostOfGoodsAndServicesSold'],
};
const expenseTags: Record<string,string> = {CloudAndSoftwareExpenses:'云与软件费用',HardwareExpenses:'硬件费用',ServicesExpense:'服务费用',SellingAndMarketingExpense:'销售与营销',ResearchAndDevelopmentExpense:'研发',GeneralAndAdministrativeExpense:'一般及行政',AmortizationOfIntangibleAssets:'无形资产摊销',RestructuringAndOtherExpenses:'重组及其他'};
const revenueMembers: Record<string,string> = {CloudApplications:'云应用',CloudInfrastructure:'云基础设施',SoftwareLicense:'软件许可',SoftwareSupport:'软件支持'};
/** No inferred zeroes, no YTD subtraction, no arbitrary conflicting-fact selection. */
export function parseSecBusinessFlow(html: string, source: ParserSource): ParsedBusinessQuarter[] {
 const contexts = new Map<string,{start:string;end:string;dimensions:Record<string,string>}>();
 for (const m of html.matchAll(/<(?:[\w-]+:)?context\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?context\s*>/gi)) {
  const id=attributes(m[1]).id; const start=m[2].match(/<(?:[\w-]+:)?startDate[^>]*>([^<]+)</i)?.[1]?.trim(); const end=m[2].match(/<(?:[\w-]+:)?endDate[^>]*>([^<]+)</i)?.[1]?.trim();
  if(!id||!start||!end) continue;
  const days=(Date.parse(end)-Date.parse(start))/86400000; if(!Number.isFinite(days)||days<70||days>110||source.periodEnd&&end!==source.periodEnd) continue;
  const dimensions:Record<string,string>={}; for(const d of m[2].matchAll(/<(?:[\w-]+:)?explicitMember\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?explicitMember\s*>/gi)) { const axis=attributes(d[1]).dimension; if(axis) dimensions[axis]=plain(d[2]); }
  // Typed members cannot safely masquerade as consolidated facts.
  if(/typedMember/i.test(m[2])) dimensions.__typed='present';
  contexts.set(id,{start,end,dimensions});
 }
 const units=new Map<string,string>(); for(const m of html.matchAll(/<(?:[\w-]+:)?unit\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?unit\s*>/gi)) { const measure=m[2].match(/<(?:[\w-]+:)?measure[^>]*>([^<]+)</i)?.[1]; if(measure&&!/divide/i.test(m[2])&&/^iso4217:/i.test(measure.trim())) units.set(attributes(m[1]).id,local(measure.trim()).toUpperCase()); }
 const buckets=new Map<string,BusinessFact[]>();
 for(const m of html.matchAll(/<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction\s*>/gi)) {
  const a=attributes(m[1]); const ctx=contexts.get(a.contextref); const currency=units.get(a.unitref); if(!ctx||!currency||a['xsi:nil']==='true'||!a.name)continue;
  let text=plain(m[2]).replace(/[,\s]/g,''); if(!text||text==='—'||text==='–'||text==='-') continue;
  const parenthesized=/^\(.*\)$/.test(text); text=text.replace(/[()]/g,''); if(!/^[+-]?\d+(?:\.\d+)?$/.test(text))continue;
  const scale=a.scale===undefined?0:Number(a.scale); if(!Number.isInteger(scale)||Math.abs(scale)>18)continue;
  const value=Number(text)*10**scale*(a.sign==='-'||parenthesized?-1:1); if(!Number.isFinite(value))continue;
  const fact:BusinessFact={value,currency,lineage:{...source,tag:a.name,contextId:a.contextref,...ctx}};
  const key=`${ctx.start}|${ctx.end}|${currency}`; const facts=buckets.get(key)??[]; facts.push(fact); buckets.set(key,facts);
 }
 return [...buckets.entries()].map(([key,facts])=>{
  const [start,end,currency]=key.split('|'); const issues:string[]=[]; const financials:Record<string,BusinessFact>={};
  const select=(candidates:BusinessFact[],label:string) => { if(!candidates.length)return undefined; if(new Set(candidates.map(f=>f.value)).size!==1){issues.push(`Ambiguous ${label}`);return undefined;}return candidates[0]; };
  const consolidated=facts.filter(f=>Object.keys(f.lineage.dimensions).length===0);
  for(const [field,tags]of Object.entries(financialTags)) for(const tag of tags){const matches=consolidated.filter(f=>local(f.lineage.tag)===tag);if(matches.length){const fact=select(matches,field);if(fact)financials[field]=fact;break;}}
  const expenses:BusinessLeaf[]=[];for(const[tag,label]of Object.entries(expenseTags)){const fact=select(consolidated.filter(f=>local(f.lineage.tag)===tag),tag);if(fact)expenses.push({id:tag,label,fact});}
  const revenues:BusinessLeaf[]=[];
  for(const[member,label]of Object.entries(revenueMembers)){const fact=select(facts.filter(f=>local(f.lineage.tag)==='RevenueFromContractWithCustomerExcludingAssessedTax'&&Object.entries(f.lineage.dimensions).length===1&&Object.entries(f.lineage.dimensions).some(([axis,value])=>local(axis)==='ProductOrServiceAxis'&&local(value).replace(/Member$/,'')===member)),member);if(fact)revenues.push({id:member,label,fact});}
  for(const[tag,label]of [['HardwareRevenues','硬件'],['SalesRevenueServicesNet','服务']] as const){const fact=select(consolidated.filter(f=>[tag,tag+'1'].includes(local(f.lineage.tag))),tag);if(fact)revenues.push({id:tag,label,fact});}
  const balanced=(sum:number,total:number)=>Math.abs(sum-total)<=Math.max(1,Math.abs(total)*1e-9);
  if(revenues.length&&financials.revenue&&!balanced(revenues.reduce((s,n)=>s+n.fact.value,0),financials.revenue.value))issues.push('Revenue leaves do not reconcile; do not render as a complete split');
  if(expenses.length&&financials.totalOperatingExpenses&&!balanced(expenses.reduce((s,n)=>s+n.fact.value,0),financials.totalOperatingExpenses.value))issues.push('Expense leaves do not reconcile; do not render as a complete split');
  const revenueSplitComplete=!!financials.revenue&&revenues.length>0&&revenues.every(n=>n.fact.value>=0)&&balanced(revenues.reduce((s,n)=>s+n.fact.value,0),financials.revenue.value);
  const expenseSplitComplete=!!financials.totalOperatingExpenses&&expenses.length>0&&expenses.every(n=>n.fact.value>=0)&&balanced(expenses.reduce((s,n)=>s+n.fact.value,0),financials.totalOperatingExpenses.value);
  const operatingEquationComplete=!!financials.revenue&&!!financials.totalOperatingExpenses&&!!financials.operatingIncome&&balanced(financials.revenue.value-financials.totalOperatingExpenses.value,financials.operatingIncome.value);
  const netEquationComplete=!!financials.operatingIncome&&!!financials.interestExpense&&!!financials.otherIncome&&!!financials.pretaxIncome&&!!financials.taxExpense&&!!financials.netIncome&&balanced(financials.operatingIncome.value-financials.interestExpense.value+financials.otherIncome.value,financials.pretaxIncome.value)&&balanced(financials.pretaxIncome.value-financials.taxExpense.value,financials.netIncome.value);
  const profile:ParsedBusinessQuarter['profile']=expenseSplitComplete&&operatingEquationComplete?'direct_operating':financials.grossProfit?'gross_profit':'partial';
  return {start,end,currency,financials,revenues,expenses,issues,profile,coverage:{revenueSplitComplete,expenseSplitComplete,operatingEquationComplete,netEquationComplete}};
 }).sort((a,b)=>b.end.localeCompare(a.end));
}
