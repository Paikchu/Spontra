import type { BusinessFlowQuarter, FlowMetric, FlowAmount } from "@/shared/analysis-contract/business-flow";
import { numeric, reconcileQuarter } from "./business-flow-model";

import { revenueNodeKey, selectRevenueTree } from "./revenue-tree";
import { labels, messages } from "@/packages/web/src/i18n/core";

/** Statement lines in the page's locale; a node's label is read when its graph is built. */
export const metricLabels: Record<FlowMetric, string> = labels(
 { revenue:"Revenue", cost:"Cost of revenue", gross:"Gross profit", research:"Research and development", sales:"Sales and marketing", administration:"General and administrative", operatingExpenses:"Operating expenses", operating:"Operating income", other:"Other income (expense), net", pretax:"Income before taxes", tax:"Income taxes", net:"Net income" },
 { revenue:"营收", cost:"营业成本", gross:"毛利", research:"研发费用", sales:"销售及市场费用", administration:"管理费用", operatingExpenses:"营业费用", operating:"营业利润", other:"营业外收支净额", pretax:"税前利润", tax:"所得税", net:"净利润" });
const m = messages({
 revenueReported: "Revenue (as reported)", totalExpenses: "Total expenses", allExpenses: "Operating expenses", direct: "Cost of products and services",
 adminOther: "G&A, amortization and restructuring", grossLoss: "Gross loss", operatingLoss: "Operating loss", pretaxLoss: "Loss before taxes", netLoss: "Net loss",
 taxBenefit: "Income tax benefit", reversal: (label: string) => `${label} reversal`, otherExpense: "Other expense, net", otherIncome: "Other income, net",
 segmentTotal: "Segment revenue (before reconciling items)", segmentTotalFormula: "Sum of disclosed segment revenue (before reconciling items)",
}, {
 revenueReported: "营收（披露值）", totalExpenses: "总费用", allExpenses: "营业费用", direct: "产品与服务成本",
 adminOther: "管理、摊销及重组费用", grossLoss: "毛亏损", operatingLoss: "营业亏损", pretaxLoss: "税前亏损", netLoss: "净亏损",
 taxBenefit: "所得税收益", reversal: (label: string) => `${label}冲回`, otherExpense: "营业外支出净额", otherIncome: "营业外收入净额",
 segmentTotal: "分部营收（调节前）", segmentTotalFormula: "已披露分部营收之和（调节前）",
});
export type SankeyNode = { name:string; label:string; metric?:FlowMetric; segmentId?:string; depth:number; expense:boolean; loss?:boolean; credit?:boolean; offset?:boolean; value:number; amount?:FlowAmount };
export type SankeyLink = { source:string; target:string; value:number };
/** `deficit` graphs draw a loss as funding: every link is a positive flow, and the net loss is a source. */
export type FinancialGraph = { nodes:SankeyNode[]; links:SankeyLink[]; signed?:boolean; deficit?:boolean };

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

/**
 * The last stage, pretax income to net income: taxes and every line the statement places after them. A loss after
 * taxes leaves pretax income like the tax does; income after taxes joins net income from its own node.
 */
