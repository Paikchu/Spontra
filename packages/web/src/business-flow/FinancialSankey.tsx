"use client";
import { useMemo, useState, type KeyboardEvent } from "react";
import type { BusinessFlowQuarter, FlowMetric } from "@/shared/analysis-contract/business-flow";
import { compareAmount, compareFlowAmounts, formatFlowValue, numeric } from "@/packages/web/src/model/business-flow-model";
import { financialGraph, hasSignedFigures, metricLabels, type FinancialGraph } from "@/packages/web/src/model/business-flow-sankey";
import { compactFlowValue, estimateTextWidth, layoutInfographic, truncateToWidth, type PlacedNode } from "@/packages/web/src/model/business-flow-layout";
import { compareRevenueNode } from "@/packages/web/src/model/revenue-tree";
import { getLocale, messages } from "@/packages/web/src/i18n";
import { qoqLabel, shortPeriod } from "@/shared/analysis-runtime/locale";

const m = messages({
  grossMargin: "Gross margin", operatingMargin: "Operating margin", pretaxMargin: "Pretax margin", netMargin: "Net margin",
  shareBeforeEliminations: "Share of segment revenue before adjustments", share: "Share of revenue", na: "n/a", pp: "pp",
  netIncome: "Net income", flow: "Revenue and profit flow", chart: (period: string, currency: string) => `Revenue to net income, ${period}, ${currency}`,
  revenue: "Revenue", operating: "Operating income", millions: (currency: string) => `${currency} millions · `,
  other: "Other income (expense)", totalExpenses: "Total disclosed expenses", netRevenue: "Net revenue",
  bankBridge: "Bank financial bridge", bridge: "Financial bridge", unit: (currency: string) => ` · ${currency} millions`, component: "Expense component", equals: "equals",
}, {
  grossMargin: "毛利率", operatingMargin: "营业利润率", pretaxMargin: "税前利润率", netMargin: "净利率",
  shareBeforeEliminations: "占调节前分部营收", share: "占营收", na: "不可比", pp: "个百分点",
  netIncome: "净利润", flow: "营收与利润流向", chart: (period: string, currency: string) => `营收至净利润，${period}，${currency}`,
  revenue: "营收", operating: "营业利润", millions: () => "",
  other: "营业外收支", totalExpenses: "已披露总费用", netRevenue: "净营收",
  bankBridge: "银行利润桥", bridge: "利润桥", unit: () => "", component: "费用项目", equals: "等于",
});
const ratioName = (metric: FlowMetric) => ({ gross: m.grossMargin, operating: m.operatingMargin, pretax: m.pretaxMargin, net: m.netMargin } as Partial<Record<FlowMetric, string>>)[metric];

/** The comparison the labels state: YoY against the same quarter a year earlier, QoQ against the quarter before; a caller may pass the word in the page's locale. */
export type ChangeWord = "YoY" | "QoQ";

type NodeText = { name: string; full: string; value: string; detail: string; change: string };

function nodeText(n: PlacedNode, quarter: BusinessFlowQuarter, previous: BusinessFlowQuarter | null, previousGraph: FinancialGraph | null, revenue: number | null, word: string): NodeText {
  const amount = n.amount ? numeric(n.amount) : n.metric ? numeric(quarter.figures[n.metric]) : n.value;
  const comparison = n.amount ? compareFlowAmounts(quarter, previous, n.name, n.amount, previousGraph?.nodes.find(p => p.name === n.name)?.amount)
    : n.metric ? compareAmount(quarter, previous, n.metric)
    : n.segmentId ? compareRevenueNode(quarter, previous, n.segmentId) : null;
  let detail = "";
  if (revenue && n.name !== "revenue") {
    if(n.segmentId&&quarter.revenueAdjustments?.length)revenue=quarter.segments.reduce((sum,s)=>sum+(numeric(s.revenue)??0),0);
    const ratio = (n.tone === "profit" || n.tone === "loss") && n.metric ? ratioName(n.metric) : undefined;
    detail = `${ratio ?? (n.segmentId&&quarter.revenueAdjustments?.length?m.shareBeforeEliminations:m.share)} ${((amount ?? n.value) / revenue * 100).toFixed(1)}%`;
    if (ratio && previous && n.metric && compareAmount(quarter, previous, n.metric).delta != null && compareAmount(quarter, previous, "revenue").delta != null) {
      const before = numeric(previous.figures[n.metric]), base = numeric(previous.figures.revenue);
      if (before != null && base) { const pp = (amount ?? n.value) / revenue * 100 - before / base * 100; detail += ` · ${pp >= 0 ? "+" : "−"}${Math.abs(pp).toFixed(1)}${m.pp}`; }
    }
  }
  const change = !comparison?.comparable ? (n.segmentId || !previous ? "" : `${word} ${m.na}`) : `${word} ${comparison.label}`;
  const full = n.label;
  return { name: truncateToWidth(full, 15), full, value: compactFlowValue(amount, quarter), detail, change };
}

