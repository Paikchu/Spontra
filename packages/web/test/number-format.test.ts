import assert from "node:assert/strict";
import { test } from "node:test";
import { setLocale } from "../src/i18n/core.ts";
import { compactFlowValue } from "../src/model/business-flow-layout.ts";
import { adjustmentName, compareFlowAmounts, formatReconciliation } from "../src/model/business-flow-model.ts";
import { financialGraph } from "../src/model/business-flow-sankey.ts";
import { formatSecMetricValue } from "../src/model/sec-metric-format.ts";
import { adjustmentLabel, axisNumber, axisUnit, compactMoney, compactNumber, formatPct, MINUS, normalizeDisplayText } from "../../../shared/analysis-runtime/locale.ts";
import type { BusinessFlowQuarter, FlowAmount } from "../../../shared/analysis-contract/business-flow.ts";

const amount = (v: number, key = "k"): FlowAmount => ({ value: String(v), basis: "reported", definition: "d", comparabilityKey: key, sourceIds: [] });
const quarter = (over: Partial<BusinessFlowQuarter> = {}): BusinessFlowQuarter => ({
  id: "q", label: "q", periodStart: null, periodEnd: "2026-06-30", periodType: "3M", currency: "USD", scale: 1, basisLabel: "", reportedAt: null,
  figures: {}, segments: [], segmentsComplete: false, sources: [], ...over,
});

test("U23: a figure that rounds into the next unit reads in that unit, never 1000M, 1000B, 10000万 or 10000亿", () => {
  assert.equal(compactMoney(999_950_000, "USD", "en"), "$1.00B");
  assert.equal(compactMoney(-999_950_000, "USD", "en"), `${MINUS}$1.00B`);
  assert.equal(compactMoney(99_995_000, "USD", "zh-CN"), "1.00亿美元");
  assert.equal(compactNumber(9999.5e4, "zh-CN"), "1.00亿");
  assert.equal(compactNumber(9999.5e8, "zh-CN"), "1.00万亿");
  assert.equal(compactNumber(999.95e9, "en"), "1.00T");
  assert.equal(compactNumber(999.5e3, "en"), "1.00M");
  assert.equal(compactNumber(99.96e6, "en"), "100M");
  // The forms the i18n check pins stay as they were.
  assert.equal(compactMoney(350e6, "USD", "zh-CN"), "3.50亿美元");
  assert.equal(compactMoney(1.2e12, "USD", "zh-CN"), "1.20万亿美元");
  assert.equal(compactMoney(4.2e9, "EUR", "zh-CN"), "42.0亿欧元");
  assert.equal(compactMoney(4.2e9, "SEK"), "4.2B SEK");
  assert.equal(compactMoney(75.7e9, "USD"), "$75.7B");
  for (const v of [999.5e3, 999.95e6, 999.95e9, 9999.5e4, 9999.5e8, 9_999.6, 99_999.6e4]) for (const locale of ["en", "zh-CN"] as const)
    assert.doesNotMatch(compactNumber(v, locale), /^(?:1000(?:\.0+)?[KMBT]|10000(?:\.0+)?(?:万|亿))$/, `${v} ${locale}`);
});

test("U23: the flow chart's own amounts roll over and take the mathematical minus", () => {
  setLocale("en");
  assert.equal(compactFlowValue(999.95, quarter({ scale: 1e6 })), "$1.00B");
  assert.equal(compactFlowValue(-28.7e9, quarter()), `${MINUS}$28.7B`);
  assert.equal(compactFlowValue(-0.2, quarter()), "$0");
  assert.equal(compactFlowValue(4.2e9, quarter({ currency: "SEK" })), "4.2B SEK");
  setLocale("zh-CN");
  assert.equal(compactFlowValue(-11.6e9, quarter()), `${MINUS}116亿美元`);
  setLocale("en");
});

test("U23: percentages carry the mathematical minus, a plus when signed, and no sign at zero", () => {
  assert.equal(formatPct(0), "0%");
  assert.equal(formatPct(-0), "0%");
  assert.equal(formatPct(-0.02), "0%");
  assert.equal(formatPct(-3.14), "−3.1%");
  assert.equal(formatPct(8.12, { signed: true }), "+8.1%");
  assert.equal(formatPct(null), "—");
  const q = quarter(), prior = quarter({ periodEnd: "2025-06-30" });
  assert.equal(compareFlowAmounts(q, prior, "revenue", amount(96.9), amount(100)).label, "−3.1%");
  assert.equal(compareFlowAmounts(q, prior, "revenue", amount(108.12), amount(100)).label, "+8.1%");
  assert.equal(compareFlowAmounts(q, prior, "revenue", amount(99.99), amount(100)).label, "0%");
  for (const label of [compareFlowAmounts(q, prior, "revenue", amount(50), amount(100)).label]) assert.doesNotMatch(label, /^-|负/);
});

test("U23: stored SEC values write negatives with the mathematical minus and a rounded zero without a sign", () => {
  assert.equal(formatSecMetricValue("gross_margin", "-0.0002", "ratio"), "0%");
  assert.equal(formatSecMetricValue("gross_margin", "-0.031", "ratio"), "−3.1%");
  assert.equal(formatSecMetricValue("free_cash_flow", "-11600000000", "USD", "USD"), "−$11.6B");
  assert.equal(formatSecMetricValue("free_cash_flow", "-11600000000", "USD", "USD", "zh-CN"), "−116亿美元");
  assert.equal(formatSecMetricValue("diluted_shares", "-12000", "shares"), "−12K shares");
});

