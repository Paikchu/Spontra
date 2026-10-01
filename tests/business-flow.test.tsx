import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BusinessFlow } from "../app/analysis/stocks/[ticker]/BusinessFlow";
import { adaptFundamentals, compareAmount, marginChange, numeric, previousQuarter, reconcileQuarter, selectFlow } from "../lib/earning-report/web/business-flow-model";
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
test("signed other loss and negative net income stay signed rather than positive sankey volume", () => {
  const loss = structuredClone(q4);
  loss.figures.other!.value = "-50000"; loss.figures.pretax!.value = "-9397"; loss.figures.net!.value = "-17678";
  assert.ok(reconcileQuarter(loss).every(r => r.status === "balanced"));
  const html = renderToStaticMarkup(<BusinessFlow flow={{ ...businessFlowFixture, quarters: [loss] }} />);
  assert.match(html, /-17,678/); assert.match(html, /data-tone="negative"/); assert.match(html, /财务金额明细/); assert.match(html, /完整有符号财务桥图/); assert.match(html, /宽度不表示金额比例/);
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
 const loss=structuredClone(q4);loss.figures.other!.value="-50000";loss.figures.pretax!.value="-9397";loss.figures.net!.value="-17678";assert.ok(financialGraph(loss).links.every(l=>l.value>0));assert.ok(!financialGraph(loss).nodes.some(n=>n.name==="net"));
 const negativeOther=structuredClone(q4);negativeOther.figures.other!.value="-100";negativeOther.figures.pretax!.value="40503";negativeOther.figures.net!.value="32222";const negativeGraph=financialGraph(negativeOther);assert.equal(validateGraph(negativeGraph.nodes,negativeGraph.links),true);assert.ok(negativeGraph.links.some(l=>l.source==="operating"&&l.target==="other"&&l.value===100));
});
test("published malformed payloads and duplicate periods fall back without crashing",()=>{
 const malformed=structuredClone(businessFlowFixture);malformed.quarters[0].scale=NaN;assert.equal(selectFlow(malformed,null,"MSFT").quarters.length,0);
 const duplicate=structuredClone(businessFlowFixture);duplicate.quarters.push(duplicate.quarters[0]);assert.equal(selectFlow(duplicate,null,"MSFT").quarters.length,0);
});

test("compact mobile chart aggregates only disclosed totals and retains conservation",()=>{
 const graph=financialGraph(q4,true);assert.equal(validateGraph(graph.nodes,graph.links),true);assert.ok(graph.nodes.some(n=>n.name==="operatingExpenses"));assert.ok(graph.nodes.some(n=>n.name==="net"));assert.equal(graph.nodes.filter(n=>n.segmentId).length,0);assert.equal(graph.links.find(l=>l.source==="business:segments")?.value,90007);
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