function afterTaxStage(q:BusinessFlowQuarter,nodes:SankeyNode[],links:SankeyLink[],depth:number,offset:number):boolean{
 const v=(key:FlowMetric)=>numeric(q.figures[key]);const pretax=v("pretax"),tax=v("tax"),net=v("net");
 if(pretax==null||tax==null||net==null||tax<0||net<0)return false;
 const items=(q.afterTaxComponents??[]).map(c=>({c,value:numeric(c.amount)}));if(items.some(i=>i.value==null))return false;
 const gains=items.filter(i=>i.value!>0),losses=items.filter(i=>i.value!<0);
 const kept=net-gains.reduce((sum,i)=>sum+i.value!,0);if(kept<0)return false;
 const add=(name:string,label:string,d:number,expense:boolean,value:number,amount?:FlowAmount,metric?:FlowMetric)=>{if(!nodes.some(n=>n.name===name))nodes.push({name,label,...(metric?{metric}:{}),depth:d+offset,expense,value,...(amount?{amount}:{})});};
 add("pretax",metricLabels.pretax,depth-1,false,pretax,undefined,"pretax");add("net",metricLabels.net,depth,false,net,undefined,"net");
 if(tax>0){add("tax",metricLabels.tax,depth,true,tax,undefined,"tax");links.push({source:"pretax",target:"tax",value:tax});}
 for(const{c,value}of losses){const name="after-tax:"+c.id;add(name,c.name,depth,true,-value!,c.amount);links.push({source:"pretax",target:name,value:-value!});}
 if(kept>0)links.push({source:"pretax",target:"net",value:kept});
 for(const{c,value}of gains){const name="after-tax:"+c.id;add(name,c.name,depth-1,false,value!,c.amount);links.push({source:name,target:"net",value:value!});}
 return true;
}

