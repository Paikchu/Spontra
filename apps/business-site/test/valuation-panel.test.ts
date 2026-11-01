import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import * as React from "react";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../../packages/web/src/i18n/core.ts";
import { valuation, valuationReport } from "../../../scripts/i18n/fixture.ts";
import type { ValuationPublication, ValuationResponse } from "../../../shared/analysis-contract/valuation.ts";

// The panel imports its stylesheet through Vite; here it resolves to an empty module. The runner compiles shared components with the classic JSX transform.
register(new URL("./fixtures/asset-hooks.mjs", import.meta.url));
(globalThis as Record<string, unknown>).React ??= React;
const { ValuationPanel } = await import("../src/ValuationPanel.tsx");

const render = (locale: "en" | "zh-CN", report: ValuationPublication) => { setLocale(locale); try { return renderToStaticMarkup(h(ValuationPanel, { ticker: report.ticker, valuation: { ...valuation, report } as ValuationResponse })); } finally { setLocale("en"); } };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** The report as valuation.calc.v2 and v1 wrote it: no judgements, no management scenario, no methods; probabilities on the scenarios only. */
function olderReport(): ValuationPublication {
  const m = valuationReport.model!;
  const { methods, triangulation, methodWeights, scenarioProbabilities, managementScenario, managementComparison, gates, peers, consensus, consensusNote, anchors, verification, horizonYears, midYear, ...rest } = m;
  void methods; void triangulation; void methodWeights; void scenarioProbabilities; void managementScenario; void managementComparison; void gates; void peers; void consensus; void consensusNote; void anchors; void verification; void horizonYears; void midYear;
  const scenario = (s: typeof m.scenarios.base) => { const { valuation: v, assumptions, ...plain } = s; void v; void assumptions; return plain; };
  return { ...valuationReport, calculatorVersion: "valuation.calc.v1", model: { ...rest, calculatorVersion: "valuation.calc.v1", scenarios: { bear: scenario(m.scenarios.bear), base: scenario(m.scenarios.base), bull: scenario(m.scenarios.bull) }, range: { ...m.range, expected: null, expectedUpside: null } } };
}

test("valuation.calc.v4: the panel shows each method with its weight and reason, the four scenarios with probabilities and the expected value, the peers, the checks, management's targets and the consensus note", () => {
  const html = render("en", valuationReport), t = text(html);
  // Methods with judged weights and rationales.
  assert.match(t, /Valuation methods/); assert.match(t, /Discounted cash flow/); assert.match(t, /EV\/EBITDA, forward/); assert.match(t, /P\/E, forward/);
  assert.match(t, /Discounted cash flow 50%/); assert.match(t, /Generated weight rationale for the EBITDA multiple\./);
  // Four scenarios: the DCF value beside the weighted value, the management row, the probabilities and the expected value.
  assert.match(t, /Cash-flow value/); assert.match(t, /Weighted value/);
  assert.match(t, /Management \$150\.00 \$165\.00 20%/); assert.match(t, /Scenario probabilities/); assert.match(t, /Management 20% Generated management probability rationale\./);
  assert.match(t, /Bear \$70\.00 \$77\.00 25%/); assert.match(t, /Base \$120\.00 \$132\.00 40%/);
  assert.match(t, /Expected value/); assert.match(t, /\$140\.25/); assert.match(t, /Probability-weighted over the bear, base, management and bull scenarios/);
  assert.match(html, /aria-label="Valuation assessment"/);
  // Peers, checks, management comparison and the consensus note.
  assert.match(t, /Comparable set Curated set · MSFT, AMZN, GOOGL · EV\/EBITDA p25 14\.0× · median 16\.0× · p75 18\.0×/);
  assert.match(t, /Model checks/); assert.match(t, /Terminal value share Pass/); assert.match(t, /Method dispersion Flag method bases span 1\.20x/); assert.match(t, /Consensus Flag consensus unavailable: no sell-side page was readable/);
  assert.match(t, /Management targets vs base case/); assert.match(t, /FY2027 · 1/); assert.match(t, /−4\.0%/); assert.match(t, /Generated management comparison explanation\./);
  assert.match(t, /Sell-side consensus/); assert.match(t, /Consensus unavailable Generated consensus unavailability reason\./);
  // The management narrative, the path assumptions and the rate sources sit in the model detail, rendered closed on the server.
  assert.match(t, /Show model inputs/);
  // Generated prose keeps its language tag.
  assert.match(html, /lang="en">Generated bear probability rationale\./);
  assert.match(html, /<td lang="en">terminal value is 75% of the base operating value<\/td>/);
});

test("valuation.calc.v4: the Chinese page carries the same sections with translated labels and the generated text tagged English", () => {
  const html = render("zh-CN", valuationReport), t = text(html);
  assert.match(t, /估值方法/); assert.match(t, /现金流折现 50%/); assert.match(t, /远期 EV\/EBITDA/); assert.match(t, /加权价值/); assert.match(t, /期望价值/); assert.match(t, /情景概率/); assert.match(t, /管理层 20%/);
  assert.match(t, /可比公司 人工选定 · MSFT, AMZN, GOOGL/); assert.match(t, /模型校验/); assert.match(t, /终值占比 通过/); assert.match(t, /方法离散度 提示/); assert.match(t, /管理层目标与基准情景/); assert.match(t, /2027 财年 · 1/); assert.match(t, /卖方共识/); assert.match(t, /无可用市场共识/);
  assert.match(html, /lang="en">Generated weight rationale for the cash-flow model\./);
  assert.doesNotMatch(t, /Valuation methods|Model checks|Expected value/);
});

test("older payloads (valuation.calc.v1/v2 without judgements) still render: three scenarios, no methods, checks, targets or consensus sections", () => {
  const report = olderReport();
  const html = render("en", report), t = text(html);
  assert.match(html, /aria-label="Valuation assessment"/); assert.match(t, /Bear \$70\.00 25%/); assert.match(t, /Base \$120\.00 40%/); assert.match(t, /Bull \$170\.00 15%/);
  assert.doesNotMatch(t, /Valuation methods|Model checks|Management targets vs base case|Sell-side consensus|Scenario probabilities|Weighted value|Expected value|To expected value|Management \$/);
  assert.match(t, /Per share/);
  assert.doesNotMatch(html, /undefined|NaN/);
  const zh = text(render("zh-CN", report));
  assert.doesNotMatch(zh, /估值方法|模型校验|卖方共识/); assert.match(zh, /每股价值/);
});