const secondLine = (text: NodeText) => [text.detail, text.change].filter(Boolean).join(" · ");
const valueSize = (n: PlacedNode) => n.name === "net" ? 28 : 22;
/** Width of the two-line label, used by the layout to space columns. */
const labelWidth = (n: PlacedNode, text: NodeText) => Math.max(estimateTextWidth(text.name, 15, true) + 8 + estimateTextWidth(text.value, valueSize(n), true), estimateTextWidth(secondLine(text), 13));

function NodeLabel({ n, text, nodeWidth }: { n: PlacedNode; text: NodeText; nodeWidth: number }) {
  const first = valueSize(n) + 2, height = first + 20;
  const [x, y, anchor]: [number, number, "start" | "middle" | "end"] = n.side === "top" ? [n.x + nodeWidth / 2, n.y - 8 - height, "middle"]
    : n.side === "bottom" ? [n.x + nodeWidth / 2, n.y + n.h + 8, "middle"]
    : n.side === "left" ? [n.x - 12, n.y, "end"]
    : [n.x + nodeWidth + 12, n.y, "start"];
  const second = secondLine(text);
  return <g className="flow-infographic__label" style={{ transform: `translate(${x}px, ${y}px)` }} textAnchor={anchor}>
    <title>{text.full}</title>
    <text y={first}><tspan className="flow-infographic__name">{text.name}</tspan><tspan className="flow-infographic__value" dx={8}>{text.value}</tspan></text>
    {second && <text className="flow-infographic__detail" y={first + 18}>{second}</text>}
  </g>;
}

export function FinancialSankey({quarter,previous,onSegment,word=qoqLabel(getLocale())}:{quarter:BusinessFlowQuarter;previous:BusinessFlowQuarter|null;onSegment:(id:string)=>void;word?:ChangeWord|string}){
 const graph=useMemo(()=>financialGraph(quarter),[quarter]);
 const previousGraph=useMemo(()=>previous?financialGraph(previous):null,[previous]);
 const layout=useMemo(()=>{const revenue=graph.nodes.find(n=>n.name==="revenue")?.value??null;return layoutInfographic(graph,n=>labelWidth(n,nodeText(n,quarter,previous,previousGraph,revenue,word)));},[graph,quarter,previous,previousGraph,word]);
 const [active,setActive]=useState<string|null>(null);
 if((hasSignedFigures(quarter) && !layout)||quarter.incomeModel==="insurance"||(quarter.incomeModel==="financial"&&!layout))return <SignedFinancialBridge quarter={quarter} previous={previous} word={word}/>;
 const revenue=graph.nodes.find(n=>n.name==="revenue")?.value??null;
 const adjacent=new Set(active?[active,...graph.links.filter(l=>l.source===active||l.target===active).flatMap(l=>[l.source,l.target])]:[]);
 const activate=(n:PlacedNode)=>n.segmentId?{role:"button",tabIndex:0,"aria-label":n.label,onClick:()=>onSegment(n.segmentId!),onKeyDown:(e:KeyboardEvent)=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onSegment(n.segmentId!);}},onFocus:()=>setActive(n.name),onBlur:()=>setActive(null)}:{};
 return <>{!graph.nodes.some(n=>n.name==="net")&&<div className="business-flow__independent-net" data-loss={(numeric(quarter.figures.net)??0)<0||undefined}><span>{m.netIncome}</span><strong>{formatFlowValue(numeric(quarter.figures.net),quarter)}</strong><span>{word} {compareAmount(quarter,previous,"net").label}</span></div>}{layout?<><div className="business-flow__chart-scroll" tabIndex={0} role="region" aria-label={m.flow}>
  <svg className="flow-infographic" viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} style={{minWidth:Math.round(layout.width*0.72)}} role="group" aria-label={m.chart(getLocale()==="en"?quarter.label:shortPeriod(quarter.periodEnd), quarter.currency)} data-active={active?"":undefined} onMouseLeave={()=>setActive(null)}>
   <g>{layout.links.map(l=><path key={l.source+">"+l.target} className="flow-infographic__band" data-tone={l.tone} data-on={active?(l.source===active||l.target===active)||undefined:undefined} d={l.d}><title>{`${graph.nodes.find(n=>n.name===l.source)?.label} → ${graph.nodes.find(n=>n.name===l.target)?.label} · ${compactFlowValue(l.value,quarter)}`}</title></path>)}</g>
   <g>{layout.nodes.map(n=><g key={n.name} className="flow-infographic__node" data-tone={n.tone} data-net={n.name==="net"||undefined} data-segment={n.segmentId?"":undefined} data-on={active?adjacent.has(n.name)||undefined:undefined} onMouseEnter={()=>setActive(n.name)} {...activate(n)}>
    <path className="flow-infographic__bar" d={`M${n.x},${n.y}h${layout.nodeWidth}v${n.h}h${-layout.nodeWidth}Z`}/>
    <NodeLabel n={n} nodeWidth={layout.nodeWidth} text={nodeText(n,quarter,previous,previousGraph,revenue,word)}/>
   </g>)}</g>
  </svg></div></>:<div><div className="business-flow__available-metrics">{([["revenue", m.revenue], ["operating", m.operating]] as const).map(([metric,label]) => <div key={metric}><span>{label}</span><strong>{formatFlowValue(numeric(quarter.figures[metric]),quarter)}</strong><small>{m.millions(quarter.currency)}{word} {compareAmount(quarter,previous,metric).label}</small></div>)}</div></div>}<p className="business-flow__mobile-other">{m.other} {(numeric(quarter.figures.other)??0)>0?"+":""}{formatFlowValue(numeric(quarter.figures.other),quarter)} · {word} {compareAmount(quarter,previous,"other").label}</p></>;
}

