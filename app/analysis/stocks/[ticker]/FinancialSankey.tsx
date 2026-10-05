"use client";
import { useMemo, useState, type KeyboardEvent } from "react";
import type { BusinessFlowQuarter, FlowMetric } from "@/shared/analysis-contract/business-flow";
import { compareAmount, compareFlowAmounts, formatFlowValue, numeric } from "@/lib/earning-report/web/business-flow-model";
import { financialGraph, hasSignedFigures, metricLabels, type FinancialGraph } from "@/lib/earning-report/web/business-flow-sankey";
import { compactFlowValue, estimateTextWidth, layoutInfographic, type PlacedNode } from "@/lib/earning-report/web/business-flow-layout";
import { compareRevenueNode } from "@/lib/earning-report/web/revenue-tree";

const ratioNames: Partial<Record<FlowMetric, string>> = { gross: "毛利率", operating: "营业利润率", pretax: "税前利润率", net: "净利率" };

type NodeText = { name: string; full: string; value: string; detail: string; change: string };

function nodeText(n: PlacedNode, quarter: BusinessFlowQuarter, previous: BusinessFlowQuarter | null, previousGraph: FinancialGraph | null, revenue: number | null): NodeText {
  const amount = n.amount ? numeric(n.amount) : n.metric ? numeric(quarter.figures[n.metric]) : n.value;
  const comparison = n.amount ? compareFlowAmounts(quarter, previous, n.name, n.amount, previousGraph?.nodes.find(p => p.name === n.name)?.amount)
    : n.metric ? compareAmount(quarter, previous, n.metric)
    : n.segmentId ? compareRevenueNode(quarter, previous, n.segmentId) : { label: "不可比" };
  let detail = "";
  if (revenue && n.name !== "revenue") {
    if(n.segmentId&&quarter.revenueAdjustments?.length)revenue=quarter.segments.reduce((sum,s)=>sum+(numeric(s.revenue)??0),0);
    const ratioName = (n.tone === "profit" || n.tone === "loss") && n.metric ? ratioNames[n.metric] : undefined;
    detail = `${ratioName ?? (n.segmentId&&quarter.revenueAdjustments?.length?"占抵销前收入":"占收入")} ${((amount ?? n.value) / revenue * 100).toFixed(1)}%`;
    if (ratioName && previous && n.metric && compareAmount(quarter, previous, n.metric).delta != null && compareAmount(quarter, previous, "revenue").delta != null) {
      const before = numeric(previous.figures[n.metric]), base = numeric(previous.figures.revenue);
      if (before != null && base) { const pp = (amount ?? n.value) / revenue * 100 - before / base * 100; detail += ` · ${pp >= 0 ? "+" : "−"}${Math.abs(pp).toFixed(1)}pp`; }
    }
  }
  const change = comparison.label === "不可比" ? (n.segmentId || !previous ? "" : "环比不可比") : `环比 ${comparison.label}`;
  const full = n.label;
  return { name: full.length > 12 ? full.slice(0, 11) + "…" : full, full, value: compactFlowValue(amount, quarter), detail, change };
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

export function FinancialSankey({quarter,previous,onSegment}:{quarter:BusinessFlowQuarter;previous:BusinessFlowQuarter|null;onSegment:(id:string)=>void}){
 const graph=useMemo(()=>financialGraph(quarter),[quarter]);
 const previousGraph=useMemo(()=>previous?financialGraph(previous):null,[previous]);
 const layout=useMemo(()=>{const revenue=graph.nodes.find(n=>n.name==="revenue")?.value??null;return layoutInfographic(graph,n=>labelWidth(n,nodeText(n,quarter,previous,previousGraph,revenue)));},[graph,quarter,previous,previousGraph]);
 const [active,setActive]=useState<string|null>(null);
 if((hasSignedFigures(quarter) && !layout)||quarter.incomeModel==="insurance"||quarter.incomeModel==="financial")return <SignedFinancialBridge quarter={quarter} previous={previous}/>;
 const revenue=graph.nodes.find(n=>n.name==="revenue")?.value??null;
 const adjacent=new Set(active?[active,...graph.links.filter(l=>l.source===active||l.target===active).flatMap(l=>[l.source,l.target])]:[]);
 const activate=(n:PlacedNode)=>n.segmentId?{role:"button",tabIndex:0,"aria-label":`${n.label}，展开业务介绍`,onClick:()=>onSegment(n.segmentId!),onKeyDown:(e:KeyboardEvent)=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onSegment(n.segmentId!);}},onFocus:()=>setActive(n.name),onBlur:()=>setActive(null)}:{};
 return <>{!graph.nodes.some(n=>n.name==="net")&&<div className="business-flow__independent-net" data-loss={(numeric(quarter.figures.net)??0)<0||undefined}><span>净利润 · 独立披露，完整流向待补齐</span><strong>{formatFlowValue(numeric(quarter.figures.net),quarter)}</strong><span>环比 {compareAmount(quarter,previous,"net").label}</span></div>}{graph.notice&&<p className="business-flow__notice">{graph.notice}</p>}{layout?<><p className="business-flow__scroll-hint">左右滑动查看完整流向</p><div className="business-flow__chart-scroll" tabIndex={0} role="region" aria-label="完整收入与利润流向，可横向滚动">
  <svg className="flow-infographic" viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} style={{minWidth:Math.round(layout.width*0.72)}} role="group" aria-label={`收入到净利润桑基图，${quarter.label}，金额单位 ${quarter.currency}；下方提供金额明细及业务展开按钮`} data-active={active?"":undefined} onMouseLeave={()=>setActive(null)}>
   <g>{layout.links.map(l=><path key={l.source+">"+l.target} className="flow-infographic__band" data-tone={l.tone} data-on={active?(l.source===active||l.target===active)||undefined:undefined} d={l.d}><title>{`${graph.nodes.find(n=>n.name===l.source)?.label} → ${graph.nodes.find(n=>n.name===l.target)?.label} · ${compactFlowValue(l.value,quarter)}`}</title></path>)}</g>
   <g>{layout.nodes.map(n=><g key={n.name} className="flow-infographic__node" data-tone={n.tone} data-net={n.name==="net"||undefined} data-segment={n.segmentId?"":undefined} data-on={active?adjacent.has(n.name)||undefined:undefined} onMouseEnter={()=>setActive(n.name)} {...activate(n)}>
    <path className="flow-infographic__bar" d={`M${n.x},${n.y}h${layout.nodeWidth}v${n.h}h${-layout.nodeWidth}Z`}/>
    <NodeLabel n={n} nodeWidth={layout.nodeWidth} text={nodeText(n,quarter,previous,previousGraph,revenue)}/>
   </g>)}</g>
  </svg></div><p className="flow-infographic__caption">{graph.signed ? "利润或亏损向右结转 · 宽度表示金额绝对值" : "利润向上流、成本向下流 · 宽度表示本季金额"} · 精确数值（{quarter.currency} 百万）见下方明细</p></>:<div><p className="business-flow__notice">当前披露缺少已对平的中间阶段，暂不绘制比例流带。金融与保险采用不同利润表口径，不强行推定成本与毛利。</p><div className="business-flow__available-metrics">{([["revenue", "收入"], ["operating", "营业利润"]] as const).map(([metric,label]) => <div key={metric}><span>{label}</span><strong>{formatFlowValue(numeric(quarter.figures[metric]),quarter)}</strong><small>{quarter.currency} 百万 · 环比 {compareAmount(quarter,previous,metric).label}</small></div>)}</div></div>}<p className="business-flow__mobile-other">其他损益（有符号）：{(numeric(quarter.figures.other)??0)>0?"+":""}{formatFlowValue(numeric(quarter.figures.other),quarter)} · 环比 {compareAmount(quarter,previous,"other").label}。正值额外流入，负值分流；费用分项见财务明细。</p></>;
}

