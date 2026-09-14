import assert from "node:assert/strict";
import test from "node:test";
import { buildFinancialLens, normalizeReaderReport, readerArticleText, editorialIssues } from "../../workers/pipeline/src/sec/reader.ts";
import { buildSecAnalysisBrief, type AnalysisFact, type SecHistorySnapshot } from "../../workers/pipeline/src/sec/analysis.ts";
import { fetchSecMarketSnapshot, parseSecMarketSnapshot } from "../../workers/pipeline/src/sec/market.ts";
import { summarizePreparedSecFiling } from "../../workers/pipeline/src/sec/pipeline.ts";
import { normalizeSecSummary, type SecNodePlan } from "../../workers/pipeline/src/sec/sec.ts";
import { readerFixture, readerFilingFixture, readerNodes } from "../fixtures/sec-reader-fixture.ts";
import { createSecPipelineOperations, type SecPipelineEnv } from "../../workers/pipeline/src/operations.ts";

const plan: SecNodePlan = { nodes: [{ id: "demand", title: "需求与投入回报", question: "什么改变了回报？", sectionIds: ["section"], historySeriesIds: [], memoryIds: [], acceptanceCriteria: [], materiality: "high" }], outlineSections: 1 };
const args = { nodes: readerNodes, plan, currentEvidence: new Set(["ev:demand"]), priorEvidence: new Set(["xbrl:prior"]), chartKeys: new Set<string>() };
const emptyHistory: SecHistorySnapshot = { registryVersion: "sec-canonical-series.v1", series: [] };
const brief = () => buildSecAnalysisBrief({ ticker: "DEMO", filingId: "demo-quarter", periodId: "DEMO:2026-06-30:quarter", periodScope: "quarter", reportDate: "2026-06-30", history: emptyHistory, memorySummary: "", memoryItems: [] });
const fact = (metricKey: string, value: number, overrides: Partial<AnalysisFact> = {}): AnalysisFact => ({ metricKey, value: String(value), unit: "USD", currency: "USD", periodScope: "quarter", periodEnd: "2026-06-30", basis: "gaap", confidence: "high", sourceLabel: "fact_source_reported", evidenceIds: ["ev:demand"], ...overrides });

test("complete reader article preserves a material mechanism and keeps bear case and falsifier", () => {
  const reader = normalizeReaderReport(readerFixture(), args);
  assert.equal(reader.sections.length, 3);
  assert.match(readerArticleText(reader), /最强的反面解释/);
  assert.match(readerArticleText(reader), /未来两个季度/);
  assert.ok(readerArticleText(reader).includes(reader.sections[0].paragraphs[1]));
});

test("invalid references, omitted material work and summary-only articles cannot compile", () => {
  const invalid = readerFixture(); invalid.sections[0].evidenceIds = ["invented"];
  assert.throws(() => normalizeReaderReport(invalid, args), /grounded/);
  const short = readerFixture(); short.sections[0].paragraphs = ["摘要"];
  assert.throws(() => normalizeReaderReport(short, args), /complete grounded/);
  const missingBear = readerFixture(); missingBear.sections[2].role = "business";
  assert.throws(() => normalizeReaderReport(missingBear, args), /bear case/);
  const missingWatch = readerFixture(); missingWatch.watch = [];
  assert.throws(() => normalizeReaderReport(missingWatch, args), /falsifiable/);
  assert.throws(() => normalizeReaderReport(readerFixture(), { ...args, nodes: [...readerNodes, { ...readerNodes[0], id: "material" }], plan: { ...plan, nodes: [...plan.nodes, { ...plan.nodes[0], id: "material" }] } }), /omitted/);
});

test("missing or invented historical baselines cannot label a disclosure new", () => {
  const input = readerFixture(); input.changes[0].kind = "new"; input.changes[0].priorEvidenceIds = ["old-model-claim"];
  const change = normalizeReaderReport(input, args).changes[0];
  assert.equal(change.kind, "not_comparable"); assert.match(change.prior, /缺少/);
});

test("exact duplicate prose and bad audit responses fail closed", () => {
  const input = readerFixture(); input.sections[1].paragraphs[0] = input.sections[0].paragraphs[0];
  assert.throws(() => normalizeReaderReport(input, args), /repeats/);
  assert.ok(editorialIssues({}).length);
  assert.ok(editorialIssues({ verdict: "pass", issues: [{ severity: "critical", detail: "所得税不能影响营业利润率" }] }).length);
  assert.ok(editorialIssues({ verdict: "revise", issues: [] }).length);
  assert.deepEqual(editorialIssues({ verdict: "pass", issues: [] }), []);
});

