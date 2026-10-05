import { selectRevenueTree, compareRevenueNode, revenueNodeKey } from "../lib/earning-report/web/revenue-tree";
import { enrichDisclosedRevenue } from "../lib/earning-report/web/company-revenue-disclosures";
import type { RevenueBreakdown } from "../shared/analysis-contract/business-flow";
import { readFileSync } from "node:fs";
import { extractDisclosedQuarters } from "../workers/pipeline/src/financial-data/parser";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BusinessFlow } from "../app/analysis/stocks/[ticker]/BusinessFlow";
import { adaptFundamentals, segmentChangeLabel, compareAmount, marginChange, numeric, previousQuarter, reconcileQuarter, selectFlow } from "../lib/earning-report/web/business-flow-model";
import { businessFlowFixture } from "./fixtures/business-flow-fixture";
import { financialGraph, validateGraph } from "../lib/earning-report/web/business-flow-sankey";
import type { PublicFundamentalsResponse } from "../shared/analysis-contract/fundamentals";

const [q4, q3] = businessFlowFixture.quarters;
test("verified FY26 example balances every equation and retains the original disclosure basis", () => {
  assert.ok(reconcileQuarter(q4).every(r => r.status === "balanced"));
  assert.ok(reconcileQuarter(q3).every(r => r.status === "balanced"));
  assert.equal(compareAmount(q4, q3, "revenue").delta, 7121);
  assert.equal(compareAmount(q4, q3, "revenue").label, "+8.6%");
  assert.match(marginChange(q4, q3, "net"), /个百分点/);
});
test("missing and inconsistent disclosures never reconcile as complete", () => {
  const missing = structuredClone(q4); delete missing.figures.tax;
  assert.equal(reconcileQuarter(missing).find(r => r.label.includes("所得税"))?.status, "missing");
  const broken = structuredClone(q4); broken.figures.revenue!.value = "90000";
  assert.equal(reconcileQuarter(broken)[0].status, "mismatch");
  assert.ok(reconcileQuarter(broken).some(r => r.status === "mismatch"));
  const noRevenue = structuredClone(q4); delete noRevenue.figures.revenue;
  assert.equal(reconcileQuarter(noRevenue)[0].status, "missing");
});
test("comparison rejects zero denominators, unknown revision bases, currency changes and nonadjacent quarters", () => {
  const previous = structuredClone(q3); previous.figures.net!.value = "0";
  assert.equal(compareAmount(q4, previous, "net").percent, null);
  assert.equal(compareAmount(q4, previous, "net").label, "上季为零");
  previous.figures.net!.value = "-1";
  assert.equal(compareAmount(q4, previous, "net").label, "转盈");
  const loss = structuredClone(q4); loss.figures.net!.value = "-100";
  assert.equal(compareAmount(loss, q3, "net").label, "转亏");
  previous.figures.net!.comparabilityKey = null;
  assert.equal(compareAmount(q4, previous, "net").label, "不可比");
  assert.equal(compareAmount(q4, { ...q3, currency: "EUR" }, "revenue").label, "不可比");
  assert.equal(previousQuarter(q4, [{ ...q3, periodEnd: "2025-12-31" }]), null);
  assert.equal(numeric({ ...q4.figures.net!, value: "NaN" }), null);
});
test("loss Sankey preserves signed labels and distinguishes deficits from revenue", () => {
  const loss = structuredClone(q4);
  loss.figures.other!.value = "-50000"; loss.figures.pretax!.value = "-9397"; loss.figures.net!.value = "-17678";
  assert.ok(reconcileQuarter(loss).every(r => r.status === "balanced"));
  const html = renderToStaticMarkup(<BusinessFlow flow={{ ...businessFlowFixture, quarters: [loss] }} />);
  assert.match(html, /-17,678/); assert.match(html, /data-tone="negative"/); assert.match(html, /财务金额明细/); assert.match(html, /收入到净利润桑基图/); assert.match(html, /净亏损/); assert.match(html, /利润或亏损向右结转/);
  const graph = financialGraph(loss); assert.ok(validateGraph(graph.nodes, graph.links));
  assert.equal(graph.nodes.find(n => n.name === "net")?.value, 17678);
  const stages = ["revenue", "gross", "operating", "pretax", "net"].map(name => graph.nodes.find(n => n.name === name)!);
  assert.ok(stages.every((node, i) => i === 0 || node.depth > stages[i - 1].depth));
  assert.equal(graph.links.filter(l => l.target === "net").reduce((sum, l) => sum + l.value, 0), 17678);
});
test("real fundamentals adapter preserves source, missing details and conservative comparability", () => {
  const data = { ticker: "OTHER", source: "sec_xbrl", catalogVersion: "fundamental-metrics.v2", fetchedAt: null, periods: [{ periodEnd: "2026-06-30", periodType: "3M", currency: "USD" }], series: ["total_revenue", "gross_profit", "operating_income", "net_income"].map((key, i) => ({ metricKey: key, unitFamily: "currency", currency: "USD", unit: "USD", basis: "reported", points: [{ periodEnd: "2026-06-30", valueDecimal: String([100, 70, 40, 25][i]), revision: null, sourceAccession: "0000789019-26-000001" }] })) } as PublicFundamentalsResponse;
  const flow = adaptFundamentals(data, "OTHER");
  assert.equal(numeric(flow.quarters[0].figures.cost), 30);
  assert.equal(numeric(flow.quarters[0].figures.operatingExpenses), 30);
  assert.equal(numeric(flow.quarters[0].figures.tax), null);
  assert.equal(flow.quarters[0].segments.length, 0);
  assert.equal(selectFlow(businessFlowFixture, data, "OTHER").ticker, "OTHER");
  assert.equal(adaptFundamentals(data, "MSFT").quarters.length, 0);
});
test("graph exposes quarter controls, all endpoints, sources and honest empty states", () => {
  const html = renderToStaticMarkup(<BusinessFlow flow={businessFlowFixture} />);
  for (const label of ["业务前瞻", "收入", "营业成本", "毛利", "营业利润", "其他损益", "税前利润", "所得税", "净利润", "展开比较", "会计核对", "FY26 原披露"]) assert.ok(html.includes(label), label);
  assert.match(html, /aria-expanded="false"/); assert.match(html, /aria-controls=/);
  assert.match(html, /90,007/); assert.ok(!html.includes("我的持仓"));
  const missing = renderToStaticMarkup(<BusinessFlow flow={{ ...businessFlowFixture, quarters: [] }} />);
  assert.match(missing, /不会用示例数据/);
});