/** Constant geometry displays accounting relationships; negative amounts retain their signs. */
function SignedFinancialBridge({quarter,previous}:{quarter:BusinessFlowQuarter;previous:BusinessFlowQuarter|null}){
 const financial=quarter.incomeModel==="financial"||quarter.incomeModel==="insurance";
 const equations:Array<[FlowMetric,"−"|"+",FlowMetric,FlowMetric]>=financial
  ?[["revenue","−","operatingExpenses","pretax"],["pretax","−","tax","net"]]
  :quarter.incomeModel==="direct_operating"
  ?[["revenue","−","operatingExpenses","operating"],["operating","+","other","pretax"],["pretax","−","tax","net"]]
  :[["revenue","−","cost","gross"],["gross","−","operatingExpenses","operating"],["operating","+","other","pretax"],["pretax","−","tax","net"]];
 const metric=(key:FlowMetric)=><div className="business-flow__signed-amount" data-loss={(numeric(quarter.figures[key])??0)<0||undefined}><span>{financial&&key==="operatingExpenses"?"已披露费用合计":quarter.incomeModel==="financial"&&key==="revenue"?"财报净收入":metricLabels[key]}</span><strong>{formatFlowValue(numeric(quarter.figures[key]),quarter)}</strong><small>环比 {compareAmount(quarter,previous,key).label}</small></div>;
 return <div className="business-flow__signed-bridge" role="figure" aria-label={quarter.incomeModel==="financial"?"完整银行财务桥图，净收入至净利润":"完整有符号财务桥图，金额保持财报正负号"}>
  <p className="business-flow__signed-explanation">{quarter.incomeModel==="financial"?"银行财务桥图":"财务桥图"} · {quarter.currency} 百万。{quarter.incomeModel==="insurance"?"净利润含少数股东权益；投资与权益法损益单列。":quarter.incomeModel==="financial"?"净收入已扣除利息费用；实际费用分类如下，不推定毛利。":""}框和箭头表示对账关系，宽度不表示金额比例；亏损、税收收益及费用冲回保留原披露正负号。</p>
  {quarter.incomeModel==="financial"&&<div className="business-flow__signed-expenses">{quarter.expenseComponents?.map(component=><div className="business-flow__signed-amount" key={component.id}><span>{component.name}</span><strong>{formatFlowValue(numeric(component.amount),quarter)}</strong><small>费用合计的实际披露分项</small></div>)}</div>}
  {quarter.incomeModel==="insurance"&&<div className="business-flow__signed-equation business-flow__signed-equation--insurance">{metric("revenue")}<span>−</span>{metric("operatingExpenses")}<span>+</span>{metric("other")}<span>→</span>{metric("pretax")}</div>}
  {equations.filter((_,i)=>quarter.incomeModel!=="insurance"||i>0).map(([left,operator,right,result])=><div className="business-flow__signed-equation" key={result}>{metric(left)}<span className="business-flow__signed-operator">{operator}</span>{metric(right)}<span className="business-flow__signed-operator" aria-label="等于">→</span>{metric(result)}</div>)}
 </div>;
}
