import { test } from "node:test";
import assert from "node:assert/strict";
import { flagCopy, metricRules, runQuarters } from "../src/flag-copy.ts";
import { ruleThreshold } from "../../../shared/analysis-runtime/statement-analysis.ts";
import { STATEMENT_RULES } from "../../../shared/analysis-contract/statement-analysis.ts";
import type { AssessedMetric, Flag } from "../../../shared/analysis-contract/statement-analysis.ts";

const flag = (ruleId: string, metricId: string, value: number, since: string, level: Flag["level"] = "note"): Flag =>
  ({ ruleId, level, dimension: "profitability", metricId, value, threshold: "", since, anchors: { view: "profit" }, evidence: [] } as unknown as Flag);
const metric = (form: AssessedMetric["form"], yoy: number | null, measure: AssessedMetric["measure"] = "value") =>
  ({ form, yoy, measure, current: { value: 0, resolved: { currency: "USD" } } } as unknown as AssessedMetric);

test("U29: a tripped rule reads as one sentence: the figure, its year-ago move and what the rule found", () => {
  const margin = flag("margin-expansion", "operating-margin", 66.2, "2026-04-26");
  assert.equal(flagCopy(margin, metric("percent", 6.13), "2026-07-26", "zh-CN").sentence, "营业利润率 66.2%，比去年同期高 6.1 个百分点，已连续 2 季改善");
  assert.equal(flagCopy(margin, metric("percent", 6.13), "2026-07-26", "en").sentence, "Operating margin 66.2%, 6.1 pp higher than a year ago, improving for 2 quarters");
  // A spread is itself a change, so it carries no second year-ago move; the run counts every quarter it held.
  const leverage = flag("operating-leverage", "operating-leverage", 18.2, "2026-01-25");
  assert.equal(flagCopy(leverage, metric("points", 3, "spread"), "2026-07-26", "zh-CN").sentence, "经营杠杆（营业利润同比 − 营收同比） +18.2个百分点，利润增速快于营收，已连续 3 季");
  const roic = flag("returns-strong", "roic", 134.1, "2026-07-26");
  assert.equal(flagCopy(roic, metric("percent", -2.04), "2026-07-26", "en").sentence, "Return on invested capital 134.1%, 2.0 pp lower than a year ago, returns on capital are high");
  assert.equal(flagCopy(flag("returns-strong", "roic", 134.1, "2025-07-27"), metric("percent", null), "2026-07-26", "zh-CN").verdict, "资本回报处于高位，已持续 5 季");
});

test("U29: no sentence or condition the page shows carries a comparison sign; the model's formula keeps its own", () => {
  for (const rule of STATEMENT_RULES) for (const locale of ["en", "zh-CN"] as const) {
    const copy = flagCopy(flag(rule.id, rule.metric, 12.5, "2026-01-25", rule.level), metric("percent", 1.5), "2026-07-26", locale);
    assert.doesNotMatch(copy.sentence, /[<>]|&gt;|&lt;/, `${rule.id} ${locale}: ${copy.sentence}`);
    for (const r of metricRules(rule.metric, [], locale)) assert.doesNotMatch(r.criteria, /[<>]|&gt;|&lt;/, r.criteria);
  }
  // The ledger and the model still read the formula, unchanged.
  assert.equal(ruleThreshold(STATEMENT_RULES.find(r => r.id === "operating-leverage")!, "zh-CN"), "> 15个百分点，且 营收同比 > 0%，连续 2 季");
});

test("U29: the lens lists every rule on the metric, met or not", () => {
  const rules = metricRules("operating-margin", [flag("margin-expansion", "operating-margin", 66.2, "2026-04-26")], "zh-CN");
  assert.deepEqual(rules.map(r => [r.rule.id, r.met, r.criteria]), [
    ["margin-compression", false, "同比变动 低于 -2个百分点，连续 2 季"],
    ["margin-expansion", true, "同比变动 高于 2个百分点，连续 2 季"],
  ]);
  assert.deepEqual(metricRules("operating-leverage", [], "en").map(r => r.criteria), ["above 15 pp, and Revenue growth above 0%, 2 quarters running"]);
  assert.equal(runQuarters("2025-10-26", "2026-07-26"), 4);
});