test("Sankey validates finite nonnegative edges, conservation, IDs and acyclic topology",()=>{
 const graph=financialGraph(q4);assert.equal(validateGraph(graph.nodes,graph.links),true);
 assert.ok(graph.nodes.some(n=>n.name==="net"));
 assert.ok(graph.nodes.some(n=>n.name==="research"));
 assert.ok(graph.links.every(l=>l.value>0));
 assert.equal(validateGraph([...graph.nodes,graph.nodes[0]],graph.links),false);
 assert.equal(validateGraph(graph.nodes,[...graph.links,{source:"net",target:"revenue",value:1}]),false);
 assert.equal(validateGraph(graph.nodes,[...graph.links,{source:"missing",target:"net",value:1}]),false);
 assert.equal(validateGraph(graph.nodes,[{source:"revenue",target:"net",value:NaN}]),false);
 assert.equal(validateGraph(graph.nodes,[{source:"revenue",target:"net",value:-1}]),false);
 const altered=structuredClone(graph.links);altered[0].value+=100;assert.equal(validateGraph(graph.nodes,altered),false);
});
test("multiple companies, variable segment counts, no COGS industries and incomplete disclosures are safe",()=>{
 for(const count of [0,1,2,8,40]){
  const quarter=structuredClone(q4);quarter.segments=Array.from({length:count},(_,i)=>({...q4.segments[0],id:"segment-"+i,name:"长业务名称公司部门"+i,revenue:{...q4.segments[0].revenue!,value:String(90007/count)}}));quarter.segmentsComplete=count>0;
  const graph=financialGraph(quarter);assert.ok(graph.links.length>0);assert.equal(validateGraph(graph.nodes,graph.links),true);
 }
 for(const incomeModel of ["financial","insurance"] as const){const quarter={...q4,incomeModel};const graph=financialGraph(quarter);assert.equal(graph.links.length,0);assert.match(graph.notice!,/金融与保险/);}
 const partial=structuredClone(q4);delete partial.figures.tax;assert.ok(financialGraph(partial).nodes.some(n=>n.name==="pretax"));assert.ok(!financialGraph(partial).nodes.some(n=>n.name==="net"));
 const zero=structuredClone(q4);zero.figures.revenue!.value="0";assert.equal(financialGraph(zero).links.length,0);
 const loss=structuredClone(q4);loss.figures.other!.value="-50000";loss.figures.pretax!.value="-9397";loss.figures.net!.value="-17678";assert.ok(financialGraph(loss).links.every(l=>l.value>0));assert.ok(financialGraph(loss).nodes.some(n=>n.name==="net" && n.loss));
 const negativeOther=structuredClone(q4);negativeOther.figures.other!.value="-100";negativeOther.figures.pretax!.value="40503";negativeOther.figures.net!.value="32222";const negativeGraph=financialGraph(negativeOther);assert.equal(validateGraph(negativeGraph.nodes,negativeGraph.links),true);assert.ok(negativeGraph.links.some(l=>l.source==="operating"&&l.target==="other"&&l.value===100));
});
test("published malformed payloads and duplicate periods fall back without crashing",()=>{
 const malformed=structuredClone(businessFlowFixture);malformed.quarters[0].scale=NaN;assert.equal(selectFlow(malformed,null,"MSFT").quarters.length,0);
 const duplicate=structuredClone(businessFlowFixture);duplicate.quarters.push(duplicate.quarters[0]);assert.equal(selectFlow(duplicate,null,"MSFT").quarters.length,0);
});