test("capital-intensive issuer: both cash definitions and explicitly conditional depreciation are calculated", () => {
  const b = brief(); b.currentFacts = [fact("operating_cash_flow", 9e8), fact("capex", 12e8), fact("operating_income", 4e8)];
  const nodes = [{ ...readerNodes[0], facts: [fact("management_net_capex", 7e8, { definition: "Net capex excludes eligible customer funding", basis: "management_kpi" }), fact("depreciable_life_years", 5, { unit: "years", currency: "", definition: "Server equipment" }), fact("depreciation", 2e8)] }];
  const lens = buildFinancialLens(b, nodes, "2026-06-30");
  assert.equal(lens.cashBridge?.standardFCF, -3e8); assert.equal(lens.cashBridge?.adjustedFCF, 2e8);
  assert.equal(lens.cashBridge?.adjustment, 5e8);
  assert.equal(lens.depreciation?.annualExpenseIllustration, 9.6e8);
  assert.equal(lens.depreciation?.currentAnnualizedDepreciation, 8e8);
  assert.equal(lens.depreciation?.currentAnnualizedOperatingIncome, 16e8);
  assert.match(lens.depreciation!.assumptions.join(" "), /不是盈利预测|不能.*相加/);
  assert.ok(lens.missingMetrics.includes("debt"));
});

test("YTD, mismatched currency and ambiguous asset lives cannot produce opposite-sign cash claims or projections", () => {
  const b = brief(); b.currentFacts = [fact("operating_cash_flow", 9e8), fact("capex", 12e8)];
  const nodes = [{ ...readerNodes[0], facts: [fact("management_net_capex", 7e8, { definition: "Net capex", periodScope: "ytd" }), fact("depreciable_life_years", 5, { unit: "years", currency: "", definition: "Servers" }), fact("depreciable_life_years", 30, { unit: "years", currency: "", definition: "Buildings" })] }];
  const lens = buildFinancialLens(b, nodes, "2026-06-30");
  assert.equal(lens.cashBridge?.adjustedFCF, undefined); assert.equal(lens.depreciation, undefined);
  b.currentFacts[1].currency = "EUR"; b.currentFacts[1].unit = "EUR";
  assert.equal(buildFinancialLens(b, nodes, "2026-06-30").cashBridge, undefined);
});

test("bank with no capex does not receive an industrial cash or depreciation scenario; debt can be recovered from a balance sheet", () => {
  const b = brief(); b.ticker = "BANK";
  const lens = buildFinancialLens(b, [{ ...readerNodes[0], facts: [fact("debt", 5e9, { periodScope: "instant", definition: "Total interest bearing debt" })] }], "2026-06-30");
  assert.equal(lens.cashBridge, undefined); assert.equal(lens.depreciation, undefined);
  assert.equal(lens.missingMetrics.includes("debt"), false);
});

test("retailer with no disclosed useful life gets cash analysis without an invented asset-life scenario", () => {
  const b = brief(); b.ticker = "RETAIL"; b.currentFacts = [fact("operating_cash_flow", 6e8), fact("capex", 2e8)];
  const lens = buildFinancialLens(b, readerNodes, "2026-06-30");
  assert.equal(lens.cashBridge?.standardFCF, 4e8); assert.equal(lens.depreciation, undefined);
});

test("full synthesis uses the compiled article, replaces invented metric magnitudes and retains data gaps", async () => {
  const filing = readerFilingFixture(); const b = brief(); b.currentFacts = [fact("revenue", 2e9)];
  const result = await summarizePreparedSecFiling({ filing, periodId: b.periodId, periodScope: "quarter", blockIds: ["ev:demand"], outline: [{ id: "section", title: "Business", level: 1, start: 0, end: 100, characters: 100 }] },
    { currentPeriodId: b.periodId, qoqPeriodId: null, yoyPeriodId: null }, async (_stage, system, payload) => {
      assert.match(system, /营业利润率|readerReport/); assert.doesNotMatch(system, /限1800|不要复写各专题/);
      assert.ok("financialLens" in (payload as object));
      return { readerReport: readerFixture(), headline: "需求与回报", bullets: [{ label: "现金", detail: "需要结合资本投入与回款。" }], analystView: "融资安全尚不能确认。", report: "", keyMetrics: [{ metricKey: "revenue", currentValue: "999999", evidenceIds: ["ev:demand"] }] };
    }, new Date("2026-08-14T12:00:00Z"), plan, readerNodes, b);
  assert.equal(result.summary.readerVersion, "sec-reader.v1");
  assert.ok(result.summary.report!.includes("最强的反面解释"));
  assert.equal(result.artifact.report.keyMetrics[0].currentValue, "2000000000");
  assert.equal(result.artifact.report.keyMetrics[0].currency, "USD");
  assert.equal(result.artifact.report.dataQuality.verificationStatus, "partial");
});