test("U23: model-written text reads with the mathematical minus; dates and form names stay", () => {
  assert.equal(normalizeDisplayText("1730亿美元资本开支使自由现金流降至负116亿美元"), "1730亿美元资本开支使自由现金流降至−116亿美元");
  assert.equal(normalizeDisplayText("56.6亿美元资本开支使自由现金流降至 -34.1亿美元"), "56.6亿美元资本开支使自由现金流降至 −34.1亿美元");
  assert.equal(normalizeDisplayText("Free cash flow fell to -$3.4B"), "Free cash flow fell to −$3.4B");
  assert.equal(normalizeDisplayText("毛利率 -3.1%"), "毛利率 −3.1%");
  // English prose spells the sign out: "negative" before an amount or percent becomes the minus, whatever its case.
  assert.equal(normalizeDisplayText("Capex of $173 billion drives free cash flow to negative $11.6 billion"), "Capex of $173 billion drives free cash flow to −$11.6 billion");
  assert.equal(normalizeDisplayText("Negative $11.6 billion"), "−$11.6 billion");
  assert.equal(normalizeDisplayText("margin turned negative 12.3%"), "margin turned −12.3%");
  assert.equal(normalizeDisplayText("negative 12.3%"), "−12.3%");
  // Not an amount: the word stays.
  assert.equal(normalizeDisplayText("free cash flow turned negative in 2026-Q3"), "free cash flow turned negative in 2026-Q3");
  assert.equal(normalizeDisplayText("2026-09-30 的 10-K 与 8-K"), "2026-09-30 的 10-K 与 8-K");
});

test("U23: the reconciliation keeps at most two decimals in every row", () => {
  setLocale("zh-CN");
  const q = quarter({ scale: 1e6 });
  assert.equal(formatReconciliation(1204.4, q), "12.04亿美元");
  assert.equal(formatReconciliation(-0.567, q), "−56.7万美元");
  assert.equal(formatReconciliation(1203.9, q), "12.04亿美元");
  for (const v of [1204.4417, 1203.873, -0.5671, 12.345678]) assert.doesNotMatch(formatReconciliation(v, q), /\.\d{3}/);
  setLocale("en");
  assert.equal(formatReconciliation(1204.4417, q), "1,204.4");
  assert.equal(formatReconciliation(-0.5671, q), "−0.57");
  assert.equal(formatReconciliation(null, q), "Not disclosed");
});

test("U21: chart axis ticks leave the currency to one unit line", () => {
  assert.deepEqual([0, 60e9, -20e9, 1.5e12].map(v => axisNumber(v, "zh-CN")), ["0", "600亿", "−200亿", "1.50万亿"]);
  assert.deepEqual([0, 60e9, -20e9, 1.5e9, 750e6].map(v => axisNumber(v, "en")), ["0", "60B", "−20B", "1.5B", "750M"]);
  assert.equal(axisUnit("USD", "zh-CN"), "单位：美元");
  assert.equal(axisUnit("TWD", "zh-CN"), "单位：新台币");
  assert.equal(axisUnit("TWD", "en"), "Unit: TWD");
  // No tick carries a currency word or symbol.
  for (const v of [6e10, 1.5e12, -2e10]) assert.doesNotMatch(axisNumber(v, "zh-CN"), /美元|新台币|\$/);
});

test("U21: known revenue adjustment lines read in Chinese on the Chinese page, in the chart as in the reconciliation", () => {
  assert.equal(adjustmentLabel("Reconciling items", "zh-CN"), "调节项");
  assert.equal(adjustmentLabel("RECONCILING ITEMS", "zh-CN"), "调节项");
  for (const name of ["Intersegment sales", "Intersegment revenues", "Intersegment eliminations", "Eliminations", "Elimination"]) assert.equal(adjustmentLabel(name, "zh-CN"), "分部间抵销", name);
  assert.equal(adjustmentLabel("Corporate and other", "zh-CN"), "Corporate and other");
  assert.equal(adjustmentLabel("Intersegment sales", "en"), "Intersegment sales");
  setLocale("zh-CN");
  assert.equal(adjustmentName("Intersegment eliminations"), "分部间抵销");
  const q = quarter({
    figures: { revenue: amount(90), cost: amount(40), gross: amount(50), operatingExpenses: amount(20), operating: amount(30), pretax: amount(30), tax: amount(5), net: amount(25) },
    segments: [{ id: "a", name: "Alpha", revenue: amount(60) }, { id: "b", name: "Beta", revenue: amount(40) }], segmentsComplete: true,
    revenueAdjustments: [{ id: "x", name: "Intersegment eliminations", amount: amount(-10) }],
  } as Partial<BusinessFlowQuarter>);
  const node = financialGraph(q).nodes.find(n => n.name === "revenue-adjustment:x");
  assert.equal(node?.label, "分部间抵销");
  setLocale("en");
  assert.equal(financialGraph(q).nodes.find(n => n.name === "revenue-adjustment:x")?.label, "Intersegment eliminations");
});
