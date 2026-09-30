import type { BusinessFact, BusinessLeaf, ParsedBusinessQuarter, ParserSource } from './business-flow-parser.ts';

const clean = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
const months: Record<string, number> = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
interface Row { label: string; values: number[]; index: number; }
function rows(table: string): Row[] {
 return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m,index) => {
  const cells = [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c=>clean(c[1])).filter(Boolean);
  const label=cells[0]??''; const values:number[]=[];
  for(let i=1;i<cells.length;i++) {
   const text=cells[i].replace(/[$,\s]/g,'');
   // Dashes remain unknown, not zero. Percentage columns are never amounts.
   if(/^[—–-]$/.test(text)){values.push(Number.NaN);continue;}
   if(!/^\(?[+-]?\d+(?:\.\d+)?\)?$/.test(text)) continue;
   const negative=text.startsWith('(') || cells[i+1]===')';
   values.push(Number(text.replace(/[()]/g,''))*(negative?-1:1));
  }
  return {label,values,index};
 });
}
const expenseLabels: Record<string,[string,string]> = {
 'cloud and software':['CloudAndSoftwareExpenses','云与软件费用'],hardware:['HardwareExpenses','硬件费用'],services:['ServicesExpense','服务费用'],
 'sales and marketing':['SellingAndMarketingExpense','销售与营销'],'research and development':['ResearchAndDevelopmentExpense','研发'],
 'general and administrative':['GeneralAndAdministrativeExpense','一般及行政'],'amortization of intangible assets':['AmortizationOfIntangibleAssets','无形资产摊销'],
 'restructuring and other':['RestructuringAndOtherExpenses','重组及其他'],
};
const financialLabels:Record<string,string>={'total revenues':'revenue','total operating expenses':'totalOperatingExpenses','operating income':'operatingIncome','interest expense':'interestExpense','non-operating income, net':'otherIncome','non-operating expense, net':'otherIncome','income before income taxes':'pretaxIncome','provision for income taxes':'taxExpense','benefit for income taxes':'taxExpense','net income':'netIncome','net loss':'netIncome'};
/** Extract only a clearly identified direct-three-month GAAP operations table.
 * Amounts are dynamic disclosed cells; no company/ticker or fixture amounts are used.
 */
