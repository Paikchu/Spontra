import {publicFlowSchema} from './schema.ts';
import type { PublicBusinessFlow, BusinessFlowQuarter, FlowAmount, FlowMetric } from '../../analysis-contract/business-flow.ts';
import type { CompleteFlowCheck, CompleteFlowReason } from '../../analysis-contract/complete-business-flow.ts';
const number=(amount:FlowAmount|undefined|null):number|null=>typeof amount?.value==='string'&&amount.value.trim()!==''&&Number.isFinite(Number(amount.value))?Number(amount.value):null;
const balanced=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1e-6,Math.max(Math.abs(a),Math.abs(b))*1e-9);
const sourceUrl=(text:string)=>{try{const u=new URL(text);return u.protocol==='https:'&&(u.hostname==='www.sec.gov'||u.hostname==='sec.gov'||u.hostname==='data.sec.gov');}catch{return false;}};
/** A same-filing 6M minus Q2 bridge uses a later operand period. Both sides must have
 * identical concepts/dimensions and end dates, and bracket exactly the derived quarter. */
function samePresentationBridge(amount:FlowAmount,q:BusinessFlowQuarter,line:NonNullable<FlowAmount['lineage']>[number]):boolean {
 if(amount.basis!=='derived'||!q.periodStart||!line.contextId.startsWith('table-'))return false;
 const following=new Date(Date.parse(q.periodEnd)+86400000).toISOString().slice(0,10);
 const remaining=(Date.parse(line.periodEnd)-Date.parse(q.periodEnd))/86400000;
 if(remaining<70||remaining>110||![q.periodStart,following].includes(line.periodStart))return false;
 return !!amount.lineage?.some(other=>other.accession===line.accession&&other.url===line.url&&other.concept===line.concept
  &&JSON.stringify(other.dimensions)===JSON.stringify(line.dimensions)&&other.periodEnd===line.periodEnd
  &&other.periodStart===(line.periodStart===q.periodStart?following:q.periodStart));
}
/** The gate is independent of AI, browser code and storage. Unknown never means zero. */
export function checkCompleteFlow(flow:PublicBusinessFlow):CompleteFlowCheck{try{const parsed=publicFlowSchema.safeParse(flow);return parsed.success?validateCompleteFlow(parsed.data):{complete:false,reasons:['INVALID_PAYLOAD']};}catch{return {complete:false,reasons:["INVALID_PAYLOAD"]};}}
/** Historical reports are audited independently; lack of an adjacent comparable quarter does not hide a valid report. */
export function checkCompleteQuarter(quarter:BusinessFlowQuarter):CompleteFlowCheck{
 const parsed=publicFlowSchema.safeParse({schemaVersion:'business-flow.v1',ticker:'REPORT',fetchedAt:null,quarters:[quarter]});
 return parsed.success?validateCompleteFlow(parsed.data,false):{complete:false,reasons:['INVALID_PAYLOAD']};
}
function validateCompleteFlow(flow:PublicBusinessFlow,requirePair=true):CompleteFlowCheck{
 const reasons=new Set<CompleteFlowReason>();
 if(flow.schemaVersion!=='business-flow.v1'||!flow.ticker||!Array.isArray(flow.quarters)){return {complete:false,reasons:['INVALID_PAYLOAD']};}
 const quarters=[...flow.quarters].sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd));
 if(quarters.length!==(requirePair?2:1)||new Set(quarters.map(q=>q.id)).size!==quarters.length)return {complete:false,reasons:['MISSING_TWO_QUARTERS']};
 const current=quarters[0],previous=quarters[1]??current;const gap=(Date.parse(current.periodEnd)-Date.parse(previous.periodEnd))/86400000;
 if(requirePair&&(!Number.isFinite(gap)||gap<70||gap>110||current.currency!==previous.currency||current.scale!==previous.scale||current.incomeModel!==previous.incomeModel))reasons.add('INCOMPARABLE_QUARTERS');
 for(const q of quarters){
  const days=q.periodStart?(Date.parse(q.periodEnd)-Date.parse(q.periodStart))/86400000:NaN;
  if(q.periodType!=='3M'||!Number.isFinite(days)||days<70||days>110||!Number.isFinite(q.scale)||q.scale<=0)reasons.add('INVALID_PAYLOAD');
  if(!['standard','direct_operating','financial','insurance'].includes(q.incomeModel??'')){reasons.add('UNSUPPORTED_INDUSTRY');continue;}
  const financial=q.incomeModel==='financial'||q.incomeModel==='insurance';
  const keys:FlowMetric[]=financial?(q.incomeModel==='insurance'?['revenue','operatingExpenses','other','pretax','tax','net']:['revenue','operatingExpenses','pretax','tax','net']):q.incomeModel==='standard'?['revenue','cost','gross','operatingExpenses','operating','other','pretax','tax','net']:['revenue','operatingExpenses','operating','other','pretax','tax','net'];
  const validAmount=(amount:FlowAmount|undefined|null)=>{
   if(number(amount)==null){reasons.add('MISSING_DISCLOSURE');return;}
   if(!amount!.sourceIds.length||!amount!.sourceIds.every(id=>q.sources.some(s=>s.id===id&&sourceUrl(s.url)))||!amount!.lineage?.length||!amount!.lineage.every(l=>sourceUrl(l.url)&&l.accession&&l.concept&&l.contextId&&amount!.sourceIds.includes(l.accession)&&((l.periodStart===q.periodStart&&l.periodEnd===q.periodEnd)||samePresentationBridge(amount!,q,l)||(amount!.basis==='derived'&&l.periodStart<q.periodStart!&&(l.periodEnd===q.periodEnd||Date.parse(l.periodEnd)+86400000===Date.parse(q.periodStart!))))))reasons.add('INVALID_SOURCE');
   if(amount!.basis==='derived'&&!amount!.formula)reasons.add('INVALID_SOURCE');
  };
  keys.forEach(key=>{validAmount(q.figures[key]);if(requirePair&&(!q.figures[key]?.comparabilityKey||q.figures[key]?.comparabilityKey!==previous.figures[key]?.comparabilityKey))reasons.add('INCOMPARABLE_QUARTERS');});
  const v=(key:FlowMetric)=>number(q.figures[key]);
  const check=(left: number|null,right:number|null)=>{if(left==null||right==null)return;if(!balanced(left,right))reasons.add('UNBALANCED_STATEMENT');};
  const sub=(a:number|null,b:number|null)=>a==null||b==null?null:a-b;
  if(q.incomeModel==='standard'){check(sub(v('revenue'),v('cost')),v('gross'));check(sub(v('gross'),v('operatingExpenses')),v('operating'));}
  else if(q.incomeModel==='insurance'){const subtotal=sub(v('revenue'),v('operatingExpenses'));check(subtotal==null||v('other')==null?null:subtotal+v('other')!,v('pretax'));}else check(sub(v('revenue'),v('operatingExpenses')),v(financial?'pretax':'operating'));
  if(!financial)check(v('operating')==null||v('other')==null?null:v('operating')!+v('other')!,v('pretax'));check(sub(v('pretax'),v('tax')),v('net'));
  if(!q.segmentsComplete||!q.segments.length||new Set(q.segments.map(s=>s.id)).size!==q.segments.length)reasons.add('MISSING_DISCLOSURE');
  const adjustments=q.revenueAdjustments??[];
  adjustments.forEach(a=>validAmount(a.amount));
  if(new Set(adjustments.map(a=>a.id)).size!==adjustments.length)reasons.add('INVALID_PAYLOAD');
  q.segments.forEach(s=>validAmount(s.revenue));const leaves=q.segments.map(s=>number(s.revenue));if(leaves.every(n=>n!=null))check(leaves.reduce((sum,n)=>sum+n!,0)+adjustments.reduce((sum,a)=>sum+(number(a.amount)??NaN),0),v('revenue'));
  const expenses=q.expenseComponents??[];if((q.incomeModel==='direct_operating'||financial)&&!expenses.length)reasons.add('MISSING_DISCLOSURE');
  expenses.forEach(c=>validAmount(c.amount));if(expenses.length)check(expenses.reduce((sum,c)=>sum+(number(c.amount)??NaN),0),v('operatingExpenses'));
  const others=q.otherComponents??[];
  if(!financial&&q.incomeModel==='direct_operating'&&!others.length)reasons.add('MISSING_DISCLOSURE');
  others.forEach(c=>validAmount(c.amount));if((!financial||q.incomeModel==='insurance')&&others.length)check(others.reduce((sum,c)=>sum+(number(c.amount)??NaN),0),v('other'));
  if(new Set(expenses.map(c=>c.id)).size!==expenses.length||new Set(others.map(c=>c.id)).size!==others.length)reasons.add('INVALID_PAYLOAD');
  if(!keys.every(key=>number(q.figures[key])!=null))reasons.add('MISSING_DISCLOSURE');
  // Signed profit, tax benefit and expense reversals use the complete accounting bridge.
  // Revenue proportions still require strictly positive disclosed business amounts.
  if((v('revenue')??0)<=0||leaves.some(n=>(n??0)<0))reasons.add('SIGNED_LAYOUT_UNSUPPORTED');
 }
 // Department reorganizations affect per-department comparisons, not publication.
 // Each quarter still requires sourced departments that reconcile to its own revenue.
 return {complete:reasons.size===0,reasons:[...reasons]};
}
export function newestPair(flow:PublicBusinessFlow):PublicBusinessFlow{return {...flow,quarters:[...flow.quarters].sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd)).slice(0,2)};}
export function disclosedWholeCompany(q:BusinessFlowQuarter):BusinessFlowQuarter{
 if(q.segments.length||number(q.figures.revenue)==null)return q;
 return {...q,segmentsComplete:true,segments:[{id:'reported-company-total',name:q.segmentDisclosure==='single_reportable_segment'?'公司整体收入（单一报告部门）':'公司整体收入（部门拆分尚未核验）',revenue:q.figures.revenue!,description:q.segmentDisclosure==='single_reportable_segment'?'财报明确披露公司按单一经营及报告部门管理，使用已披露的合并收入。':'使用财报披露的公司合并金额；当前部门映射尚未核验，不宣称原财报未披露部门。',products:[],customers:null,monetization:null,disclosure:q.segmentDisclosure==='single_reportable_segment'?'单一报告部门，不推定未披露的产品收入比例。':'部门拆分尚未核验；当前仅展示已披露合并金额，不分配部门比例。',sourceIds:q.figures.revenue!.sourceIds}]};
}
