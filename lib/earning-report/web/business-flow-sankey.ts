import type { BusinessFlowQuarter, FlowMetric } from "@/shared/analysis-contract/business-flow";
import { numeric, reconcileQuarter } from "./business-flow-model";

export const metricLabels: Record<FlowMetric, string> = { revenue:"收入", cost:"营业成本", gross:"毛利", research:"研发", sales:"销售营销", administration:"行政", operatingExpenses:"运营费用", operating:"营业利润", other:"其他损益", pretax:"税前利润", tax:"所得税", net:"净利润" };
export type SankeyNode = { name:string; label:string; metric?:FlowMetric; segmentId?:string; depth:number; expense:boolean; value:number };
export type SankeyLink = { source:string; target:string; value:number };
export type FinancialGraph = { nodes:SankeyNode[]; links:SankeyLink[]; notice:string | null };

export function validateGraph(nodes:SankeyNode[], links:SankeyLink[]): boolean {
  if (!nodes.length || nodes.length > 64 || links.length > 128) return false;
  const ids=new Set(nodes.map(n=>n.name));
  if(ids.size!==nodes.length || nodes.some(n=>!n.name || !Number.isFinite(n.value) || n.value<0)) return false;
  if(links.some(l=>!ids.has(l.source)||!ids.has(l.target)||!Number.isFinite(l.value)||l.value<=0)) return false;
  for(const n of nodes){const incoming=links.filter(l=>l.target===n.name),outgoing=links.filter(l=>l.source===n.name);if(incoming.length && outgoing.length){const a=incoming.reduce((s,l)=>s+l.value,0),b=outgoing.reduce((s,l)=>s+l.value,0);if(Math.abs(a-b)>Math.max(1e-6,Math.max(a,b)*1e-9))return false;}}
  const visiting=new Set<string>(), done=new Set<string>();
  function walk(id:string):boolean { if(visiting.has(id))return false; if(done.has(id))return true; visiting.add(id); for(const link of links.filter(l=>l.source===id)){if(!walk(link.target))return false;} visiting.delete(id);done.add(id);return true; }
  return nodes.every(n=>walk(n.name));
}