export function parseSecEarningsRelease(html:string,source:ParserSource):ParsedBusinessQuarter[] {
 const tables=[...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)];
 const result:ParsedBusinessQuarter[]=[];
 for(let ti=0;ti<tables.length;ti++) {
  const match=tables[ti]; const text=clean(match[0]); const preceding=clean(html.slice(Math.max(0,match.index!-3500),match.index));
  if(!/CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS/i.test(preceding)||!/\$ in millions/i.test(preceding)||/Non-GAAP/i.test(text)||!/Three Months Ended/i.test(text))continue;
  const date=text.match(/Three Months Ended\s+(\w+)\s+(\d{1,2}),\s*(?:%[^\d]*)?(\d{4})/i);
  // Header percentage descriptions can intervene before the first year.
  const endHeader=text.match(/Three Months Ended\s+(\w+)\s+(\d{1,2}),([\s\S]*?)REVENUES/i);
  const year=endHeader?.[3].match(/\b(20\d{2})\b/)?.[1];
  const month=months[(date?.[1]??endHeader?.[1]??'').toLowerCase()]; const day=Number(date?.[2]??endHeader?.[2]);
  if(!month||!year||!day||new Date(Date.UTC(Number(year),month,0)).getUTCDate()!==day)continue;
  const end=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  if(source.periodEnd&&source.periodEnd!==end)continue;
  const startDate=new Date(Date.UTC(Number(year),month-3,1)); const start=startDate.toISOString().slice(0,10);
  const financials:Record<string,BusinessFact>={};const expenses:BusinessLeaf[]=[];let expenseSection=false;
  const fact=(value:number,row:Row,tableIndex:number,column:number):BusinessFact=>({value:value*1e6,currency:'USD',lineage:{...source,tag:`table:${row.label}`,contextId:`table-${tableIndex}:row-${row.index}:amount-${column}`,start,end,dimensions:{}}});
  const revenueFallback:BusinessLeaf[]=[];
  for(const row of rows(match[0])) {
   const key=row.label.toLowerCase().replace(/\s*\(\d+\)$/, '');
   if(key==='operating expenses'){expenseSection=true;continue;}
   if(!row.values.length||!Number.isFinite(row.values[0]))continue;
   const mapped=financialLabels[key];
   if(mapped){
    const signed=mapped==='interestExpense'?Math.abs(row.values[0]):key==='non-operating expense, net'||key==='benefit for income taxes'?-Math.abs(row.values[0]):row.values[0];
    financials[mapped]=fact(signed,row,ti,0);
   }
   const expense=expenseLabels[key];
   if(expenseSection&&expense)expenses.push({id:expense[0],label:expense[1],fact:fact(row.values[0],row,ti,0)});
   if(!expenseSection&&['cloud','software','hardware','services'].includes(key)) revenueFallback.push({id:key,label:row.label,fact:fact(row.values[0],row,ti,0)});
  }
  if(!financials.revenue||!financials.operatingIncome||!financials.netIncome)continue;
  let revenues=revenueFallback;
  // A supplemental fiscal-quarter offerings table can disclose narrower, non-overlapping leaves.
  for(let si=0;si<tables.length;si++) {
   const supplemental=clean(tables[si][0]);
   if(!/REVENUES BY OFFERINGS/i.test(supplemental)||!/CLOUD REVENUES BY OFFERINGS/i.test(supplemental))continue;
   const fiscalYears=[...supplemental.matchAll(/Fiscal\s+(20\d{2})/gi)].map(m=>m[1]);
   // Only bind a Q4 column when the release also establishes its fiscal year-end.
   // Do not guess fiscal calendars from calendar months.
   const annualEnd=new RegExp(`Year Ended\\s+${endHeader?.[1]}\\s+${day},[\\s\\S]{0,160}?${year}`, 'i');
   if(!annualEnd.test(clean(html)))continue;
   const group=fiscalYears.indexOf(year);if(group<0)continue;
   const col=group*5+3;
   const ids:Record<string,[string,string]>={'cloud applications':['CloudApplications','云应用'],'cloud infrastructure':['CloudInfrastructure','云基础设施'],'software license':['SoftwareLicense','软件许可'],'software support':['SoftwareSupport','软件支持'],hardware:['HardwareRevenues','硬件'],services:['SalesRevenueServicesNet','服务']};
   const leaves:BusinessLeaf[]=[];const seen=new Set<string>();
   for(const row of rows(tables[si][0])) {
    const item=ids[row.label.toLowerCase()];if(!item||seen.has(item[0])||row.values.length!==fiscalYears.length*5||!Number.isFinite(row.values[col]))continue;
    seen.add(item[0]);leaves.push({id:item[0],label:item[1],fact:fact(row.values[col],row,si,col)});
   }
   if(leaves.length===6&&Math.abs(leaves.reduce((s,l)=>s+l.fact.value,0)-financials.revenue.value)<1)revenues=leaves;
  }
  const issues:string[]=[];
  const check=(keys:string[],expected:string,calculate:(values:number[])=>number)=>{if(keys.every(k=>financials[k])&&financials[expected]&&Math.abs(calculate(keys.map(k=>financials[k].value))-financials[expected].value)>1)issues.push(`Financial equation does not reconcile: ${expected}`);};
  check(['revenue','totalOperatingExpenses'],'operatingIncome',v=>v[0]-v[1]);
  check(['operatingIncome','interestExpense','otherIncome'],'pretaxIncome',v=>v[0]-v[1]+v[2]);
  check(['pretaxIncome','taxExpense'],'netIncome',v=>v[0]-v[1]);
  if(expenses.length&&financials.totalOperatingExpenses&&Math.abs(expenses.reduce((s,l)=>s+l.fact.value,0)-financials.totalOperatingExpenses.value)>1)issues.push('Expense leaves do not reconcile');
  if(revenues.length&&Math.abs(revenues.reduce((s,l)=>s+l.fact.value,0)-financials.revenue.value)>1)issues.push('Revenue leaves do not reconcile');
  const balanced=(a:number,b:number)=>Math.abs(a-b)<=1;
  const revenueSplitComplete=revenues.length>0&&balanced(revenues.reduce((s,l)=>s+l.fact.value,0),financials.revenue.value);
  const expenseSplitComplete=expenses.length>0&&!!financials.totalOperatingExpenses&&balanced(expenses.reduce((s,l)=>s+l.fact.value,0),financials.totalOperatingExpenses.value);
  const operatingEquationComplete=!!financials.totalOperatingExpenses&&balanced(financials.revenue.value-financials.totalOperatingExpenses.value,financials.operatingIncome.value);
  const netEquationComplete=!!financials.interestExpense&&!!financials.otherIncome&&!!financials.pretaxIncome&&!!financials.taxExpense&&balanced(financials.operatingIncome.value-financials.interestExpense.value+financials.otherIncome.value,financials.pretaxIncome.value)&&balanced(financials.pretaxIncome.value-financials.taxExpense.value,financials.netIncome.value);
  result.push({start,end,currency:'USD',financials,revenues,expenses,issues,profile:expenseSplitComplete&&operatingEquationComplete?'direct_operating':'partial',coverage:{revenueSplitComplete,expenseSplitComplete,operatingEquationComplete,netEquationComplete}});
 }
 return result;
}
