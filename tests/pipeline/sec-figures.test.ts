import assert from "node:assert/strict";
import test from "node:test";
import { buildSecFigures, figureCatalog } from "../../workers/pipeline/src/sec/figures.ts";
import { buildSecAnalysisBrief } from "../../workers/pipeline/src/sec/analysis.ts";
import { normalizeReaderReport } from "../../workers/pipeline/src/sec/reader.ts";
import { SEC_FIGURE_SCHEMA, cashBridgeSteps, perHundred, type SecFigure } from "../../shared/analysis-runtime/sec-figures.ts";
import { SEC_READER_CONTENT_BLOCK_SCHEMA, type SecReaderContentBlock } from "../../shared/analysis-runtime/sec-reader-schema.ts";
import { FIGURE_FILING_DATE, FIGURE_REPORT_DATE, FIGURE_VALUES, figureHistory } from "../fixtures/sec-figure-fixture.ts";
import { readerFixture, readerNodes } from "../fixtures/sec-reader-fixture.ts";
import type { SecNodePlan } from "../../workers/pipeline/src/sec/sec.ts";

const brief = (history = figureHistory()) => buildSecAnalysisBrief({ ticker: "TEST", filingId: "new", periodId: `TEST:${FIGURE_REPORT_DATE}:quarter`, periodScope: "quarter", reportDate: FIGURE_REPORT_DATE, history, memorySummary: "", memoryItems: [] });
const build = (history = figureHistory(), filingDate = FIGURE_FILING_DATE) => buildSecFigures(brief(history), filingDate, FIGURE_REPORT_DATE);
const byKind = <K extends SecFigure["kind"]>(figures: SecFigure[], kind: K) => figures.find((f): f is Extract<SecFigure, { kind: K }> => f.kind === kind);

test("every figure kind is built from validated history for the report period", () => {
  const figures = build();
  assert.deepEqual(figures.map((f) => f.kind).sort(), ["cash_bridge", "cash_debt", "growth", "kpi_strip", "margin_ladder", "per_hundred", "profit_flow", "share_count"]);
  for (const figure of figures) {
    assert.equal(figure.figureKey, `${figure.kind}:${FIGURE_REPORT_DATE}`);
    assert.equal(SEC_FIGURE_SCHEMA.safeParse(figure).success, true);
  }
  const flow = byKind(figures, "profit_flow")!;
  assert.deepEqual([flow.current.revenue, flow.current.grossProfit, flow.current.operatingIncome, flow.current.netIncome], [1240, 769, 384, 273]);
  const hundred = byKind(figures, "per_hundred")!;
  assert.equal(hundred.prior.date, "2025-06-30");
  const parts = perHundred(hundred.current)!;
  assert.equal(Object.values(parts).reduce((a, b) => a + b, 0), 100);
  assert.equal(parts.netIncome, 22);
  const bridge = byKind(figures, "cash_bridge")!;
  assert.deepEqual(cashBridgeSteps(bridge).map((s) => [s.key, s.end]), [["net_income", 273], ["adjustments", 230], ["operating_cash_flow", 230], ["capex", 110], ["free_cash_flow", 110]]);
  const margins = byKind(figures, "margin_ladder")!;
  assert.deepEqual(margins.series.map((s) => s.metricKey), ["gross_margin", "operating_margin", "net_margin"]);
  assert.equal(margins.series[2].points.at(-1)!.value, 273 / 1240);
});

test("the writer sees each figure's purpose, limits and the exact numbers it will draw", () => {
  const catalog = figureCatalog(build());
  const growth = catalog.find((c) => c.kind === "growth")!;
  assert.match(growth.answers, /增速/);
  assert.ok(growth.limits);
  assert.deepEqual((growth.data as { yoyGrowth: Array<{ date: string; growth: number }> }).yoyGrowth, [{ date: "2026-06-30", growth: 0.181 }]);
});