test("mobile keeps revenue detail while grouping only expense totals",()=>{
 const graph=financialGraph(q4,true);assert.equal(validateGraph(graph.nodes,graph.links),true);assert.ok(graph.nodes.some(n=>n.name==="operatingExpenses"));assert.ok(graph.nodes.some(n=>n.name==="net"));assert.equal(graph.nodes.filter(n=>n.segmentId).length,3);assert.deepEqual(graph.nodes.filter(n=>n.segmentId),financialGraph(q4).nodes.filter(n=>n.segmentId));
});


test("real sourced business remains visible without quarterly revenue and never leaks across tickers", async () => {
 const { resolveCompanyBusiness } = await import("../lib/earning-report/web/company-business-content");
 const nvda = resolveCompanyBusiness("NVDA");
 assert.equal(nvda?.groups.length, 2);
 assert.ok(nvda?.groups.every(group => group.revenue === null));
 assert.ok(nvda?.sources.every(source => source.url.startsWith("https://www.sec.gov/")));
 assert.equal(resolveCompanyBusiness("UNKNOWN"), null);
 const msft = resolveCompanyBusiness("MSFT");
 assert.equal(msft?.groups.length, 3);
 assert.match(msft!.basisLabel, /非 FY2027/);
 const html = renderToStaticMarkup(<BusinessFlow business={nvda} flow={{ schemaVersion: "business-flow.v1", ticker: "NVDA", fetchedAt: null, quarters: [] }} />);
 assert.match(html, /计算与网络/); assert.match(html, /展开业务/); assert.match(html, /季度财务未披露/);
});
test("published sourced analysis takes priority over curated historical disclosures", async () => {
 const { resolveCompanyBusiness } = await import("../lib/earning-report/web/company-business-content");
 const overview = { label: "业务", headline: "真实业务", introduction: "简介", highlights: [], deepDive: { headline: "业务", introduction: "简介", sections: [{ key: "business" as const, title: "业务", paragraphs: [{ text: "已发布真实公司业务", sourceIds: ["source"] }, { text: "无来源陈述不能映射", sourceIds: [] }] }], sources: [{ id: "source", title: "披露", url: "https://example.com/report", kind: "sec" as const, publishedAt: null, retrievedAt: "2026-09-30" }], limitations: ["分部金额未披露"] } };
 const result = resolveCompanyBusiness("NVDA", overview)!;
 assert.equal(result.groups.length, 1);
 assert.equal(result.groups[0].description, "已发布真实公司业务");
 assert.equal(result.groups[0].revenue, null);
});

