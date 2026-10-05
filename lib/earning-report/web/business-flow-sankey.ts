import type { BusinessFlowQuarter, FlowMetric, FlowAmount } from "@/shared/analysis-contract/business-flow";
import { numeric, reconcileQuarter, disclosedSegmentLabel } from "./business-flow-model";

import { revenueNodeKey, selectRevenueTree } from "./revenue-tree";

export const metricLabels: Record<FlowMetric, string> = { revenue:"收入", cost:"营业成本", gross:"毛利", research:"研发", sales:"销售营销", administration:"行政", operatingExpenses:"运营费用", operating:"营业利润", other:"其他损益", pretax:"税前利润", tax:"所得税", net:"净利润" };
export type SankeyNode = { name:string; label:string; metric?:FlowMetric; segmentId?:string; depth:number; expense:boolean; loss?:boolean; credit?:boolean; offset?:boolean; value:number; amount?:FlowAmount };
export type SankeyLink = { source:string; target:string; value:number };
export type FinancialGraph = { nodes:SankeyNode[]; links:SankeyLink[]; notice:string | null; signed?:boolean };

export function validateGraph(nodes:SankeyNode[], links:SankeyLink[]): boolean {
  if (!nodes.length || nodes.length > 64 || links.length > 128) return false;
  const ids=new Set(nodes.map(n=>n.name));
  if(ids.size!==nodes.length || nodes.some(n=>!n.name || !Number.isFinite(n.value) || n.value<0)) return false;
  if(links.some(l=>!ids.has(l.source)||!ids.has(l.target)||!Number.isFinite(l.value)||l.value<=0)) return false;
  for (const n of nodes) {
    const incoming = links.filter(l => l.target === n.name), outgoing = links.filter(l => l.source === n.name);
    const a = incoming.reduce((sum, l) => sum + l.value, 0), b = outgoing.reduce((sum, l) => sum + l.value, 0);
    // At a zero-crossing item, one part offsets the previous balance and the remainder
    // becomes the next balance. Its two ports partition the disclosed amount.
    if (n.offset ? Math.abs(a + b - n.value) > Math.max(1e-6, n.value * 1e-9)
      : incoming.length && outgoing.length && Math.abs(a - b) > Math.max(1e-6, Math.max(a, b) * 1e-9)) return false;
  }
  const visiting=new Set<string>(), done=new Set<string>();
  function walk(id:string):boolean { if(visiting.has(id))return false; if(done.has(id))return true; visiting.add(id); for(const link of links.filter(l=>l.source===id)){if(!walk(link.target))return false;} visiting.delete(id);done.add(id);return true; }
  return nodes.every(n=>walk(n.name));
}