test("figures stay out when data is stale, filed later, negative or does not reconcile", () => {
  // Newest revenue predates the report period: no revenue-based figure describes this filing.
  const stale = build(figureHistory({ ...FIGURE_VALUES, revenue: FIGURE_VALUES.revenue!.slice(0, 4) }));
  assert.equal(stale.some((f) => ["growth", "profit_flow", "per_hundred"].includes(f.kind)), false);
  // Values filed after this filing are not yet known.
  assert.deepEqual(build(figureHistory(FIGURE_VALUES, { revenue: { sourceFiledAt: "2027-01-01" } })).some((f) => f.kind === "growth"), false);
  // Net income above operating income cannot be drawn as a share of revenue.
  const negative = build(figureHistory({ ...FIGURE_VALUES, net_income: [180, 190, 200, 210, 400] }));
  assert.equal(negative.some((f) => f.kind === "profit_flow" || f.kind === "per_hundred"), false);
  // FCF that is not OCF less capex would not close the bridge.
  const history = figureHistory();
  history.series.find((s) => s.seriesId === "free_cash_flow")!.quarters[0].value = "999";
  assert.equal(build(history).some((f) => f.kind === "cash_bridge"), false);
});

test("reader figure blocks reference only unused available figures, at most two media per section", () => {
  const plan: SecNodePlan = { nodes: [{ id: "demand", title: "需求", question: "资金支持", sectionIds: ["s"], historySeriesIds: [], memoryIds: [], acceptanceCriteria: [], materiality: "high" }], outlineSections: 1 };
  const args = { nodes: readerNodes, plan, currentEvidence: new Set(["ev:demand"]), priorEvidence: new Set<string>(), chartKeys: new Set(["capex"]), figureKeys: new Set(["growth:2026-06-30", "profit_flow:2026-06-30"]), requireVisual: true };
  const figure = (blockId: string, figureKey: string): SecReaderContentBlock => ({ type: "figure", blockId, figureKey, title: "收入增长", caption: "说明规模与增速，不能证明分部变化。", evidenceIds: ["ev:demand"] });
  const draft = (extra: SecReaderContentBlock[]) => {
    const fixture = readerFixture();
    return { ...fixture, version: "sec-reader.v2" as const, sections: fixture.sections.map((section, i) => ({ ...section, id: `topic-${i + 1}`,
      content: [...section.paragraphs.map((markdown, j): SecReaderContentBlock => ({ type: "markdown", blockId: `topic-${i + 1}-p${j + 1}`, markdown, evidenceIds: section.evidenceIds })), ...(i === 0 ? extra : [])] })) };
  };
  const reader = normalizeReaderReport(draft([figure("growth-figure", "growth:2026-06-30")]), args);
  assert.equal(reader.sections[0].content?.at(-1)?.type, "figure");
  assert.equal(reader.sections[0].visual?.noChartReason, undefined);
  assert.throws(() => normalizeReaderReport(draft([figure("made-up", "growth:2099-01-01")]), args), /availableFigures/);
  assert.throws(() => normalizeReaderReport(draft([figure("a", "growth:2026-06-30"), figure("b", "growth:2026-06-30")]), args), /availableFigures/);
  const chart: SecReaderContentBlock = { type: "chart", blockId: "capex-chart", metricKey: "capex", mark: "bar", title: "资本开支", caption: "规模比较。", evidenceIds: ["ev:demand"] };
  assert.throws(() => normalizeReaderReport(draft([chart, figure("a", "growth:2026-06-30"), figure("b", "profit_flow:2026-06-30")]), args), /at most two/);
});

test("figure blocks carry references only, never data", () => {
  assert.equal(SEC_READER_CONTENT_BLOCK_SCHEMA.safeParse({ type: "figure", blockId: "f", figureKey: "growth:2026-06-30", title: "t", caption: "c", evidenceIds: [], points: [1] }).success, false);
});