test('actual SEC direct-operating schema renders complete conserved flow without inventing gross profit',async()=>{
 const {readFileSync}=await import('node:fs');
 const {parseSecBusinessFlow}=await import('../workers/pipeline/src/sec/business-flow-parser');
 const {parseSecEarningsRelease}=await import('../workers/pipeline/src/sec/business-flow-release');
 const {buildPublishedBusinessQuarter}=await import('../workers/pipeline/src/sec/business-flow-refresh');
 const a=parseSecBusinessFlow(readFileSync('tests/pipeline/fixtures/orcl-2026-q1-sec-xbrl.html','utf8'),{sourceUrl:'https://www.sec.gov/Archives/edgar/data/1341439/000119312526389274/orcl-20260831.htm',accession:'0001193125-26-389274',periodEnd:'2026-08-31'})[0];
 const b=parseSecEarningsRelease(readFileSync('tests/pipeline/fixtures/orcl-2026-q4-sec-exhibit-tables.html','utf8'),{sourceUrl:'https://www.sec.gov/Archives/edgar/data/1341439/000119312526265848/orcl-ex99_1.htm',accession:'0001193125-26-265848'})[0];
 const current=buildPublishedBusinessQuarter(a,'2026-09-11')!,prior=buildPublishedBusinessQuarter(b,'2026-06-10')!;
 assert.ok(reconcileQuarter(current).every(c=>c.status==='balanced'));assert.equal(compareAmount(current,prior,'net').label,'+10.6%');assert.equal(compareAmount(current,prior,'revenue','CloudInfrastructure').label,'+27.7%');
 for(const compact of [false,true]){const graph=financialGraph(current,compact);assert.equal(validateGraph(graph.nodes,graph.links),true);assert.ok(graph.nodes.some(n=>n.name==='net'));assert.ok(!graph.nodes.some(n=>n.name==='gross'));assert.ok(graph.links.some(l=>l.source==='other:nonoperating'&&l.target==='pretax'));assert.ok(graph.links.some(l=>l.source==='operating'&&l.target==='other:interest'));}
 const flow={schemaVersion:'business-flow.v1' as const,ticker:'ORCL',fetchedAt:'2026-09-30',quarters:[current,prior]};assert.equal(selectFlow(flow,null,'ORCL').quarters.length,2);assert.equal(selectFlow(flow,null,'NVDA').quarters.length,0);
 const html=renderToStaticMarkup(<BusinessFlow flow={flow}/>);assert.match(html,/19,345/);assert.match(html,/4,760/);assert.match(html,/云服务/);assert.match(html,/无形资产摊销/);
 const bad=structuredClone(current);bad.expenseComponents![0].amount.value='NaN';assert.equal(financialGraph(bad).links.length,0);
});

