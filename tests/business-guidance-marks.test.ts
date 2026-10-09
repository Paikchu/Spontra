import test from "node:test";
import assert from "node:assert/strict";
import { guidanceMarks, nodeForGuidance, pillText } from "../apps/business-site/src/guidance-marks";
import type { GuidanceItem, GuidancePublication } from "../shared/analysis-contract/guidance";
import { businessFlowFixture } from "./fixtures/business-flow-fixture";
import { numeric } from "../lib/earning-report/web/business-flow-model";

const [q4] = businessFlowFixture.quarters;
const revenue = numeric(q4.figures.revenue)! * q4.scale;
const item = (over: Partial<GuidanceItem>): GuidanceItem => ({
  id: over.id ?? Math.random().toString(36).slice(2), metric: "revenue", measure: "amount", segment: null, label: "Total revenues", basis: "gaap", horizon: "quarter", form: "range",
  fiscalYear: 2026, fiscalQuarter: 4, periodEnd: q4.periodEnd, unit: "USD", low: null, high: null, direction: null, derived: null, actual: null,
  text: "", quote: "We expect total revenues to grow.", sourceIds: ["s1"], issuedAt: "2026-03-10T00:00:00Z", action: "initiated", previous: null, ...over,
});
const publication = (items: GuidanceItem[]): GuidancePublication => ({ schemaVersion: "guidance.v1", ticker: "T", updatedAt: "", items, sources: [{ id: "s1", kind: "press_release", sourceKind: "sec", title: "Q4 release", url: "https://example.com/q4", publishedAt: "2026-03-10" }], coverage: [] });
const nodes = ["revenue", "segment:cloud", "operating", "gross", "cost"];
const options = { amountOf: (n: string) => n === "revenue" ? numeric(q4.figures.revenue) : n === "operating" ? numeric(q4.figures.operating) : null, businessIdOf: (n: string) => n === "segment:cloud" ? "CloudServices" : null, money: (v: number) => `$${(v / 1e9).toFixed(1)}B` };
const next = new Date(Date.parse(q4.periodEnd) + 91 * 86_400_000).toISOString().slice(0, 10);

test("guidance maps to the lines the statement draws and nothing else", () => {
  const set = new Set(nodes);
  assert.equal(nodeForGuidance(item({}), set, options.businessIdOf), "revenue");
  assert.equal(nodeForGuidance(item({ metric: "segment_revenue", segment: "Cloud services" }), set, options.businessIdOf), "segment:cloud");
  assert.equal(nodeForGuidance(item({ metric: "segment_revenue", segment: "Hardware" }), set, options.businessIdOf), null);
  assert.equal(nodeForGuidance(item({ metric: "operating_margin", measure: "margin", unit: "percent" }), set, options.businessIdOf), "operating");
  assert.equal(nodeForGuidance(item({ metric: "gross_margin", measure: "margin", unit: "percent" }), set, options.businessIdOf), "gross");
  for (const metric of ["eps", "capex", "free_cash_flow", "rpo"] as const) assert.equal(nodeForGuidance(item({ metric }), set, options.businessIdOf), null, metric);
  assert.equal(nodeForGuidance(item({ basis: "constant_currency" }), set, options.businessIdOf), null, "constant currency never reads against a reported bar");
});