/** Constant geometry displays accounting relationships; negative amounts retain their signs. */
function SignedFinancialBridge({quarter,previous,word}:{quarter:BusinessFlowQuarter;previous:BusinessFlowQuarter|null;word:string}){
 const financial=quarter.incomeModel==="financial"||quarter.incomeModel==="insurance";
 const equations:Array<[FlowMetric,"−"|"+",FlowMetric,FlowMetric]>=financial
  ?[["revenue","−","operatingExpenses","pretax"],["pretax","−","tax","net"]]
  :quarter.incomeModel==="direct_operating"
  ?[["revenue","−","operatingExpenses","operating"],["operating","+","other","pretax"],["pretax","−","tax","net"]]
  :[["revenue","−","cost","gross"],["gross","−","operatingExpenses","operating"],["operating","+","other","pretax"],["pretax","−","tax","net"]];
 const metric=(key:FlowMetric)=><div className="business-flow__signed-amount" data-loss={(numeric(quarter.figures[key])??0)<0||undefined}><span>{financial&&key==="operatingExpenses"?m.totalExpenses:quarter.incomeModel==="financial"&&key==="revenue"?m.netRevenue:metricLabels[key]}</span><strong>{formatFlowValue(numeric(quarter.figures[key]),quarter)}</strong><small>{word} {compareAmount(quarter,previous,key).label}</small></div>;
 return <div className="business-flow__signed-bridge" role="figure" aria-label={quarter.incomeModel==="financial"?m.bankBridge:m.bridge}>
  <p className="business-flow__signed-explanation">{quarter.incomeModel==="financial"?m.bankBridge:m.bridge}{m.unit(quarter.currency)}</p>
  {quarter.incomeModel==="financial"&&<div className="business-flow__signed-expenses">{quarter.expenseComponents?.map(component=><div className="business-flow__signed-amount" key={component.id}><span>{component.name}</span><strong>{formatFlowValue(numeric(component.amount),quarter)}</strong><small>{m.component}</small></div>)}</div>}
  {quarter.incomeModel==="insurance"&&<div className="business-flow__signed-equation business-flow__signed-equation--insurance">{metric("revenue")}<span>−</span>{metric("operatingExpenses")}<span>+</span>{metric("other")}<span>→</span>{metric("pretax")}</div>}
  {equations.filter((_,i)=>quarter.incomeModel!=="insurance"||i>0).map(([left,operator,right,result])=><div className="business-flow__signed-equation" key={result}>{metric(left)}<span className="business-flow__signed-operator">{operator}</span>{metric(right)}<span className="business-flow__signed-operator" aria-label={m.equals}>→</span>{metric(result)}</div>)}
 </div>;
}