/** Signed statements use balanced deficit flows; incomplete statements never invent amounts. */
export function financialGraph(q:BusinessFlowQuarter, compact=false):FinancialGraph {
 const nodes:SankeyNode[]=[],links:SankeyLink[]=[];
 if(q.incomeModel==="financial"||q.incomeModel==="insurance"){
  const v=(key:FlowMetric)=>numeric(q.figures[key]);const r=v("revenue"),e=v("operatingExpenses"),p=v("pretax"),t=v("tax"),n=v("net");
  if([r,e,p,t,n].some(value=>value==null||value<0)||r!<=0||Math.abs(r!-e!-p!)>Math.max(1,r!*1e-9)||Math.abs(p!-t!-n!)>Math.max(1,p!*1e-9))return {nodes,links,notice:"金融与保险财报需完整收入、已披露费用、税前、税费及净利桥；缺项或亏损不转换成正流量。"};
  const defs=[['revenue',"财报收入（按原披露口径）",0,r,false],['operatingExpenses',"财报费用合计",1,e,true],['pretax',"税前利润",1,p,false],['tax',"所得税",2,t,true],['net',"净利润",2,n,false]] as const;
  for(const[key,label,depth,value,expense]of defs)nodes.push({name:key,label,metric:key,depth,expense,value:value!});
  for(const[source,target,value]of [['revenue','operatingExpenses',e],['revenue','pretax',p],['pretax','tax',t],['pretax','net',n]] as const)if(value!>0)links.push({source,target,value:value!});
  const connected=nodes.filter(node=>links.some(link=>link.source===node.name||link.target===node.name));return validateGraph(connected,links)?{nodes:connected,links,notice:"金融/保险按财报净收入与实际费用口径展示，不推定营业成本或毛利。"}:{nodes:[],links:[],notice:"金融口径流量未对平。"};
 }
 if (hasSignedFigures(q)) return signedFinancialGraph(q);
 const v=(key:FlowMetric)=>numeric(q.figures[key]);
 const checks=reconcileQuarter(q);
 const balanced=(i:number)=>checks[i]?.status==="balanced";
 const segmentIds=q.segments.map(s=>s.id);
 if(segmentIds.length>40 || new Set(segmentIds).size!==segmentIds.length) return {nodes,links,notice:"分部标识重复或超过图表上限；请核对披露明细。"};
 const tree=selectRevenueTree(q);
 const hasSegments=tree!==null;
 const offset=(tree?.depth??0)+(q.revenueAdjustments?.length?1:0);
 function node(key:FlowMetric,depth:number,expense=false){ if(!nodes.some(n=>n.name===key))nodes.push({name:key,label:metricLabels[key],metric:key,depth:depth+offset,expense,value:v(key)??0}); }
 function link(source:FlowMetric,target:FlowMetric,value:number|null,depth:number,expense=false){if(value==null||value<=0)return;node(source,depth-1);node(target,depth,expense);links.push({source,target,value});}
 if((v("revenue")??0)<=0) return {nodes,links,notice:"收入为零、负值或未披露；保留原披露金额，不绘制比例流量。"};
 node("revenue",0);
 if(tree) appendRevenueTree(q, tree, nodes, links, offset);

 let stage=0;
 if(q.incomeModel==="direct_operating"){


  if(!balanced(1)||!balanced(2)||!balanced(3)||!balanced(4)||!balanced(5)||["operating","pretax","net","tax"].some(k=>(v(k as FlowMetric)??-1)<0))return {nodes:[],links:[],notice:"直接营业费用口径存在缺项或有符号亏损；原披露金额保留在明细，不转换为正向流量。"};
  link("revenue","operating",v("operating"),1);
  const components=q.expenseComponents??[];
  if(components.some(c=>numeric(c.amount)==null||numeric(c.amount)!<0))return {nodes:[],links:[],notice:"费用包含缺项或有符号冲回，保留原披露明细，不转换为正向流量。"};
  const grouped=new Map<string,typeof components>();
  for(const c of components){const group=compact?"all":c.group==="other"||c.group==="administration"?"administration-other":c.group;grouped.set(group,[...(grouped.get(group)??[]),c]);}
  const labels:Record<string,string>={all:"已披露运营费用",direct:"产品与服务费用",research:"研发",sales:"销售营销","administration-other":"行政、摊销与重组"};
  for(const [group,items] of grouped){
   const value=items.reduce((sum,c)=>sum+(numeric(c.amount)??0),0);if(value<0)return {nodes:[],links:[],notice:"费用包含有符号冲回，保留原披露明细。"};if(!value)continue;
   const names=items.map(c=>c.id).sort().join("+");const amount:FlowAmount={value:String(value),basis:"derived",definition:"expense-group:"+names,comparabilityKey:"expense-group:"+names,sourceIds:[...new Set(items.flatMap(c=>c.amount.sourceIds))],formula:items.map(c=>c.name).join(" + "),lineage:items.flatMap(c=>c.amount.lineage??[])};
   const name="expense:"+group;nodes.push({name,label:labels[group]??group,depth:1+offset,expense:true,value,amount});links.push({source:"revenue",target:name,value});
  }
  let negative=0;
  for(const c of q.otherComponents??[]){const signed=numeric(c.amount);if(signed==null)return {nodes:[],links:[],notice:"其他损益尚未完整披露。"};if(!signed)continue;
   const name="other:"+c.id;nodes.push({name,label:c.name,depth:(signed<0?2:1)+offset,expense:signed<0,value:Math.abs(signed),amount:c.amount});
   if(signed<0){negative-=signed;links.push({source:"operating",target:name,value:-signed});}else links.push({source:name,target:"pretax",value:signed});
  }
  link("operating","pretax",v("operating")!-negative,2);
  link("pretax","net",v("net"),3);link("pretax","tax",v("tax"),3,true);
  const connected=nodes.filter(n=>links.some(l=>l.source===n.name||l.target===n.name));
  return validateGraph(connected,links)?{nodes:connected,links,notice:"直接营业费用口径 · 未披露 GAAP 毛利，不推定毛利节点；费用分组明细可展开。"}:{nodes:[],links:[],notice:"流量校验失败，保留原披露明细。"};
 }

 if(balanced(1) && (v("gross")??-1)>=0 && (v("cost")??-1)>=0){link("revenue","gross",v("gross"),1);link("revenue","cost",v("cost"),1,true);stage=1;}
 if(stage===1 && balanced(2) && (v("operating")??-1)>=0 && (v("operatingExpenses")??-1)>=0){
   link("gross","operating",v("operating"),2);
   if(balanced(5) && !compact && q.expenseComponents?.length){
    for(const component of q.expenseComponents){const value=numeric(component.amount);if(value==null||value<0)return {nodes:[],links:[],notice:"费用分类包含未知或负值，保留原披露明细。"};if(!value)continue;const name="expense:"+component.id;nodes.push({name,label:component.name,depth:2+offset,expense:true,value,amount:component.amount});links.push({source:"gross",target:name,value});}
   }else if(balanced(5) && ["research","sales","administration"].every(k=>(v(k as FlowMetric)??-1)>=0)){
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

 if(compact && nodes.some(n=>n.name==="research"||n.name==="sales"||n.name==="administration")){
  const small=nodes.filter(n=>n.name==="research"||n.name==="sales"||n.name==="administration");const value=small.reduce((sum,n)=>sum+n.value,0);
  for(const n of small)nodes.splice(nodes.indexOf(n),1);
  for(let i=links.length-1;i>=0;i--)if(small.some(n=>n.name===links[i].target))links.splice(i,1);
  node("operatingExpenses",2,true);links.push({source:"gross",target:"operatingExpenses",value});
 }
 const connected=nodes.filter(n=>links.some(l=>l.source===n.name||l.target===n.name));
 if(!links.length || !validateGraph(connected,links))return {nodes:[],links:[],notice:"当前披露不足以构建已对平的非负流量；金额和业务解读保留在下方。"};
 return {nodes:connected,links,notice:stage<4?"只绘制已披露、已对平的非负部分；亏损或缺失项保留原值，不转换为正向流量。":!hasSegments?"财务路径已对平；收入构成未完整披露，不分配业务比例。":null};
}


export function hasSignedFigures(q: BusinessFlowQuarter): boolean {
 return Object.entries(q.figures).some(([key, amount]) => key !== "other" && (numeric(amount) ?? 0) < 0)
  || (q.expenseComponents ?? []).some(c => (numeric(c.amount) ?? 0) < 0);
}

/** Each stage follows the statement from revenue to net income. Negative balances
 * carry forward as losses. When a stage crosses zero, the adjusting item is split
 * into the amount offset against the prior balance and the remainder carried forward. */
function signedFinancialGraph(q: BusinessFlowQuarter): FinancialGraph {
 const nodes = new Map<string, SankeyNode>(), links: SankeyLink[] = [];
 const unavailable = (): FinancialGraph => ({ nodes: [], links: [], signed: true, notice: "有符号财务路径存在缺项或未对平，保留原披露金额，不推定流量。" });
 const checks = reconcileQuarter(q), direct = q.incomeModel === "direct_operating";
 if (!(direct ? [1, 3, 4] : [1, 2, 3, 4]).every(i => checks[i]?.status === "balanced")) return unavailable();
 type Term = { node: SankeyNode; value: number };
 const profit = new Set<FlowMetric>(["gross", "operating", "pretax", "net"]);
 function metric(key: FlowMetric): Term {
  const value = numeric(q.figures[key])!;
  const loss = profit.has(key) && value < 0;
  const expense = ["cost", "operatingExpenses", "tax", "research", "sales", "administration"].includes(key);
  const label = loss ? ({ gross: "毛亏损", operating: "营业亏损", pretax: "税前亏损", net: "净亏损" } as Partial<Record<FlowMetric, string>>)[key]!
   : expense && value < 0 ? key === "tax" ? "所得税收益" : metricLabels[key] + "冲回" : metricLabels[key];
  return { node: { name: key, label, metric: key, value: Math.abs(value), depth: 0, expense: (expense && value > 0) || (key === "other" && value < 0), loss, credit: expense && value < 0 }, value };
 }
 function components(kind: "expense" | "other", fallback: FlowMetric): Term[] | null {
  const items = kind === "expense" ? q.expenseComponents : q.otherComponents;
  if (!items?.length) return [metric(fallback)];
  const values = items.map(c => numeric(c.amount));
  if (values.some(v => v == null) || Math.abs(values.reduce<number>((sum, v) => sum + v!, 0) - numeric(q.figures[fallback])!) > Math.max(1e-6, Math.abs(numeric(q.figures.revenue)!) * 1e-9)) return null;
  return items.map((c, i) => ({ value: values[i]!, node: { name: kind + ":" + c.id, label: c.name, amount: c.amount, depth: 0, value: Math.abs(values[i]!), expense: kind === "expense" ? values[i]! > 0 : values[i]! < 0, credit: kind === "expense" && values[i]! < 0 } }));
 }
 let depth = 0;
 function equation(left: Term[], right: Term[]) {
  const prior = left[0], result = right[0];
  // Choose the result's sign so both the prior balance and result travel forward.
  const direction = Math.sign(result.value) || Math.sign(prior.value) || 1;
  const terms = [...left.map(t => ({ ...t, balance: t.value * direction })), ...right.map(t => ({ ...t, balance: -t.value * direction }))];
  const sources = terms.filter(t => t.balance > 0), sinks = terms.filter(t => t.balance < 0).sort((a, b) => Number(b.node.name === prior.node.name) - Number(a.node.name === prior.node.name));
  for (const t of terms) if (t.value !== 0 && !nodes.has(t.node.name)) {
   t.node.depth = t.node.name === prior.node.name || (t.balance > 0 && t.node.name !== result.node.name) ? depth : depth + 1;
   nodes.set(t.node.name, t.node);
  }
  let i = 0, j = 0;
  while (i < sources.length && j < sinks.length) {
   const source = sources[i], target = sinks[j], value = Math.min(source.balance, -target.balance);
   if (target.node.name === prior.node.name) {
    // The old balance offsets part of this item; the remainder flows to the result.
    nodes.get(source.node.name)!.offset = true;
    nodes.get(source.node.name)!.depth = depth + 1;
    if (nodes.has(result.node.name)) nodes.get(result.node.name)!.depth = depth + 2;
    links.push({ source: target.node.name, target: source.node.name, value });
   } else {
    links.push({ source: source.node.name, target: target.node.name, value });
   }
   source.balance -= value; target.balance += value;
   if (source.balance === 0) i++;
   if (target.balance === 0) j++;
  }
  depth = nodes.get(result.node.name)?.depth ?? depth + 1;
 }
 const expenses = components("expense", "operatingExpenses"), other = components("other", "other");
 if (!expenses || !other) return unavailable();
 if (!direct) equation([metric("revenue")], [metric("gross"), metric("cost")]);
 equation([metric(direct ? "revenue" : "gross")], [metric("operating"), ...expenses]);
 equation([metric("operating"), ...other], [metric("pretax")]);
 equation([metric("pretax")], [metric("net"), metric("tax")]);
 const tree = selectRevenueTree(q);
 if (tree) {
  const branches:SankeyNode[]=[];
  appendRevenueTree(q, tree, branches, links, nodes.get("revenue")?.depth??0);
  for(const node of branches)nodes.set(node.name,node);
 }
 const connected = [...nodes.values()].filter(n => links.some(l => l.source === n.name || l.target === n.name));
 if (!validateGraph(connected, links)) return unavailable();
 const indegree = new Map(connected.map(n => [n.name, links.filter(l => l.target === n.name).length]));
 const queue = connected.filter(n => indegree.get(n.name) === 0);
 for (let i = 0; i < queue.length; i++) for (const link of links.filter(l => l.source === queue[i].name)) {
  const target = nodes.get(link.target)!;
  target.depth = Math.max(target.depth, queue[i].depth + 1);
  indegree.set(target.name, indegree.get(target.name)! - 1);
  if (indegree.get(target.name) === 0) queue.push(target);
 }
 return { nodes: connected, links, signed: true, notice: "收入与成本费用逐步抵减，利润或亏损向右结转；跨过盈亏零点的项目分别显示已抵减与剩余金额。线宽表示金额绝对值。" };
}

/** Gross segment revenue is reconciled through explicit signed consolidation items.
 * Never allocate eliminations back to companies or present gross shares as net shares. */
function appendRevenueTree(q:BusinessFlowQuarter,tree:NonNullable<ReturnType<typeof selectRevenueTree>>,nodes:SankeyNode[],links:SankeyLink[],revenueDepth:number) {
 const adjustments=tree.legacy?q.revenueAdjustments??[]:[], hasAdjustments=adjustments.length>0;
 const root=hasAdjustments?'segment-total':'revenue';
 const nameOf=(id:string)=>'segment:'+revenueNodeKey(tree,id);
 for(const entry of tree.nodes){
  let level=1,parent=entry.parentId;
  while(parent!==null){level++;parent=tree.nodes.find(n=>n.id===parent)!.parentId;}
  nodes.push({name:nameOf(entry.id),label:disclosedSegmentLabel(entry.name),segmentId:revenueNodeKey(tree,entry.id),depth:revenueDepth-level-(hasAdjustments?1:0),expense:false,value:numeric(entry.revenue)!});
  links.push({source:nameOf(entry.id),target:entry.parentId===null?root:nameOf(entry.parentId),value:numeric(entry.revenue)!});
 }
 if(!hasAdjustments)return;
 const roots=tree.nodes.filter(n=>n.parentId===null),total=roots.reduce((sum,n)=>sum+numeric(n.revenue)!,0);
 const amount:FlowAmount={value:String(total),basis:'derived',definition:'segment-revenue-before-eliminations',comparabilityKey:'segment-total:'+roots.map(n=>n.revenue?.comparabilityKey??'').join('|'),sourceIds:[...new Set(roots.flatMap(n=>n.revenue!.sourceIds))],formula:'已披露分部收入之和（抵销前）',lineage:roots.flatMap(n=>n.revenue?.lineage??[])};
 nodes.push({name:root,label:'分部收入合计（抵销前）',amount,value:total,depth:revenueDepth-1,expense:false});
 let negative=0;
 for(const item of adjustments){const value=numeric(item.amount)!;if(!value)continue;
  const name='revenue-adjustment:'+item.id;
  nodes.push({name,label:item.name,amount:item.amount,value:Math.abs(value),depth:revenueDepth-(value>0?1:0),expense:value<0});
  if(value<0){negative-=value;links.push({source:root,target:name,value:-value});}else links.push({source:name,target:'revenue',value});
 }
 if(total-negative>0)links.push({source:root,target:'revenue',value:total-negative});
}
