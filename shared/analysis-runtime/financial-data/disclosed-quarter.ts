import type {BusinessFlowQuarter,BusinessSegment,FlowAmount,FlowMetric} from '../../analysis-contract/business-flow.ts';
import type {BusinessFact,ParsedBusinessQuarter} from './business-flow-parser.ts';
const BUSINESS_FLOW_PARSER_VERSION='sec-business-flow.v2';
const sum = (facts: BusinessFact[]) => facts.reduce((v,f)=>v+f.value,0);
const groupFor = (id: string) => id === 'ResearchAndDevelopmentExpense' ? 'research' : id === 'SellingAndMarketingExpense' ? 'sales' : id === 'GeneralAndAdministrativeExpense' ? 'administration' : ['CloudAndSoftwareExpenses','CloudServicesAndLicenseSupportExpense','HardwareExpenses','ServicesExpense'].includes(id) ? 'direct' : 'other';
const canonicalRevenue = (id: string) => id === 'SalesRevenueServicesNet1' ? 'SalesRevenueServicesNet' : id;
export function buildPublishedBusinessQuarter(parsed: ParsedBusinessQuarter, filedAt: string): BusinessFlowQuarter | null {
 if(parsed.profile !== 'direct_operating' || Object.values(parsed.coverage).some(v=>!v) || parsed.issues.length) return null;
 const source = Object.values(parsed.financials)[0]?.lineage;
 if(!source || !parsed.expenses.length || !parsed.revenues.length) return null;
 const amount=(fact:BusinessFact,definition:string,value=fact.value):FlowAmount=>({value:String(value),basis:value===fact.value?'reported':'derived',...(value===fact.value?{}:{formula:'有符号流向 = − 原披露费用金额'}),definition:`${BUSINESS_FLOW_PARSER_VERSION}:${definition}`,comparabilityKey:`${BUSINESS_FLOW_PARSER_VERSION}:${definition}:original-disclosure`,sourceIds:[fact.lineage.accession],lineage:[{accession:fact.lineage.accession,url:fact.lineage.sourceUrl,concept:fact.lineage.tag,contextId:fact.lineage.contextId,periodStart:fact.lineage.start,periodEnd:fact.lineage.end,dimensions:fact.lineage.dimensions,parserVersion:BUSINESS_FLOW_PARSER_VERSION}]});
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