/** Only verified nonnegative subflows are drawn. Unknown/loss figures stay in the readable ledger. */
export function financialGraph(q:BusinessFlowQuarter, compact=false):FinancialGraph {
 const nodes:SankeyNode[]=[],links:SankeyLink[]=[];
 if(q.incomeModel==="financial"||q.incomeModel==="insurance") return {nodes,links,notice:"金融与保险披露采用不同利润表口径；当前标准成本/毛利桑基不适用，保留已披露指标与业务解读。"};
 const v=(key:FlowMetric)=>numeric(q.figures[key]);
 const checks=reconcileQuarter(q);
 const balanced=(i:number)=>checks[i]?.status==="balanced";
 const segmentIds=q.segments.map(s=>s.id);
 if(segmentIds.length>40 || new Set(segmentIds).size!==segmentIds.length) return {nodes,links,notice:"分部标识重复或超过图表上限；请核对披露明细。"};
 const hasSegments=balanced(0) && q.segments.every(s=>(numeric(s.revenue)??-1)>0);
 const offset=hasSegments?1:0;
 function node(key:FlowMetric,depth:number,expense=false){ if(!nodes.some(n=>n.name===key))nodes.push({name:key,label:metricLabels[key],metric:key,depth:depth+offset,expense,value:v(key)??0}); }
 function link(source:FlowMetric,target:FlowMetric,value:number|null,depth:number,expense=false){if(value==null||value<=0)return;node(source,depth-1);node(target,depth,expense);links.push({source,target,value});}
 if((v("revenue")??0)<=0) return {nodes,links,notice:"收入为零、负值或未披露；保留原披露金额，不绘制比例流量。"};
 node("revenue",0);
 if(hasSegments){
  const ordered=[...q.segments].sort((a,b)=>numeric(b.revenue)!-numeric(a.revenue)!);
  const shown=ordered.length>5?ordered.slice(0,4):ordered;
  for(const s of shown){const name="segment:"+s.id;nodes.push({name,label:s.name,segmentId:s.id,depth:0,expense:false,value:numeric(s.revenue)!});links.push({source:name,target:"revenue",value:numeric(s.revenue)!});}
  if(ordered.length>5){const value=ordered.slice(4).reduce((total,s)=>total+numeric(s.revenue)!,0);nodes.push({name:"segments:remaining",label:"其余 "+(ordered.length-4)+" 个已披露分部",depth:0,expense:false,value});links.push({source:"segments:remaining",target:"revenue",value});}
 }
 let stage=0;
 if(balanced(1) && (v("gross")??-1)>=0 && (v("cost")??-1)>=0){link("revenue","gross",v("gross"),1);link("revenue","cost",v("cost"),1,true);stage=1;}
 if(stage===1 && balanced(2) && (v("operating")??-1)>=0 && (v("operatingExpenses")??-1)>=0){
   link("gross","operating",v("operating"),2);
   if(balanced(5) && ["research","sales","administration"].every(k=>(v(k as FlowMetric)??-1)>=0)){
    for(const k of ["research","sales","administration"] as const)link("gross",k,v(k),2,true);
   }else link("gross","operatingExpenses",v("operatingExpenses"),2,true);
   stage=2;
 }
 if(stage===2 && balanced(3) && (v("pretax")??-1)>=0 && v("other")!=null){
   const other=v("other")!;
   if(other>=0){link("operating","pretax",v("operating"),3);if(other>0){node("other",2);node("pretax",3);links.push({source:"other",target:"pretax",value:other});}}
   else {link("operating","pretax",v("pretax"),3);node("other",3,true);links.push({source:"operating",target:"other",value:-other});nodes.find(n=>n.name==="other")!.value=-other;}
   stage=3;
 }
 if(stage===3 && balanced(4) && (v("tax")??-1)>=0 && (v("net")??-1)>=0){link("pretax","net",v("net"),4);link("pretax","tax",v("tax"),4,true);stage=4;}
 if(compact && hasSegments){
  const segments=nodes.filter(n=>n.name.startsWith("segment:")||n.name==="segments:remaining");
  const value=segments.reduce((sum,n)=>sum+n.value,0);
  for(const n of segments){nodes.splice(nodes.indexOf(n),1);}
  for(let i=links.length-1;i>=0;i--)if(segments.some(n=>n.name===links[i].source))links.splice(i,1);
  nodes.push({name:"business:segments",label:"已披露业务分部",metric:"revenue",depth:0,expense:false,value});links.push({source:"business:segments",target:"revenue",value});
 }
 if(compact && nodes.some(n=>n.name==="research"||n.name==="sales"||n.name==="administration")){
  const small=nodes.filter(n=>n.name==="research"||n.name==="sales"||n.name==="administration");const value=small.reduce((sum,n)=>sum+n.value,0);
  for(const n of small)nodes.splice(nodes.indexOf(n),1);
  for(let i=links.length-1;i>=0;i--)if(small.some(n=>n.name===links[i].target))links.splice(i,1);
  node("operatingExpenses",2,true);links.push({source:"gross",target:"operatingExpenses",value});
 }
 const connected=nodes.filter(n=>links.some(l=>l.source===n.name||l.target===n.name));
 if(!links.length || !validateGraph(connected,links))return {nodes:[],links:[],notice:"当前披露不足以构建已对平的非负流量；金额和业务解读保留在下方。"};
 return {nodes:connected,links,notice:stage<4?"只绘制已披露、已对平的非负部分；亏损或缺失项保留原值，不转换为正向流量。":!hasSegments?"财务路径已对平；分部营收未完整披露，不分配业务比例。":null};
}
