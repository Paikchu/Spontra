import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlowQuarter } from "../../../shared/analysis-contract/business-flow.ts";
import type { LensChart } from "../../../shared/analysis-contract/lens.ts";
import { resolveEvidence, resolveRef, shiftPeriod, watchPeriod, type FindingData } from "../../../shared/analysis-runtime/findings.ts";
import { compileChart } from "../../../shared/analysis-runtime/lens/compile.ts";
import { assessStatements } from "../../../shared/analysis-runtime/statement-analysis.ts";

// Explicit 52/53-week dates: do not generate fixtures with the shift being tested.
const ENDS = ["2024-02-04", "2024-05-05", "2024-08-04", "2024-11-03", "2025-02-02", "2025-05-04", "2025-08-03", "2025-11-02"];
const CURRENT = "2025-11-02";
const revenue = { metric: "revenue" } as const;
function quarter(periodEnd: string, i: number): BusinessFlowQuarter {
  return {
    id: periodEnd, label: periodEnd, periodStart: null, periodEnd, periodType: "3M", currency: "USD", scale: 1,
    basisLabel: "", reportedAt: null, segments: [], segmentsComplete: true, sources: [],
    figures: { revenue: { value: String(100 + i * 10), basis: "reported", definition: "", comparabilityKey: null, sourceIds: [] } },
  };
}
const data: FindingData = { quarters: ENDS.map(quarter), history: null, capital: null, fundamentals: null, guidance: null };
const chart: LensChart = {
  id: "revenue", aspect: "wide", span: "quarter", periods: 4,
  series: [{ id: "revenue", ref: revenue }], marks: [{ type: "line", series: ["revenue"] }],
};

test("period shifts use nominal fiscal months, including January rollover and the first-week boundary", () => {
  for (const [end, months, expected] of [
    ["2025-08-03", -3, "2025-04-30"],
    ["2025-05-04", -12, "2024-04-30"],
    ["2025-01-04", 0, "2024-12-31"],
    ["2025-01-04", -12, "2023-12-31"],
    ["2025-01-04", 3, "2025-03-31"],
    ["2025-05-07", 0, "2025-04-30"],
    ["2025-05-08", 0, "2025-05-31"],
    ["2025-04-30", -3, "2025-01-31"],
    ["2024-05-31", -3, "2024-02-29"],
  ] as const) assert.equal(shiftPeriod(end, months), expected, `${end} shifted by ${months} months`);
});

test("first-week quarters retain YoY and QoQ evidence and their actual period ends", () => {
  for (const [compare, priorEnd, priorValue] of [["yoy", "2024-11-03", 130], ["qoq", "2025-08-03", 160]] as const) {
    const resolved = resolveEvidence(data, { ref: revenue, periodEnd: CURRENT, span: "quarter", compare });
    assert.ok(resolved, `${compare} evidence must resolve`);
    assert.equal(resolved.current.periodEnd, CURRENT);
    assert.equal(resolved.current.value, 170);
    assert.equal(resolved.compare?.periodEnd, priorEnd);
    assert.equal(resolved.compare?.value, priorValue);
    assert.equal(resolved.delta, (170 - priorValue) / priorValue * 100);
  }
});

test("four-quarter evidence sums distinct quarters and resolves its year-earlier span", () => {
  const resolved = resolveEvidence(data, { ref: revenue, periodEnd: CURRENT, span: "fiscal_year", compare: "yoy" });
  assert.ok(resolved);
  assert.equal(resolved.current.value, 620);
  assert.equal(resolved.current.periodEnd, CURRENT);
  assert.equal(resolved.compare?.value, 460);
  assert.equal(resolved.compare?.periodEnd, "2024-11-03");
});

test("charts resolve first-week quarterly values, comparisons, and four-quarter spans", () => {
  for (const transform of ["value", "yoy", "qoq"] as const) {
    const compiled = compileChart({ ...chart, series: [{ id: "revenue", ref: revenue, transform }] }, data, CURRENT);
    assert.deepEqual(compiled.errors, []);
    const expected = [140, 150, 160, 170].map((value, i) => transform === "value" ? value
      : transform === "yoy" ? (value - (100 + i * 10)) / (100 + i * 10) * 100 : 10 / (130 + i * 10) * 100);
    assert.deepEqual(compiled.chart?.series[0].values, expected);
  }
  const annual = compileChart({ ...chart, span: "fiscal_year", periods: 2 }, data, CURRENT);
  assert.deepEqual(annual.errors, []);
  assert.deepEqual(annual.chart?.series[0].values, [460, 620]);
});

test("statement assessment retains first-week revenue growth history", () => {
  const assessed = assessStatements(data, CURRENT);
  const growth = assessed.dimensions.flatMap(d => d.metrics).find(m => m.id === "revenue-growth");
  assert.ok(growth);
  assert.equal(growth.current.value, 40 / 130 * 100);
  assert.equal(growth.current.resolved.periodEnd, CURRENT);
  assert.deepEqual(growth.series.map(p => p.value), [100, 110, 120, 130].map(v => 40 / v * 100));
});

test("a missing quarter stays unresolved even with duplicated remaining quarters", () => {
  const remaining = data.quarters.filter(q => q.periodEnd !== "2025-08-03");
  const missing = { ...data, quarters: [...remaining, ...remaining] };
  assert.equal(resolveRef(missing, revenue, CURRENT, "fiscal_year"), null);
  assert.equal(resolveEvidence(missing, { ref: revenue, periodEnd: CURRENT, span: "quarter", compare: "qoq" }), null);
  const compiled = compileChart(chart, missing, CURRENT);
  assert.deepEqual(compiled.errors, []);
  assert.deepEqual(compiled.chart?.series[0].values, [140, 150, null, 170]);
});

test("the matching window remains bounded to twenty days", () => {
  const evidence = { ref: revenue, periodEnd: "2025-08-03", span: "quarter", compare: "qoq" } as const;
  const atBoundary = { ...data, quarters: [quarter("2025-08-03", 1), quarter("2025-04-10", 0)] };
  assert.ok(resolveEvidence(atBoundary, evidence));
  assert.equal(resolveEvidence({ ...atBoundary, quarters: [quarter("2025-08-03", 1), quarter("2025-04-09", 0)] }, evidence), null);
});

test("watch targets use the same nominal fiscal months", () => {
  assert.equal(watchPeriod("2025-08-03", { ref: revenue, condition: "Revenue grows", horizon: "next_quarter" }), "2025-10-31");
});