/** Signed statements use balanced deficit flows; incomplete statements never invent amounts. */
export function financialGraph(q:BusinessFlowQuarter, compact=false):FinancialGraph {
 const nodes:SankeyNode[]=[],links:SankeyLink[]=[];
 if(q.incomeModel==="financial"||q.incomeModel==="insurance"){
  const v=(key:FlowMetric)=>numeric(q.figures[key]);const r=v("revenue"),e=v("operatingExpenses"),p=v("pretax"),t=v("tax"),n=v("net");
  if([r,e,p,t,n].some(value=>value==null||value<0)||r!<=0||Math.abs(r!-e!-p!)>Math.max(1,r!*1e-9)||Math.abs(p!-t!-n!)>Math.max(1,p!*1e-9))return {nodes,links};
  const defs=[['revenue',m.revenueReported,0,r,false],['operatingExpenses',m.totalExpenses,1,e,true],['pretax',metricLabels.pretax,1,p,false],['tax',metricLabels.tax,2,t,true],['net',metricLabels.net,2,n,false]] as const;
  for(const[key,label,depth,value,expense]of defs)nodes.push({name:key,label,metric:key,depth,expense,value:value!});
  for(const[source,target,value]of [['revenue','operatingExpenses',e],['revenue','pretax',p],['pretax','tax',t],['pretax','net',n]] as const)if(value!>0)links.push({source,target,value:value!});
  const connected=nodes.filter(node=>links.some(link=>link.source===node.name||link.target===node.name));return validateGraph(connected,links)?{nodes:connected,links}:{nodes:[],links:[]};
 }
 if (hasSignedFigures(q)) return signedFinancialGraph(q);
 const v=(key:FlowMetric)=>numeric(q.figures[key]);
 const checks=reconcileQuarter(q);
 const balanced=(i:number)=>checks[i]?.status==="balanced";
 const segmentIds=q.segments.map(s=>s.id);
 if(segmentIds.length>40 || new Set(segmentIds).size!==segmentIds.length) return {nodes,links};
 const tree=selectRevenueTree(q);
 const offset=(tree?.depth??0)+(q.revenueAdjustments?.length?1:0);
 function node(key:FlowMetric,depth:number,expense=false){ if(!nodes.some(n=>n.name===key))nodes.push({name:key,label:metricLabels[key],metric:key,depth:depth+offset,expense,value:v(key)??0}); }
 function link(source:FlowMetric,target:FlowMetric,value:number|null,depth:number,expense=false){if(value==null||value<=0)return;node(source,depth-1);node(target,depth,expense);links.push({source,target,value});}
 if((v("revenue")??0)<=0) return {nodes,links};
 node("revenue",0);
 if(tree) appendRevenueTree(q, tree, nodes, links, offset);

 let stage=0;
 if(q.incomeModel==="direct_operating"){


  if(!balanced(1)||!balanced(2)||!balanced(3)||!balanced(4)||!balanced(5)||["operating","pretax","net","tax"].some(k=>(v(k as FlowMetric)??-1)<0))return {nodes:[],links:[]};
  link("revenue","operating",v("operating"),1);
  const components=q.expenseComponents??[];
  if(components.some(c=>numeric(c.amount)==null||numeric(c.amount)!<0))return {nodes:[],links:[]};
  const grouped=new Map<string,typeof components>();
  for(const c of components){const group=compact?"all":c.group==="other"||c.group==="administration"?"administration-other":c.group;grouped.set(group,[...(grouped.get(group)??[]),c]);}
  const groupLabels:Record<string,string>={all:m.allExpenses,direct:m.direct,research:metricLabels.research,sales:metricLabels.sales,"administration-other":m.adminOther};
  for(const [group,items] of grouped){
   const value=items.reduce((sum,c)=>sum+(numeric(c.amount)??0),0);if(value<0)return {nodes:[],links:[]};if(!value)continue;
   const names=items.map(c=>c.id).sort().join("+");const amount:FlowAmount={value:String(value),basis:"derived",definition:"expense-group:"+names,comparabilityKey:"expense-group:"+names,sourceIds:[...new Set(items.flatMap(c=>c.amount.sourceIds))],formula:items.map(c=>c.name).join(" + "),lineage:items.flatMap(c=>c.amount.lineage??[])};
   const name="expense:"+group;nodes.push({name,label:groupLabels[group]??group,depth:1+offset,expense:true,value,amount});links.push({source:"revenue",target:name,value});
  }
  let negative=0;
  for(const c of q.otherComponents??[]){const signed=numeric(c.amount);if(signed==null)return {nodes:[],links:[]};if(!signed)continue;
   const name="other:"+c.id;nodes.push({name,label:c.name,depth:(signed<0?2:1)+offset,expense:signed<0,value:Math.abs(signed),amount:c.amount});
   if(signed<0){negative-=signed;links.push({source:"operating",target:name,value:-signed});}else links.push({source:name,target:"pretax",value:signed});
  }
  link("operating","pretax",v("operating")!-negative,2);
  if(!afterTaxStage(q,nodes,links,3,offset))return {nodes:[],links:[]};
  const connected=nodes.filter(n=>links.some(l=>l.source===n.name||l.target===n.name));
  return validateGraph(connected,links)?{nodes:connected,links}:{nodes:[],links:[]};
 }

 if(balanced(1) && (v("gross")??-1)>=0 && (v("cost")??-1)>=0){link("revenue","gross",v("gross"),1);link("revenue","cost",v("cost"),1,true);stage=1;}
 if(stage===1 && balanced(2) && (v("operating")??-1)>=0 && (v("operatingExpenses")??-1)>=0){
   link("gross","operating",v("operating"),2);
   if(balanced(5) && !compact && q.expenseComponents?.length){
    for(const component of q.expenseComponents){const value=numeric(component.amount);if(value==null||value<0)return {nodes:[],links:[]};if(!value)continue;const name="expense:"+component.id;nodes.push({name,label:component.name,depth:2+offset,expense:true,value,amount:component.amount});links.push({source:"gross",target:name,value});}
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
 if(stage===3 && balanced(4) && afterTaxStage(q,nodes,links,4,offset))stage=4;

 if(compact && nodes.some(n=>n.name==="research"||n.name==="sales"||n.name==="administration")){
  const small=nodes.filter(n=>n.name==="research"||n.name==="sales"||n.name==="administration");const value=small.reduce((sum,n)=>sum+n.value,0);
  for(const n of small)nodes.splice(nodes.indexOf(n),1);
  for(let i=links.length-1;i>=0;i--)if(small.some(n=>n.name===links[i].target))links.splice(i,1);
  node("operatingExpenses",2,true);links.push({source:"gross",target:"operatingExpenses",value});
 }
 const connected=nodes.filter(n=>links.some(l=>l.source===n.name||l.target===n.name));
 if(!links.length || !validateGraph(connected,links))return {nodes:[],links:[]};
 return {nodes:connected,links};
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
 const unavailable = (): FinancialGraph => ({ nodes: [], links: [], signed: true });
 const checks = reconcileQuarter(q), direct = q.incomeModel === "direct_operating";
 if (!(direct ? [1, 3, 4] : [1, 2, 3, 4]).every(i => checks[i]?.status === "balanced")) return unavailable();
 type Term = { node: SankeyNode; value: number };
 const profit = new Set<FlowMetric>(["gross", "operating", "pretax", "net"]);
 function metric(key: FlowMetric): Term {
  const value = numeric(q.figures[key])!;
  const loss = profit.has(key) && value < 0;
  const expense = ["cost", "operatingExpenses", "tax", "research", "sales", "administration"].includes(key);
  const label = loss ? ({ gross: m.grossLoss, operating: m.operatingLoss, pretax: m.pretaxLoss, net: m.netLoss } as Partial<Record<FlowMetric, string>>)[key]!
   : expense && value < 0 ? key === "tax" ? m.taxBenefit : m.reversal(metricLabels[key]) : metricLabels[key];
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
 const afterTax: Term[] = [];
 for (const c of q.afterTaxComponents ?? []) {
  const value = numeric(c.amount);
  if (value == null) return unavailable();
  if (value) afterTax.push({ value, node: { name: "after-tax:" + c.id, label: c.name, amount: c.amount, depth: 0, value: Math.abs(value), expense: value < 0 } });
 }
 if (!direct) equation([metric("revenue")], [metric("gross"), metric("cost")]);
 equation([metric(direct ? "revenue" : "gross")], [metric("operating"), ...expenses]);
 equation([metric("operating"), ...other], [metric("pretax")]);
 equation([metric("pretax"), ...afterTax], [metric("net"), metric("tax")]);
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
 return { nodes: connected, links, signed: true };
}

/**
 * A loss quarter drawn as funding: revenue and the net loss together pay every cost. Each cost is paid from
 * what is left of revenue (through gross, operating and pretax profit while they are positive); the company's
 * own credits (other income, tax benefits) then cover what revenue could not; the net loss covers the rest,
 * entering at the costs revenue could not reach. Profit nodes carry the reported figures; nothing is estimated.
 */
export function deficitFinancialGraph(q: BusinessFlowQuarter): FinancialGraph | null {
 const figure = (key: FlowMetric) => numeric(q.figures[key]);
 const revenue = figure("revenue"), net = figure("net"), direct = q.incomeModel === "direct_operating";
 if (revenue == null || revenue <= 0 || net == null || net >= 0 || q.incomeModel === "financial" || q.incomeModel === "insurance") return null;
 const checks = reconcileQuarter(q);
 if (!(direct ? [1, 3, 4] : [1, 2, 3, 4]).every(i => checks[i]?.status === "balanced")) return null;
 const tolerance = Math.max(1e-6, revenue * 1e-9);
 type Term = { node: SankeyNode; use: number };
 const metricTerm = (key: FlowMetric, use: number, label: string): Term => ({ use, node: { name: key, label, metric: key, depth: 0, expense: use > 0, credit: use < 0, value: Math.abs(use) } });
 const parts = (kind: "expense" | "other", total: FlowMetric, sign: 1 | -1, fallback: string): Term[] | null => {
  const items = kind === "expense" ? q.expenseComponents : q.otherComponents, value = figure(total);
  if (value == null) return null;
  // A single component that is the whole total adds no detail; the stage name reads better than "(total)".
  if (!items?.length || (items.length === 1 && Math.abs((numeric(items[0].amount) ?? NaN) - value) <= tolerance)) return value ? [metricTerm(total, sign * value, fallback)] : [];
  const values = items.map(c => numeric(c.amount));
  if (values.some(v => v == null) || Math.abs(values.reduce<number>((a, v) => a + v!, 0) - value) > tolerance) return null;
  return items.flatMap((c, i) => values[i] ? [{ use: sign * values[i]!, node: { name: `${kind}:${c.id}`, label: c.name, amount: c.amount, depth: 0, expense: sign * values[i]! > 0, credit: sign * values[i]! < 0, value: Math.abs(values[i]!) } }] : []);
 };
 const other = figure("other"), tax = figure("tax"), cost = figure("cost");
 const expenses = parts("expense", "operatingExpenses", 1, metricLabels.operatingExpenses);
 const others = parts("other", "other", -1, (other ?? 0) < 0 ? m.otherExpense : m.otherIncome);
 const afterTax = (q.afterTaxComponents ?? []).map(c => ({ c, value: numeric(c.amount) }));
 if (afterTax.some(a => a.value == null)) return null;
 // Lines after taxes act like other income: a gain is a credit, a loss a cost.
 const afterTaxTerms: Term[] = afterTax.filter(a => a.value).map(({ c, value }) => ({ use: -value!, node: { name: `after-tax:${c.id}`, label: c.name, amount: c.amount, depth: 0, expense: value! < 0, credit: value! > 0, value: Math.abs(value!) } }));
 if (!expenses || !others || tax == null || (!direct && cost == null)) return null;
 const stages: Array<{ terms: Term[]; after: FlowMetric | null }> = [
  ...(direct ? [] : [{ terms: cost ? [metricTerm("cost", cost, metricLabels.cost)] : [], after: "gross" as const }]),
  { terms: expenses, after: "operating" },
  { terms: others, after: "pretax" },
  { terms: [...(tax ? [metricTerm("tax", tax, tax > 0 ? metricLabels.tax : m.taxBenefit)] : []), ...afterTaxTerms], after: null },
 ];
 const nodes = new Map<string, SankeyNode>(), links: SankeyLink[] = [];
 const flow = (source: string, target: string, value: number) => { if (value > tolerance) links.push({ source, target, value }); };
 nodes.set("revenue", { name: "revenue", label: metricLabels.revenue, metric: "revenue", depth: 0, expense: false, value: revenue });
 let carrier: { name: string; balance: number } | null = { name: "revenue", balance: revenue };
 const carriers = ["revenue"], gaps: Array<{ target: string; amount: number }> = [];
 let credits: Array<{ name: string; amount: number }> = [];
 for (const stage of stages) {
  // The company's own credits first cover what revenue could not reach in earlier stages.
  for (const term of stage.terms.filter(t => t.use < 0)) {
   nodes.set(term.node.name, term.node);
   let amount = -term.use;
   for (const gap of gaps) { const x = Math.min(gap.amount, amount); flow(term.node.name, gap.target, x); gap.amount -= x; amount -= x; }
   credits.push({ name: term.node.name, amount });
  }
  for (const term of stage.terms.filter(t => t.use > 0)) {
   nodes.set(term.node.name, term.node);
   let rest = term.use;
   const paid: number = Math.min(carrier?.balance ?? 0, rest);
   if (carrier && paid > 0) { flow(carrier.name, term.node.name, paid); carrier.balance -= paid; rest -= paid; }
   for (const credit of credits) { const x = Math.min(credit.amount, rest); flow(credit.name, term.node.name, x); credit.amount -= x; rest -= x; }
   if (rest > tolerance) gaps.push({ target: term.node.name, amount: rest });
  }
  const balance: number = (carrier?.balance ?? 0) + credits.reduce((a, c) => a + c.amount, 0);
  if (stage.after && balance > tolerance) {
   const reported = figure(stage.after);
   if (reported == null || Math.abs(reported - balance) > tolerance) return null;
   nodes.set(stage.after, { name: stage.after, label: metricLabels[stage.after], metric: stage.after, depth: 0, expense: false, value: balance });
   if (carrier) flow(carrier.name, stage.after, carrier.balance);
   for (const credit of credits) flow(credit.name, stage.after, credit.amount);
   carrier = { name: stage.after, balance };
   carriers.push(stage.after);
   credits = [];
  } else if (stage.after) carrier = null;
 }
 const deficit = gaps.reduce((a, g) => a + g.amount, 0);
 if ((carrier?.balance ?? 0) > tolerance || credits.some(c => c.amount > tolerance) || Math.abs(deficit + net) > tolerance) return null;
 nodes.set("net", { name: "net", label: m.netLoss, metric: "net", depth: 0, expense: false, loss: true, value: -net });
 for (const gap of gaps) flow("net", gap.target, gap.amount);
 // Depth: profit follows revenue; a cost only the deficit pays sits next to the last profit; sources sit just left of what they fund.
 const list = [...nodes.values()], into = (name: string) => links.filter(l => l.target === name), out = (name: string) => links.filter(l => l.source === name);
 const placed = new Map<string, number>([["revenue", 0]]);
 for (let changed = true; changed;) {
  changed = false;
  for (const l of links) if (placed.has(l.source) && carriers.includes(l.source) && (placed.get(l.target) ?? -1) < placed.get(l.source)! + 1) { placed.set(l.target, placed.get(l.source)! + 1); changed = true; }
 }
 const lastCarrier = Math.max(...carriers.map(c => placed.get(c) ?? 0));
 for (const n of list) if (!placed.has(n.name) && into(n.name).length) placed.set(n.name, lastCarrier + 1);
 // Anything a carrier or credit feeds lies to the right of it.
 for (let changed = true; changed;) {
  changed = false;
  for (const l of links) if (into(l.source).length && placed.get(l.target)! <= placed.get(l.source)!) { placed.set(l.target, placed.get(l.source)! + 1); changed = true; }
 }
 for (const n of list) if (!into(n.name).length && n.name !== "revenue") placed.set(n.name, Math.min(...out(n.name).map(l => placed.get(l.target)!)) - 1);
 for (const n of list) n.depth = placed.get(n.name)!;
 const tree = selectRevenueTree(q);
 if (tree) { const branches: SankeyNode[] = []; appendRevenueTree(q, tree, branches, links, 0); for (const node of branches) list.push(node); }
 const connected = list.filter(n => links.some(l => l.source === n.name || l.target === n.name));
 if (!validateGraph(connected, links)) return null;
 return { nodes: connected, links, deficit: true };
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
  nodes.push({name:nameOf(entry.id),label:entry.name,segmentId:revenueNodeKey(tree,entry.id),depth:revenueDepth-level-(hasAdjustments?1:0),expense:false,value:numeric(entry.revenue)!});
  links.push({source:nameOf(entry.id),target:entry.parentId===null?root:nameOf(entry.parentId),value:numeric(entry.revenue)!});
 }
 if(!hasAdjustments)return;
 const roots=tree.nodes.filter(n=>n.parentId===null),total=roots.reduce((sum,n)=>sum+numeric(n.revenue)!,0);
 const amount:FlowAmount={value:String(total),basis:'derived',definition:'segment-revenue-before-eliminations',comparabilityKey:'segment-total:'+roots.map(n=>n.revenue?.comparabilityKey??'').join('|'),sourceIds:[...new Set(roots.flatMap(n=>n.revenue!.sourceIds))],formula:m.segmentTotalFormula,lineage:roots.flatMap(n=>n.revenue?.lineage??[])};
 nodes.push({name:root,label:m.segmentTotal,amount,value:total,depth:revenueDepth-1,expense:false});
 let negative=0;
 for(const item of adjustments){const value=numeric(item.amount)!;if(!value)continue;
  const name='revenue-adjustment:'+item.id;
  nodes.push({name,label:item.name,amount:item.amount,value:Math.abs(value),depth:revenueDepth-(value>0?1:0),expense:value<0});
  if(value<0){negative-=value;links.push({source:root,target:name,value:-value});}else links.push({source:name,target:'revenue',value});
 }
 if(total-negative>0)links.push({source:root,target:'revenue',value:total-negative});
}
