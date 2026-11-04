import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import * as React from "react";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../../packages/web/src/i18n/core.ts";
import { valuation, valuationReport } from "../../../scripts/i18n/fixture.ts";
import type { ValuationPriceGuide } from "../../../shared/analysis-contract/price-guide.ts";
import type { ValuationPublication, ValuationResponse } from "../../../shared/analysis-contract/valuation.ts";

// The panel imports its stylesheet through Vite; here it resolves to an empty module. The runner compiles shared components with the classic JSX transform.
register(new URL("./fixtures/asset-hooks.mjs", import.meta.url));
(globalThis as Record<string, unknown>).React ??= React;
const { ValuationPanel } = await import("../src/ValuationPanel.tsx");

const render = (locale: "en" | "zh-CN", report: ValuationPublication, priceGuide?: ValuationPriceGuide) => { setLocale(locale); try { return renderToStaticMarkup(h(ValuationPanel, { ticker: report.ticker, valuation: { ...valuation, report, priceGuide } satisfies ValuationResponse })); } finally { setLocale("en"); } };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** The report as valuation.calc.v2 and v1 wrote it: no judgements, no management scenario, no methods; probabilities on the scenarios only. */
function olderReport(): ValuationPublication {
  const m = valuationReport.model!;
  const { methods, triangulation, methodWeights, scenarioProbabilities, managementScenario, managementComparison, gates, peers, consensus, consensusNote, anchors, verification, horizonYears, midYear, ...rest } = m;
  void methods; void triangulation; void methodWeights; void scenarioProbabilities; void managementScenario; void managementComparison; void gates; void peers; void consensus; void consensusNote; void anchors; void verification; void horizonYears; void midYear;
  const scenario = (s: typeof m.scenarios.base) => { const { valuation: v, assumptions, ...plain } = s; void v; void assumptions; return plain; };
  return { ...valuationReport, calculatorVersion: "valuation.calc.v1", model: { ...rest, calculatorVersion: "valuation.calc.v1", scenarios: { bear: scenario(m.scenarios.bear), base: scenario(m.scenarios.base), bull: scenario(m.scenarios.bull) }, range: { ...m.range, expected: null, expectedUpside: null } } };
}

function fairReport(): ValuationPublication {
  const model = valuationReport.model!;
  const normalCase = (perShare: number) => ({ ...model.scenarios.base, assumptions: model.scenarios.base.assumptions!, result: { ...model.scenarios.base.result, perShare }, valuation: { ...model.scenarios.base.valuation!, perShare }, gates: [], verification: null });
  return { ...valuationReport, model: { ...model, fairValueRange: { status: "available", kind: "normal_cases", low: 110, base: 132, high: 155, lower: normalCase(110), upper: normalCase(155), rationale: "Normal cases vary the evidenced operating assumptions.", evidenceIds: ["e0123456789"] } } };
}

function availableGuide(position: "below" | "within" | "above", price: number): ValuationPriceGuide {
  return { status: "available", reportVersionId: valuationReport.versionId, quote: { ...valuationReport.quote!, price, priceDate: "2026-08-13" }, position, gapToLow: 110 / price - 1, gapToBase: 132 / price - 1, gapToHigh: 155 / price - 1, discountToBase: 1 - price / 132 };
}