test("actual JPM bank bridge renders pretax, tax, net and disclosed expense categories in separate cells",()=>{
 const htmlSource=readFileSync(new URL("./pipeline/fixtures/jpm-2026-06-30-sec-income.html",import.meta.url),"utf8");
 const parsed=extractDisclosedQuarters(htmlSource,{cik:"0000019617",industry:"financial",accession:"0001628280-26-054343",url:"https://www.sec.gov/Archives/edgar/data/19617/000162828026054343/jpm-20260630.htm",filedAt:"2026-08-06"});
 const quarter=parsed.quarters.find(q=>q.periodEnd==="2026-06-30")!;assert.ok(quarter);
 const rendered=renderToStaticMarkup(<BusinessFlow flow={{schemaVersion:"business-flow.v1",ticker:"JPM",fetchedAt:"2026-10-01",quarters:[quarter]}}/>);
 assert.match(rendered,/完整银行财务桥图/);assert.match(rendered,/税前利润/);assert.match(rendered,/所得税/);assert.match(rendered,/27,516/);assert.match(rendered,/6,361/);assert.match(rendered,/21,155/);assert.match(rendered,/非利息费用/);assert.match(rendered,/信用损失准备/);assert.match(rendered,/宽度不表示金额比例/);
});

test('latest disclosed departments retain amounts while unavailable or redefined historical changes are omitted',()=>{
 const current=structuredClone(q4),prior=structuredClone(q3);
 current.segments[0].id='new-department';current.segments[0].name='本季新披露部门';
 prior.segments[0].name='仅历史部门';
 assert.equal(segmentChangeLabel(current,prior,'new-department'),'');
 const html=renderToStaticMarkup(<BusinessFlow flow={{...businessFlowFixture,quarters:[prior,current]}}/>);
 assert.match(html,/本季新披露部门/);assert.ok(!html.includes('仅历史部门'));
 const button=html.match(/<button[^>]*id="[^"]*-segment-new-department"[^>]*>[\s\S]*?<\/button>/)?.[0];
 assert.ok(button);assert.match(button,/<strong>/);assert.ok(!button.includes('环比'));assert.ok(!button.includes('不可比'));
 current.segments[0].id=prior.segments[0].id;
 current.segments[0].revenue!.comparabilityKey='changed-definition';
 assert.equal(segmentChangeLabel(current,prior,current.segments[0].id),'');
 current.segments[0].revenue!.comparabilityKey=prior.segments[0].revenue!.comparabilityKey;
 assert.match(segmentChangeLabel(current,prior,current.segments[0].id),/^环比 /);
});

function detailedQuarter() {
 const quarter = structuredClone(q4);
 const row = (id: string, value: number, parentId: string | null, childrenComplete = false) => ({ ...quarter.segments[0], id, name: id, parentId, childrenComplete, revenue: { ...quarter.segments[0].revenue!, value: String(value), definition: id } });
 const business: RevenueBreakdown = { id: "business", label: "产品与服务", kind: "product_service", definitionKey: "original", periodStart: quarter.periodStart!, periodEnd: quarter.periodEnd, currency: quarter.currency, scale: quarter.scale, complete: true,
 nodes: [row("cloud",60000,null,true),row("infrastructure",45000,"cloud"),row("applications",15000,"cloud"),row("other-services",30007,null)] };
 quarter.revenueBreakdowns=[business];
 return quarter;
}

test("automatically builds one revenue tree and never connects alternative dimensions", () => {
 const quarter=detailedQuarter();
 const geography={...structuredClone(quarter.revenueBreakdowns![0]),id:"regions",kind:"geography" as const};
 quarter.revenueBreakdowns!.unshift(geography);
 const tree=selectRevenueTree(quarter)!;
 assert.equal(tree.dimension.id,"business");
 const graph=financialGraph(quarter);
 assert.ok(validateGraph(graph.nodes,graph.links));
 assert.ok(graph.links.some(l=>l.source.includes("infrastructure") && l.target.includes("cloud")));
 assert.equal(graph.links.filter(l=>l.target==="revenue").reduce((sum,l)=>sum+l.value,0),90007);
 assert.ok(!graph.nodes.some(n=>n.name.includes("regions")||n.name.includes("segment-0")));
 const html=renderToStaticMarkup(<BusinessFlow flow={{...businessFlowFixture,quarters:[quarter]}} />);
 assert.match(html,/收入构成 · 产品与服务/);
 assert.match(html,/infrastructure/);
 assert.match(html,/财务分部收入/);
 assert.equal((html.match(/<select/g)??[]).length,1); // Only quarter selection, no dimension switch.
 const mobile=financialGraph(quarter,true);
 assert.deepEqual(mobile.nodes.filter(n=>n.segmentId),graph.nodes.filter(n=>n.segmentId));
});

