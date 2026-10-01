"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { init, use as registerCharts } from "echarts/core";
import { SankeyChart } from "echarts/charts";
import { TooltipComponent, AriaComponent } from "echarts/components";
import { LabelLayout } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";
import type { BusinessFlowQuarter, FlowMetric } from "@/shared/analysis-contract/business-flow";
import { compareAmount, compareFlowAmounts, formatFlowValue, numeric } from "@/lib/earning-report/web/business-flow-model";
import { financialGraph, metricLabels } from "@/lib/earning-report/web/business-flow-sankey";
registerCharts([SankeyChart,TooltipComponent,AriaComponent,SVGRenderer,LabelLayout]);

export function FinancialSankey({quarter,previous,onSegment}:{quarter:BusinessFlowQuarter;previous:BusinessFlowQuarter|null;onSegment:(id:string)=>void}){
 const container=useRef<HTMLDivElement>(null);
 const [error,setError]=useState<string|null>(null);
 const graph=useMemo(()=>financialGraph(quarter),[quarter]);
 useEffect(()=>{
  const element=container.current;if(!element || !graph.links.length)return;
  let chart:ReturnType<typeof init>|undefined;
  let vertical=false;
  const render=()=>{
   if(element.clientWidth===0 || element.clientHeight===0)return;
   try{
    const nextVertical=element.clientWidth<620;
    if(chart && vertical!==nextVertical){chart.dispose();chart=undefined;}
    vertical=nextVertical;
    if(!chart){
     const activeGraph=vertical?financialGraph(quarter,true):graph;
     const css=getComputedStyle(element);
     const token=(name:string,fallback:string)=>css.getPropertyValue(name).trim()||fallback;
     chart=init(element,undefined,{renderer:"svg"});
     chart.setOption({animation:false,aria:{enabled:true},tooltip:{trigger:"item",confine:true,renderMode:"richText",formatter:(params:{name?:string;value?:unknown})=>{const node=activeGraph.nodes.find(n=>n.name===params.name);return node?node.label+" · "+formatFlowValue(node.metric?numeric(quarter.figures[node.metric]):node.value,quarter)+" "+quarter.currency+" 百万":"已披露流量 · "+formatFlowValue(typeof params.value==="number"?params.value:null,quarter)+" "+quarter.currency+" 百万";}},series:[{
      type:"sankey",orient:vertical?"vertical":"horizontal",left:vertical?12:90,right:vertical?135:60,top:76,bottom:96,nodeWidth:10,nodeGap:quarter.incomeModel==="direct_operating"?44:54,nodeAlign:"left",layoutIterations:0,draggable:false,
      emphasis:{focus:"adjacency"},labelLayout:vertical?undefined:{hideOverlap:true},
      label:{color:token("--foreground","#e5eee9"),fontFamily:token("--sans","sans-serif"),fontSize:13,lineHeight:19,position:"top",distance:9},
      lineStyle:{color:"source",opacity:.32,curveness:.5},
      data:activeGraph.nodes.map(n=>{
       const value=n.amount?formatFlowValue(numeric(n.amount),quarter):n.metric?formatFlowValue(Number(quarter.figures[n.metric]?.value),quarter):formatFlowValue(n.value,quarter);
       const previousNode=previous?financialGraph(previous,vertical).nodes.find(p=>p.name===n.name):undefined;
       const comparison=n.amount?compareFlowAmounts(quarter,previous,n.name,n.amount,previousNode?.amount):n.metric?compareAmount(quarter,previous,n.metric):compareAmount(quarter,previous,"revenue",n.segmentId);
       return {name:n.name,value:n.value,depth:n.depth,itemStyle:{color:token(n.expense?"--chart-3":n.name==="net"?"--sp-accent":n.segmentId?"--chart-1":"--chart-2","#a3bd75")},label:{show:!vertical||n.name!=="other",position:vertical?(n.expense||n.name==="other"?"bottom":"right"):n.name.startsWith("other:")?(n.expense?"top":"bottom"):(n.expense||n.name==="other")?"bottom":"top",distance:vertical&&(n.expense||n.name==="other")?24:9,align:vertical&&n.expense?"left":undefined,width:vertical?105:150,overflow:"truncate",formatter:n.label+"\n"+value+" · "+comparison.label}};
      }),links:activeGraph.links,
     }]});
     setError(null);
     chart.on("click",params=>{if(params.dataType==="node"){const n=graph.nodes.find(n=>n.name===params.name);if(n?.segmentId)onSegment(n.segmentId);}});
    }else chart.resize();
   }catch{chart?.dispose();chart=undefined;setError("图表暂时无法绘制，原披露明细与业务介绍仍可查看。");}
  };
  const observer=new ResizeObserver(render);observer.observe(element);
  const theme=new MutationObserver(()=>{chart?.dispose();chart=undefined;render();});theme.observe(document.documentElement,{attributes:true,attributeFilter:["class","data-theme"]});
  render();
  return ()=>{observer.disconnect();theme.disconnect();chart?.dispose();};
 // The node event is rebuilt on quarter changes; React owns disclosure panels.
 },[quarter,previous,onSegment,graph]);
 const signed = Object.entries(quarter.figures).some(([key,amount])=>key!=="other" && (numeric(amount)??0)<0) || (quarter.expenseComponents??[]).some(c=>(numeric(c.amount)??0)<0);
 if(signed)return <SignedFinancialBridge quarter={quarter} previous={previous}/>;
 return <>{!graph.nodes.some(n=>n.name==="net")&&<div className="business-flow__independent-net" data-loss={(numeric(quarter.figures.net)??0)<0||undefined}><span>净利润 · 独立披露，完整流向待补齐</span><strong>{formatFlowValue(numeric(quarter.figures.net),quarter)}</strong><span>环比 {compareAmount(quarter,previous,"net").label}</span></div>}{graph.notice&&<p className="business-flow__notice">{graph.notice}</p>}{graph.links.length?<div ref={container} className="business-flow__chart" role="img" aria-label="收入到净利润桑基图；下方提供金额明细及业务展开按钮" />:<div><p className="business-flow__notice">当前披露缺少已对平的中间阶段，暂不绘制比例流带。金融与保险采用不同利润表口径，不强行推定成本与毛利。</p><div className="business-flow__available-metrics">{([["revenue", "收入"], ["operating", "营业利润"]] as const).map(([metric,label]) => <div key={metric}><span>{label}</span><strong>{formatFlowValue(numeric(quarter.figures[metric]),quarter)}</strong><small>{quarter.currency} 百万 · 环比 {compareAmount(quarter,previous,metric).label}</small></div>)}</div></div>}<p className="business-flow__mobile-other">其他损益（有符号）：{(numeric(quarter.figures.other)??0)>0?"+":""}{formatFlowValue(numeric(quarter.figures.other),quarter)} · 环比 {compareAmount(quarter,previous,"other").label}。正值额外流入，负值分流；费用分项见财务明细。</p>{error&&<p role="status">{error}</p>}</>;
}