const mainGuide = (html: string) => html.match(/<section class="val-block val-fair"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? "";
const stress = (html: string) => html.match(/<details class="val-fold val-stress">([\s\S]*?)<\/details>/)?.[1] ?? "";
const headOf = (html: string) => html.match(/<header class="val-head">([\s\S]*?)<\/header>/)?.[1] ?? "";

test("the document reads head, scores, the live fair-value block with its stress fold, the report with its value sources, then sources", () => {
  const html = render("en", valuationReport), t = text(html);
  assert.match(html, /aria-label="Valuation assessment"/);
  assert.match(text(headOf(html)), /Composite score 6\.4 \/ 10/);
  assert.match(t, /Five-dimension research score · Researched 2026-08-12/);
  // The fair-value block and the stress fold are the live page's.
  assert.match(html, /<section class="val-block val-fair" aria-label="Price relative to fair value"><h3>Fair value range<\/h3><p class="val-fair-value">—<\/p>/);
  assert.match(html, /<section class="val-block"><details class="val-fold val-stress"><summary>Scenarios and stress tests<\/summary>/);
  const s = text(stress(html));
  assert.match(s, /Value per share/); assert.match(s, /Bear \$70\.00 \$77\.00 25%/); assert.match(s, /Base \$120\.00 \$132\.00 40%/); assert.match(s, /Management \$150\.00 \$165\.00 20%/);
  assert.match(s, /Scenario-weighted value \$140\.25/); assert.match(s, /Scenario probabilities Bear 25%/); assert.match(s, /Management 20% Generated management probability rationale\./);
  assert.match(s, /Sensitivity of the base value/); assert.match(s, /Show model inputs/);
  assert.match(stress(html), /class="val-range-mark val-range-price"/);
  // The report: the system's sections, with the method weights, management comparison and consensus as its value sources.
  assert.match(t, /Assessment report Summary/); assert.match(t, /Where the value comes from Discounted cash flow 50% Generated weight rationale for the cash-flow model\./);
  assert.match(t, /Management targets vs base case Generated management comparison explanation\./); assert.match(t, /Sell-side consensus Generated consensus unavailability reason\./);
  assert.match(t, /Catalysts Generated catalyst\. Next checks Generated next check\. Counter-evidence Generated counter-evidence\. Model notes Generated model notes\./);
  assert.doesNotMatch(t, /Valuation methods|Model checks|Comparable set/);
  assert.doesNotMatch(html, /val-select|<option|undefined|NaN/);
  assert.doesNotMatch(t, /valuation\.calc|valuation\.v1/);
  assert.match(html, /lang="en">Generated weight rationale for the cash-flow model\./);
});

test("the Chinese page carries the same sections with translated labels", () => {
  const html = render("zh-CN", valuationReport), t = text(html);
  assert.match(t, /综合评分 6\.4 \/ 10/); assert.match(t, /五维研究评分 · 2026-08-12 研究/);
  assert.match(t, /合理价值区间 —/); assert.match(t, /情景与压力测试/); assert.match(text(stress(html)), /悲观 70\.00美元 77\.00美元 25%/); assert.match(text(stress(html)), /情景加权值 140\.25美元/);
  assert.match(t, /评估报告 .*?结论 /); assert.match(t, /价值来源 现金流折现 50%/); assert.match(t, /催化 .*? 下一验证点 .*? 反证 .*? 模型说明/);
  assert.doesNotMatch(t, /估值方法|模型校验/);
});

test("older payloads (valuation.calc.v1/v2) still render their three scenarios and probabilities", () => {
  const html = render("en", olderReport()), s = text(stress(html));
  assert.match(s, /Bear \$70\.00 25%/); assert.match(s, /Base \$120\.00 40%/); assert.match(s, /Bull \$170\.00 15%/);
  assert.doesNotMatch(s, /Weighted value|Scenario-weighted value|Management \$/);
  assert.doesNotMatch(html, /undefined|NaN/);
});

test("price guidance: the head says where the close sits; the fair-value block shows the supported range, its reasons and key assumptions; stress values stay in their fold", () => {
  const report = fairReport();
  for (const [position, price, en, zh] of [["below", 98, "Below fair value range", "偏低"], ["within", 132, "Within fair value range", "区间内"], ["above", 180, "Above fair value range", "偏高"]] as const) {
    const guide = availableGuide(position, price), html = render("en", report, guide), main = text(mainGuide(html));
    assert.match(headOf(html), new RegExp(`class="val-position" data-tone="[a-z]+">${en}<`));
    assert.match(text(headOf(html)), new RegExp(`\\$${price}\\.00 2026-08-13`));
    assert.match(main, /Fair value range \$110\.00 – \$155\.00/);
    assert.match(main, /Close of 2026-08-13/); assert.match(main, /Base value \$132\.00/);
    assert.match(main, /Key assumptions/); assert.match(main, /Generated revenue assumption/);
    assert.doesNotMatch(main, /\$77\.00|\$187\.00|Expected value/);
    assert.match(text(stress(html)), /Bear \$70\.00 \$77\.00 25%/);
    assert.match(render("zh-CN", report, guide), new RegExp(`class="val-position" data-tone="[a-z]+">${zh}<`));
  }
});

test("a quote problem prevents the position but preserves the supported range with its price date", () => {
  const report = fairReport();
  const guide: ValuationPriceGuide = { status: "unavailable", reportVersionId: report.versionId, quote: report.quote, reason: "stale_quote" };
  const html = render("en", report, guide), main = text(mainGuide(html));
  assert.match(headOf(html), /class="val-position" data-tone="neutral">Unable to assess</);
  assert.match(main, /\$110\.00 – \$155\.00/); assert.match(main, /Close of 2026-08-11/); assert.match(main, /The reference quote is out of date/);
});

test("incomplete evidence never presents the calculation's stress values as a fair value range", () => {
  const report = fairReport();
  for (const reason of ["incomplete_research", "unresolved_evidence", "report_updating"] as const) {
    const guide: ValuationPriceGuide = { status: "unavailable", reportVersionId: report.versionId, quote: report.quote, reason };
    const html = render("zh-CN", report, guide), main = text(mainGuide(html));
    assert.match(headOf(html), /暂无法判断/);
    assert.match(main, /合理价值区间 —/);
    assert.doesNotMatch(main, /110\.00美元|155\.00美元|77\.00美元|187\.00美元|关键假设/);
  }
  const noRange = { ...report, model: { ...report.model!, fairValueRange: { status: "unavailable" as const, reason: "The financing assumptions need evidence.", evidenceIds: [] } } };
  assert.match(text(mainGuide(render("en", noRange, { status: "unavailable", reportVersionId: report.versionId, quote: report.quote, reason: "no_range" }))), /The financing assumptions need evidence/);
});

test("older reports and mismatched current guides cannot acquire a position by fallback", () => {
  const old = render("en", olderReport());
  assert.match(headOf(old), /Unable to assess/);
  assert.match(text(mainGuide(old)), /A supported fair value range is not available/);
  assert.doesNotMatch(mainGuide(old), /\$77\.00|\$187\.00/);
  const guide = { ...availableGuide("below", 98), reportVersionId: "another-version" };
  const html = render("en", fairReport(), guide);
  assert.match(headOf(html), /Unable to assess/);
  assert.doesNotMatch(headOf(html), /2026-08-13/);
});

test("the five dimensions draw on one fixed radar beside their rows, with the scoring template folded under them", () => {
  const html = render("en", valuationReport), t = text(html);
  assert.match(html, /<figure class="val-radar" data-compact="" aria-label="Five-dimension chart · Business quality [0-9.]+ · Growth delivery [0-9.]+ · Valuation safety [0-9.]+ · Mispricing and catalysts [0-9.]+ · Financial resilience [0-9.]+"/);
  assert.match(html, /class="val-radar-area" points="[0-9., ]+"/);
  assert.equal((html.match(/class="val-radar-dot"/g) ?? []).length, 5);
  assert.match(html, /class="val-radar-label" data-side="top"[^>]*><b>Business quality<\/b><\/span>/);
  assert.match(html, /<li class="val-dim"><span class="val-dim-name">Business quality<small>20%<\/small><\/span><span class="val-dim-score">[0-9.]+<small>\/10<\/small><\/span><div class="val-dim-judgement"><p lang="en">Generated rationale on business quality/);
  assert.match(html, /<details class="val-fold val-template"><summary>Scoring template<\/summary>/);
  assert.match(t, /Business quality Weight 20% · research phase 2 customer value or model visibly impaired/);
  assert.match(t, /Valuation safety Weight 30% · assumptions phase/);
  assert.match(t, /Confidence High every key fact first-hand/);
  const zh = text(render("zh-CN", valuationReport));
  assert.match(zh, /评分模板/); assert.match(zh, /生意质量 权重 20% · 研究阶段 2 客户价值或商业模式明显受损/);
});

test("an unscored dimension sits at the centre of the radar and is labelled as such in its row", () => {
  const report: ValuationPublication = { ...valuationReport, dimensions: valuationReport.dimensions.map(d => d.key === "financialResilience" ? { ...d, score: null } : d) };
  const html = render("en", report);
  assert.match(html, /class="val-radar-dot" data-unscored="" cx="200\.0" cy="190\.0"/);
  assert.match(html, /Financial resilience not scored"/);
  assert.match(html, /<span class="val-dim-name">Financial resilience<small>10%<\/small><\/span><span class="val-dim-score"><small>Not scored<\/small><\/span>/);
});

test("each dimension's row carries its full rationale with citations and gaps; the model notes stay in the report", () => {
  const html = render("en", valuationReport), t = text(html);
  assert.equal((html.match(/<div class="val-dim-judgement">/g) ?? []).length, 5);
  assert.match(html, /<div class="val-dim-judgement"><p lang="en">Generated rationale on business quality ?<sup class="val-refs">/);
  assert.doesNotMatch(html, /val-table--judgements/);
  assert.match(t, /Model notes Generated model notes/);
});