test("useful limitations are not filtered out as generic failure prose", () => {
  const filing = readerFilingFixture();
  const result = normalizeSecSummary({ headline: "缺少债务数据，需要后续复核融资能力", report: "未找到可核验的客户集中度，因此不能判断订单兑现风险。", bullets: [], analystView: "估值判断仍需要进一步复核。" }, filing);
  assert.ok(result.report); assert.ok(result.headline); assert.ok(result.analystView);
});

const marketPayload = () => ({ chart: { result: [{ meta: { symbol: "DEMO", currency: "USD", instrumentType: "EQUITY", exchangeTimezoneName: "America/New_York" }, timestamp: ["2026-08-07", "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-17"].map((d) => Date.parse(`${d}T14:00:00Z`) / 1000), indicators: { quote: [{ close: [100, 105, 108, 110, 120, 999, 9999] }] } }] } });

test("market context freezes completed closes and labels the actual event window, never partial or future bars", () => {
  const snapshot = parseSecMarketSnapshot(marketPayload(), readerFilingFixture(), emptyHistory, new Date("2026-08-14T16:00:00Z"), "https://example.com/chart")!;
  assert.equal(snapshot.price, 120); assert.equal(snapshot.priceDate, "2026-08-13");
  assert.equal(snapshot.reaction?.sessions, 3); assert.equal(snapshot.reaction?.from, "2026-08-07");
  assert.ok(Math.abs(snapshot.reaction!.changePercent - 20) < 1e-10);
  assert.equal(snapshot.trailingPE, undefined);
  const foreign = marketPayload(); foreign.chart.result[0].meta.symbol = "OTHER";
  assert.equal(parseSecMarketSnapshot(foreign, readerFilingFixture(), emptyHistory, new Date(), "https://example.com/chart"), undefined);
});

test("market provider failure is explicit and never substitutes a fabricated price", async () => {
  const market = await fetchSecMarketSnapshot(readerFilingFixture(), emptyHistory, async () => new Response("unavailable", { status: 503 }));
  assert.equal(market.status, "unavailable"); assert.equal(market.price, undefined);
});

test("TTM valuation requires four contiguous comparable EPS quarters; a fiscal year may use directly reported annual EPS", () => {
  const points = ["2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30"].map((endDate) => ({ observationId: endDate, seriesId: "diluted_eps" as const, metricKey: "diluted_eps", value: "2", currency: "USD", unit: "USD/shares", basis: "gaap" as const, periodScope: "quarter" as const, endDate, sourceAccession: "a", sourceFiledAt: "2026-08-10", sourceVersion: "v1", qualityStatus: "validated_xbrl" as const }));
  const history: SecHistorySnapshot = { registryVersion: "sec-canonical-series.v1", series: [{ seriesId: "diluted_eps", quarters: points, annual: [] }] };
  const parse = (filing = readerFilingFixture()) => parseSecMarketSnapshot(marketPayload(), filing, history, new Date("2026-08-14T16:00:00Z"), "https://example.com/chart")!;
  assert.equal(parse().trailingPE, 15);
  history.series[0].quarters.pop(); assert.equal(parse().trailingPE, undefined);
  history.series[0].annual = [{ ...points[0], periodScope: "annual", value: "10" }];
  assert.equal(parse({ ...readerFilingFixture(), form: "10-K" }).trailingPE, 12);
  assert.equal(parse({ ...readerFilingFixture(), form: "20-F" }).trailingPE, undefined);
  history.series[0].annual[0].value = "-10";
  assert.equal(parse({ ...readerFilingFixture(), form: "10-K" }).trailingPE, undefined);
});

test("production audit sees reader output and primary evidence; an unaudited reader cannot enter storage", async () => {
  const filing = readerFilingFixture(); const b = brief();
  const saved: string[] = [];
  const env = { AI_API_KEY: "synthetic-test-key", SEC_FILINGS: { async get() { return null; }, async put(key: string) { saved.push(key); } } } as unknown as SecPipelineEnv;
  const ops = createSecPipelineOperations(env, async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const payload = JSON.parse(request.messages[1].content);
    assert.ok(payload.reader.sections.some((s: { role: string }) => s.role === "bear_case"));
    assert.ok(payload.nodes[0].evidence[0].excerpt);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ verdict: "pass", issues: [{ severity: "critical", detail: "用所得税解释营业利润率，必须修订" }] }) } }] });
  });
  const artifact = { filing, periodId: b.periodId, periodScope: "quarter" as const, blocks: [], comparisons: [], report: filing.analysis! };
  const audit = await ops.auditReport!({ key: "filings/DEMO/demo-quarter", filing }, readerNodes, b, { artifact, summary: filing.summary }, 0);
  assert.equal(audit.issues.length, 1); assert.ok(saved.some((key) => key.includes("editorial-review/0")));
  await assert.rejects(ops.publish(artifact, filing.summary), /has not passed editorial review/);
});