test("partial children stop at the parent; explicit residuals and zero amounts stay conservative", () => {
 const quarter=detailedQuarter();
 quarter.revenueBreakdowns![0].nodes[2].revenue!.value="14000";
 const tree=selectRevenueTree(quarter)!;
 assert.deepEqual(tree.nodes.map(n=>n.id),["cloud","other-services"]);
 assert.ok(validateGraph(financialGraph(quarter).nodes,financialGraph(quarter).links));
 quarter.revenueBreakdowns![0].nodes.push({...quarter.revenueBreakdowns![0].nodes[2],id:"explicit-residual",revenue:{...quarter.revenueBreakdowns![0].nodes[2].revenue!,value:"1000"}});
 assert.equal(selectRevenueTree(quarter)!.nodes.length,5);
 quarter.revenueBreakdowns![0].nodes.push({...quarter.revenueBreakdowns![0].nodes[2],id:"zero",revenue:{...quarter.revenueBreakdowns![0].nodes[2].revenue!,value:"0"}});
 assert.ok(!selectRevenueTree(quarter)!.nodes.some(n=>n.id==="zero"));
});

test("invalid quarters, units, sources, duplicate IDs and cycles fall back to financial segments", () => {
 for (const change of [
  (d: RevenueBreakdown)=>{d.periodEnd="2026-03-31";},
  (d: RevenueBreakdown)=>{d.periodStart="2026-01-01";},
  (d: RevenueBreakdown)=>{d.currency="EUR";},
  (d: RevenueBreakdown)=>{d.scale=1;},
  (d: RevenueBreakdown)=>{d.complete=false;},
  (d: RevenueBreakdown)=>{d.nodes[0].revenue!.value="-1";},
  (d: RevenueBreakdown)=>{d.nodes[0].revenue!.sourceIds=["unverified"];},
  (d: RevenueBreakdown)=>{d.nodes.push(d.nodes[0]);},
  (d: RevenueBreakdown)=>{d.nodes[0].parentId="infrastructure";},
  (d: RevenueBreakdown)=>{d.nodes[0].parentId="missing-parent";},
 ]) {
  const quarter=detailedQuarter();change(quarter.revenueBreakdowns![0]);
  assert.equal(selectRevenueTree(quarter)?.legacy,true);
  assert.ok(validateGraph(financialGraph(quarter).nodes,financialGraph(quarter).links));
 }
 const totalOnly={...q4,segments:[],segmentsComplete:false};
 assert.equal(selectRevenueTree(totalOnly),null);
 assert.ok(financialGraph(totalOnly).nodes.some(n=>n.name==="revenue"));
});

test("selection is deterministic and revenue comparison rejects reclassification", () => {
 const current=detailedQuarter(), previous=detailedQuarter();
 previous.periodStart="2026-01-01";previous.periodEnd="2026-03-31";
 previous.revenueBreakdowns![0].periodStart=previous.periodStart;previous.revenueBreakdowns![0].periodEnd=previous.periodEnd;
 const id=revenueNodeKey(selectRevenueTree(current)!,"infrastructure");
 assert.equal(compareRevenueNode(current,previous,id).label,"0.0%");
 previous.revenueBreakdowns![0].definitionKey="recast";
 assert.equal(compareRevenueNode(current,previous,id).label,"不可比");
 const alternative={...structuredClone(current.revenueBreakdowns![0]),id:"a"};
 current.revenueBreakdowns!.push(alternative);
 const expected=selectRevenueTree(current)!.dimension.id;
 current.revenueBreakdowns!.reverse();assert.equal(selectRevenueTree(current)!.dimension.id,expected);
});