/** Constant geometry displays accounting relationships; negative amounts retain their signs. */
function SignedFinancialBridge({quarter,previous}:{quarter:BusinessFlowQuarter;previous:BusinessFlowQuarter|null}){
 const financial=quarter.incomeModel==="financial"||quarter.incomeModel==="insurance";
 const equations:Array<[FlowMetric,"−"|"+",FlowMetric,FlowMetric]>=financial
  ?[["revenue","−","operatingExpenses","pretax"],["pretax","−","tax","net"]]
  :quarter.incomeModel==="direct_operating"
  ?[["revenue","−","operatingExpenses","operating"],["operating","+","other","pretax"],["pretax","−","tax","net"]]
  :[["revenue","−","cost","gross"],["gross","−","operatingExpenses","operating"],["operating","+","other","pretax"],["pretax","−","tax","net"]];
 const metric=(key:FlowMetric)=><div className="business-flow__signed-amount" data-loss={(numeric(quarter.figures[key])??0)<0||undefined}><span>{metricLabels[key]}</span><strong>{formatFlowValue(numeric(quarter.figures[key]),quarter)}</strong><small>环比 {compareAmount(quarter,previous,key).label}</small></div>;
 return <div className="business-flow__signed-bridge" role="figure" aria-label="完整有符号财务桥图，金额保持财报正负号">
  <p className="business-flow__notice">财务桥图 · {quarter.currency} 百万。框和箭头表示对账关系，宽度不表示金额比例；亏损、税收收益及费用冲回保留原披露正负号。</p>
  {equations.map(([left,operator,right,result])=><div className="business-flow__signed-equation" key={result}>{metric(left)}<span className="business-flow__signed-operator">{operator}</span>{metric(right)}<span className="business-flow__signed-operator" aria-label="等于">→</span>{metric(result)}</div>)}
 </div>;
}
