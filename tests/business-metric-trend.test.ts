import test from "node:test";
import assert from "node:assert/strict";
import { metricChanges, metricOptions, metricTicks, metricTrend } from "../apps/business-site/src/metric-model";
import type { FindingFundamentalSeries } from "../shared/analysis-runtime/findings";

const series = (metricKey: string, values: Array<[string, string | null]>, extra: Partial<FindingFundamentalSeries> = {}): FindingFundamentalSeries => ({
  metricKey: metricKey as FindingFundamentalSeries["metricKey"], label: metricKey, category: "income_statement", unitFamily: "currency", currency: "USD", available: true,
  points: values.map(([periodEnd, valueDecimal]) => ({ periodEnd, valueDecimal, sourceAccession: "0001341439-26-000001" })), ...extra,
});
// Oracle's fiscal quarters: Aug, Nov, Feb, May, with an older stretch the API also returns.
const ends = ["2018-05-31", "2018-08-31", "2024-02-29", "2024-08-31", "2024-11-30", "2025-02-28", "2025-05-31", "2025-08-31", "2025-11-30", "2026-02-28", "2026-05-31", "2026-08-31"];

test("a metric trend lays reported values on consecutive quarters, gaps stay gaps and old periods drop out", () => {
  const trend = metricTrend(series("net_income", ends.map((end, i) => [end, end === "2025-11-30" ? null : String(1000 + i * 100)])))!;
  assert.deepEqual(trend.points.map(p => p.periodEnd), ["2025-08-31", "2025-11-30", "2026-02-28", "2026-05-31", "2026-08-31"]);
  assert.equal(trend.points[1].value, null);
  assert.equal(trend.history.length, 9);
  assert.equal(trend.history[0].periodEnd, "2024-08-31");
  // The first visible quarter keeps its year-ago base.
  assert.equal(trend.history[0].value, 1300);
});

test("year-over-year growth needs a positive base; rates change in points", () => {
  const fcf = metricTrend(series("free_cash_flow", ends.map((end, i) => [end, String(i < 8 ? 500 : -200 * (i - 7))]), { category: "cash_flow" }))!;
  const yoy = metricChanges(fcf, 4);
  assert.equal(yoy.at(-1)!.toFixed(1), "-260.0"); // -800 against +500
  const qoq = metricChanges(fcf, 1);
  assert.equal(qoq.at(-1), null); // base -600 is not a growth base
  const margin = metricTrend(series("operating_margin", ends.map((end, i) => [end, String(30 + i * 0.5)]), { category: "ratio", unitFamily: "percent" }))!;
  assert.deepEqual(metricChanges(margin, 4).map(v => v == null ? null : Number(v.toFixed(2))), [2, 2, 2, 2, 2]);
});

test("negative values put zero on a gridline inside the axis", () => {
  const trend = metricTrend(series("free_cash_flow", ends.slice(-5).map((end, i) => [end, String([4e9, 2e9, -1.9e9, -5.4e9, 1e9][i])]), { category: "cash_flow" }))!;
  const ticks = metricTicks(trend);
  assert.ok(ticks.includes(0) && ticks[0] <= -5.4e9 && ticks[3] >= 4e9);
});

test("capex reads as a magnitude, as the original metrics table shows it", () => {
  const trend = metricTrend(series("capital_expenditure", ends.slice(-2).map(end => [end, "-16493000000"]), { category: "cash_flow" }))!;
  assert.equal(trend.points.at(-1)!.value, 16493000000);
});

test("options group metrics with at least two reported quarters, leaving revenue to the business view", () => {
  const groups = metricOptions({ series: [
    series("total_revenue", ends.map(end => [end, "1"])),
    series("net_income", ends.map(end => [end, "1"])),
    series("gross_profit", [["2026-05-31", null], ["2026-08-31", "5"]]),
    series("operating_cash_flow", ends.map(end => [end, "1"]), { category: "cash_flow" }),
    series("long_term_debt", ends.map(end => [end, "1"]), { category: "balance_sheet", available: false }),
  ] });
  assert.deepEqual(groups, [
    { group: "利润表", options: [{ key: "net_income", label: "net_income" }] },
    { group: "现金流", options: [{ key: "operating_cash_flow", label: "operating_cash_flow" }] },
  ]);
  assert.deepEqual(metricOptions(null), []);
});