function nvdaQuarter() {
 return { ...structuredClone(q4),periodStart:null,periodEnd:"2026-07-26",segments:[],segmentsComplete:false,
 figures:{revenue:{...q4.figures.revenue!,value:"96221000000"}},sources:[],scale:1 };
}
test("NVDA filing adds the correct income hierarchy only to the matching verified quarter", () => {
 const base=nvdaQuarter(),quarter=enrichDisclosedRevenue("NVDA",base);
 assert.equal(selectRevenueTree(quarter)?.dimension.label,"市场平台");
 assert.equal(numeric(quarter.figures.operating),63734000000);
 assert.equal(quarter.figures.sales,undefined);assert.equal(quarter.figures.administration,undefined);
 const graph=financialGraph(quarter);assert.ok(validateGraph(graph.nodes,graph.links));
 assert.ok(graph.links.some(l=>l.source.includes("hyperscale")&&l.target.includes("data-center")&&l.value===48710000000));
 assert.ok(!graph.nodes.some(n=>n.label==="计算与网络"));
 const html=renderToStaticMarkup(<BusinessFlow flow={{schemaVersion:"business-flow.v1",ticker:"NVDA",fetchedAt:null,quarters:[quarter]}}/>);
 assert.match(html,/超大规模云客户/);assert.match(html,/88,299/);assert.match(html,/96,221/);
 assert.equal(enrichDisclosedRevenue("MSFT",base),base);
 for (const other of [{...base,periodEnd:"2026-04-26"},{...base,currency:"EUR"},{...base,figures:{...base.figures,revenue:{...base.figures.revenue,value:"66595000000"}}},{...base,figures:{...base.figures,operating:{...base.figures.revenue,value:"66595000000"}}}]) assert.equal(enrichDisclosedRevenue("NVDA",other),other);
 assert.deepEqual(enrichDisclosedRevenue("NVDA",quarter),quarter);
 const selected=selectFlow({schemaVersion:"business-flow.v1",ticker:"NVDA",fetchedAt:null,quarters:[base]},null,"NVDA");
 assert.equal(selectRevenueTree(selected.quarters[0])?.nodes.length,4);
});

test("optional bad hierarchy data cannot discard otherwise valid quarterly financials", () => {
 const flow=structuredClone(businessFlowFixture) as unknown as {quarters:Array<{revenueBreakdowns:unknown}>};
 flow.quarters[0].revenueBreakdowns=[{id:"broken"}];
 const result=selectFlow(flow as typeof businessFlowFixture,null,"MSFT");
 assert.equal(result.quarters.length,2);assert.ok(selectRevenueTree(result.quarters[0])?.legacy);
});


test("duplicate classification IDs cannot make automatic selection depend on payload order", () => {
 const quarter=detailedQuarter();
 quarter.revenueBreakdowns!.push({...structuredClone(quarter.revenueBreakdowns![0]),definitionKey:"conflicting-version"});
 assert.ok(selectRevenueTree(quarter)?.legacy);
 quarter.revenueBreakdowns!.reverse();assert.ok(selectRevenueTree(quarter)?.legacy);
});

test("existing disclosed segment children expand only when they reconcile to their parent", () => {
 const quarter=structuredClone(q4), segment=quarter.segments[0];
 const value=Number(segment.revenue!.value);
 segment.children=[{id:"child-a",name:"产品 A",revenue:{...segment.revenue!,value:String(value*0.6)}},{id:"child-b",name:"产品 B",revenue:{...segment.revenue!,value:String(value*0.4)}}];
 assert.ok(selectRevenueTree(quarter)!.nodes.some(n=>n.parentId===segment.id));
 assert.ok(validateGraph(financialGraph(quarter).nodes,financialGraph(quarter).links));
 segment.children[0].revenue.value="1";
 assert.ok(!selectRevenueTree(quarter)!.nodes.some(n=>n.parentId===segment.id));
});