test("this quarter's bracket is the latest dollar range guided for it, with the verdict read from the bar", () => {
  const items = [
    item({ id: "old", issuedAt: "2025-12-10T00:00:00Z", low: revenue * 1.2, high: revenue * 1.3 }),
    item({ id: "latest", low: revenue * 0.97, high: revenue * 0.99 }),
    item({ id: "cc", basis: "constant_currency", low: revenue * 0.5, high: revenue * 0.6 }),
    item({ id: "growth", metric: "revenue", measure: "growth", unit: "percent", low: 10, high: 12, derived: { low: revenue * 0.9, high: revenue * 1.1, basePeriodEnd: "2025-03-31", base: revenue * 0.9 }, issuedAt: "2026-02-01T00:00:00Z" }),
  ];
  const { brackets, pills } = guidanceMarks(q4, nodes, publication(items), options);
  assert.equal(brackets.length, 1);
  assert.equal(brackets[0].item.id, "latest", "the most recent range before the report wins");
  assert.equal(brackets[0].verdict, "above");
  assert.equal(brackets[0].derived, false);
  assert.equal(brackets[0].source?.title, "Q4 release");
  assert.deepEqual(pills, []);
  const within = guidanceMarks(q4, nodes, publication([item({ low: revenue * 0.98, high: revenue * 1.02 })]), options).brackets[0];
  assert.equal(within.verdict, "within");
  const derived = guidanceMarks(q4, nodes, publication([items[3]]), options).brackets[0];
  assert.equal(derived.derived, true);
  assert.equal(derived.verdict, "within");
  assert.equal(derived.low, revenue * 0.9);
  const rate = guidanceMarks(q4, nodes, publication([item({ metric: "operating_margin", measure: "margin", unit: "percent", low: 40, high: 42 })]), options);
  assert.deepEqual(rate.brackets, [], "a margin has no height on the bar");
  assert.deepEqual(guidanceMarks({ ...q4, currency: "EUR" }, nodes, publication(items), options).brackets, [], "dollar guidance never reads against another currency");
});

test("next quarter's pill comes from the latest event only, one per line, worded from its form", () => {
  const items = [
    item({ id: "n-rev", periodEnd: next, fiscalQuarter: 1, fiscalYear: 2027, measure: "growth", unit: "percent", low: 30, high: 34, action: "raised", previous: { low: 25, high: 29, issuedAt: "2025-12-10T00:00:00Z" }, issuedAt: "2026-03-10T00:00:00Z" }),
    item({ id: "n-rev-cc", periodEnd: next, basis: "constant_currency", measure: "growth", unit: "percent", low: 28, high: 32, issuedAt: "2026-03-10T00:00:00Z" }),
    item({ id: "n-cloud", periodEnd: next, metric: "segment_revenue", segment: "Cloud Services", measure: "growth", unit: "percent", low: 60, high: 65, issuedAt: "2026-03-10T00:00:00Z" }),
    item({ id: "n-margin", periodEnd: next, metric: "operating_margin", measure: "margin", unit: "percent", form: "floor", low: 44, high: null, issuedAt: "2026-03-10T00:00:00Z" }),
    item({ id: "stale", periodEnd: next, metric: "gross_margin", measure: "margin", unit: "percent", low: 70, high: 71, issuedAt: "2025-12-10T00:00:00Z" }),
    item({ id: "far", periodEnd: "2027-05-31", horizon: "annual", low: 90e9, high: 90e9, issuedAt: "2026-03-10T00:00:00Z" }),
  ];
  const { pills, brackets } = guidanceMarks(q4, nodes, publication(items), options);
  assert.deepEqual(brackets, []);
  assert.deepEqual(pills.map(p => [p.node, p.text, p.action]), [["revenue", "+30–34%", "raised"], ["segment:cloud", "+60–65%", "initiated"], ["operating", "≥ 44%", "initiated"]]);
  assert.equal(pills[0].item.previous?.low, 25);
  assert.equal(pillText(item({ low: 17.9e9, high: 18.1e9 }), options.money), "$17.9B–$18.1B");
  assert.equal(pillText(item({ form: "point", low: 90e9, high: 90e9 }), options.money), "$90.0B");
  assert.equal(pillText(item({ form: "qualitative", direction: "up" }), options.money), "预计上行");
  assert.equal(pillText(item({ measure: "growth", unit: "percent", form: "point", low: 18, high: 18 }), options.money), "+18%");
  assert.deepEqual(guidanceMarks(q4, nodes, null, options), { brackets: [], pills: [] });
});
