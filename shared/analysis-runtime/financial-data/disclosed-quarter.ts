import type {BusinessFlowQuarter,BusinessSegment,FlowAmount,FlowMetric} from '../../analysis-contract/business-flow.ts';
import type {BusinessFact,ParsedBusinessQuarter} from './business-flow-parser.ts';
const BUSINESS_FLOW_PARSER_VERSION='sec-business-flow.v3';
const sum = (facts: BusinessFact[]) => facts.reduce((v,f)=>v+f.value,0);
const groupFor = (id: string) => id === 'ResearchAndDevelopmentExpense' ? 'research' : id === 'SellingAndMarketingExpense' ? 'sales' : id === 'GeneralAndAdministrativeExpense' ? 'administration' : ['CloudAndSoftwareExpenses','CloudServicesAndLicenseSupportExpense','HardwareExpenses','ServicesExpense'].includes(id) ? 'direct' : 'other';
const canonicalRevenue = (id: string) => id === 'SalesRevenueServicesNet1' ? 'SalesRevenueServicesNet' : id;
/** The disclosed category a leaf belongs to, the same whether a filing prints the category total or only its offerings. */
const revenueCategory = (id: string) => ['CloudApplications','CloudInfrastructure','CloudRevenues'].includes(id) ? 'cloud' : ['SoftwareLicense','SoftwareSupport','SoftwareRevenues'].includes(id) ? 'software' : id;
const categoryNames: Record<string,string> = {cloud:'Cloud',software:'Software',HardwareRevenues:'Hardware',SalesRevenueServicesNet:'Services'};
export function buildPublishedBusinessQuarter(parsed: ParsedBusinessQuarter, filedAt: string): BusinessFlowQuarter | null {
 if(parsed.profile !== 'direct_operating' || Object.values(parsed.coverage).some(v=>!v) || parsed.issues.length) return null;
 const source = Object.values(parsed.financials)[0]?.lineage;
 if(!source || !parsed.expenses.length || !parsed.revenues.length) return null;
 const amount=(fact:BusinessFact,definition:string,value=fact.value):FlowAmount=>({value:String(value),basis:value===fact.value?'reported':'derived',...(value===fact.value?{}:{formula:'Signed flow = − reported expense'}),definition:`${BUSINESS_FLOW_PARSER_VERSION}:${definition}`,comparabilityKey:`${BUSINESS_FLOW_PARSER_VERSION}:${definition}:original-disclosure`,sourceIds:[fact.lineage.accession],lineage:[{accession:fact.lineage.accession,url:fact.lineage.sourceUrl,concept:fact.lineage.tag,contextId:fact.lineage.contextId,periodStart:fact.lineage.start,periodEnd:fact.lineage.end,dimensions:fact.lineage.dimensions,parserVersion:BUSINESS_FLOW_PARSER_VERSION}]});
 const f=parsed.financials;
 const figures:BusinessFlowQuarter['figures']={};
 for(const [target,field] of [['revenue','revenue'],['operatingExpenses','totalOperatingExpenses'],['operating','operatingIncome'],['pretax','pretaxIncome'],['tax','taxExpense'],['net','netIncome']] as const) if(f[field])figures[target]=amount(f[field],target);
 if(!f.interestExpense || !f.otherIncome) return null;
 const otherComponents=[{id:'interest',name:'Interest expense',amount:amount(f.interestExpense,'interest',-f.interestExpense.value)},{id:'nonoperating',name:'Non-operating income, net',amount:amount(f.otherIncome,'nonoperating')}];
 figures.other={...amount(f.otherIncome,'other',f.otherIncome.value-f.interestExpense.value),basis:'derived',formula:'Non-operating income, net − interest expense',lineage:otherComponents.flatMap(c=>c.amount.lineage??[])};
 const expenseComponents=parsed.expenses.map(c=>({id:c.id,name:c.label,group:groupFor(c.id) as 'direct'|'research'|'sales'|'administration'|'other',amount:amount(c.fact,c.id)}));
 for(const [key,group] of [['research','research'],['sales','sales'],['administration','administration']] as const){const c=expenseComponents.find(c=>c.group===group);if(c)figures[key]=c.amount;}
 const revenueGroups = new Map<string, typeof parsed.revenues>();
 for(const leaf of parsed.revenues){const key=revenueCategory(canonicalRevenue(leaf.id));revenueGroups.set(key,[...(revenueGroups.get(key)??[]),leaf]);}
 const segments:BusinessSegment[]=[...revenueGroups].map(([id,leaves])=>{
  const children=leaves.map(l=>({id:canonicalRevenue(l.id),name:l.label,revenue:amount(l.fact,canonicalRevenue(l.id))}));
  const total=sum(leaves.map(l=>l.fact));
  // A category is one measure whether it was printed as a total or summed from its offerings, so periods compare across both.
  const revenue=leaves.length===1?amount(leaves[0].fact,`segment:${id}`):{...amount(leaves[0].fact,`segment:${id}`,total),basis:'derived' as const,formula:children.map(l=>l.name).join(' + '),lineage:children.flatMap(l=>l.revenue.lineage??[])};
  return {id,name:categoryNames[id]??leaves[0].label,revenue,children:leaves.length>1?children:undefined,description:'Revenue by product or service category as the filing discloses it; the products it covers are as the filing describes them.',products:children.map(l=>l.name),customers:null,monetization:'Revenue from the category\'s products, licenses, support or services; an individual product\'s share is not allocated when the filing does not disclose it.',disclosure:'Quarterly revenue categories do not overlap and sum to company revenue. Expenses are drawn only at the consolidated level, never allocated to products.',sourceIds:[source.accession]};
 });
 const values=(keys:FlowMetric[])=>keys.map(k=>Number(figures[k]?.value));
 const [r,o,p,t,n]=values(['revenue','operating','pretax','tax','net']);
 const tolerance=Math.max(1,Math.abs(r)*1e-9);
 if([r,o,p,t,n].some(v=>!Number.isFinite(v)) || Math.abs(r-sum(parsed.expenses.map(c=>c.fact))-o)>tolerance || Math.abs(o-f.interestExpense.value+f.otherIncome.value-p)>tolerance || Math.abs(p-t-n)>tolerance)return null;
 return {id:parsed.end,incomeModel:'direct_operating',label:`Three months ended ${parsed.end}`,periodStart:parsed.start,periodEnd:parsed.end,periodType:'3M',currency:parsed.currency,scale:1,basisLabel:'As reported to the SEC each quarter · direct operating expenses (no GAAP gross profit disclosed) · categories compared as each period reports them',reportedAt:filedAt,figures,segments,segmentsComplete:true,expenseComponents,otherComponents,sources:[{id:source.accession,title:`SEC filing ${source.accession}`,url:source.sourceUrl,publishedAt:filedAt}]};
}
