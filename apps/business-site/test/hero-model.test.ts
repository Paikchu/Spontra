import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlowQuarter, FlowMetric } from "../../../shared/analysis-contract/business-flow.ts";
import type { FindingRef, FindingsPublication, ReportHighlights } from "../../../shared/analysis-contract/findings.ts";
import { resolveEvidence, type FindingData } from "../../../shared/analysis-runtime/findings.ts";
import { goodWhen, heroTiles, heroTone } from "../src/hero-model.ts";

const ENDS = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];
const PERIOD = ENDS.at(-1)!;
const amount = (v: number) => ({ value: String(v), basis: "reported" as const, definition: "", comparabilityKey: null, sourceIds: ["s1"] });

/** Revenue grows every quarter; the newest quarter's costs jump, so operating income and its margin fall year over year. */
function quarter(end: string, i: number, over: Partial<Record<FlowMetric, number>> = {}): BusinessFlowQuarter {
  const revenue = 100 + i * 5, newest = i === ENDS.length - 1;
  const operatingExpenses = newest ? revenue * 0.5 : revenue * 0.3, gross = revenue * 0.6, operating = gross - operatingExpenses;
  const values: Partial<Record<FlowMetric, number>> = { revenue, cost: revenue * 0.4, gross, operatingExpenses, operating, pretax: operating, net: operating * 0.8, ...over };
  return {
    id: end, label: end, periodStart: null, periodEnd: end, periodType: "3M", currency: "USD", scale: 1e6, basisLabel: "", reportedAt: null,
    figures: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, amount(v!)])),
    segments: [], segmentsComplete: true, sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", publishedAt: null } as BusinessFlowQuarter["sources"][number]],
  } as BusinessFlowQuarter;
}
const data = (over: Partial<Record<FlowMetric, number>> = {}): FindingData => ({ quarters: ENDS.map((end, i) => quarter(end, i, i === ENDS.length - 1 ? over : {})), history: null, capital: null, fundamentals: null, guidance: null });
const margin = (metric: FlowMetric): FindingRef => ({ ratio: { numerator: { metric }, denominator: { metric: "revenue" } } });
const publication = (profit: ReportHighlights["profit"]): FindingsPublication => ({ highlights: [{ periodEnd: PERIOD, profit, cash: [], balance: [] }] } as unknown as FindingsPublication);

test("U25: a figure's good direction: revenue, profit and margins up; costs, expenses, debt and cost intensity down; capex neither", () => {
  for (const ref of [{ metric: "revenue" }, { metric: "net" }, margin("operating"), { capital: "freeCashFlow" }] as FindingRef[]) assert.equal(goodWhen(ref), "up", JSON.stringify(ref));
  for (const ref of [{ metric: "cost" }, { metric: "operatingExpenses" }, { metric: "research" }, { capital: "debt" }, { derived: "netDebt" }, margin("operatingExpenses"), { ratio: { numerator: { capital: "debt" }, denominator: { capital: "equity" } } }] as FindingRef[]) assert.equal(goodWhen(ref), "down", JSON.stringify(ref));
  for (const ref of [{ capital: "capex" }, { capital: "financing" }, { capital: "totalAssets" }, { ratio: { numerator: { capital: "capex" }, denominator: { metric: "revenue" } } }] as FindingRef[]) assert.equal(goodWhen(ref), null, JSON.stringify(ref));
});

test("U25: the tone follows the figure's direction: falling expenses are good news, a contracting margin bad", () => {
  const d = data();
  const at = (ref: FindingRef) => resolveEvidence(d, { ref, periodEnd: PERIOD, span: "quarter", compare: "yoy" })!;
  assert.equal(heroTone({ metric: "revenue" }, at({ metric: "revenue" })), "good");
  assert.equal(heroTone(margin("operating"), at(margin("operating"))), "bad");
  assert.equal(heroTone({ metric: "operatingExpenses" }, at({ metric: "operatingExpenses" })), "bad");
  // Expenses that fell year over year read as good news.
  const lean = data({ operatingExpenses: 20 });
  assert.equal(heroTone({ metric: "operatingExpenses" }, resolveEvidence(lean, { ref: { metric: "operatingExpenses" }, periodEnd: PERIOD, span: "quarter", compare: "yoy" })!), "good");
  // A level with no comparison is bad news only as a loss.
  const loss = data({ net: -5 });
  assert.equal(heroTone({ metric: "net" }, resolveEvidence(loss, { ref: { metric: "net" }, periodEnd: PERIOD, span: "quarter" })!), "bad");
  // A figure that reads neither way, or a positive level with no comparison, stays untoned.
  assert.equal(heroTone({ metric: "revenue" }, resolveEvidence(d, { ref: { metric: "revenue" }, periodEnd: PERIOD, span: "quarter" })!), undefined);
});

test("U25: when the model picked only good news, the worst material adverse move takes the last tile", () => {
  const picks: ReportHighlights["profit"] = [
    { title: "Revenue", ref: { metric: "revenue" }, compare: "yoy", show: "change" },
    { title: "Gross profit", ref: { metric: "gross" }, compare: "yoy" },
    { title: "Gross margin", ref: margin("gross"), compare: "yoy" },
  ];
  const tiles = heroTiles(publication(picks), data(), PERIOD, "profit", "en")!;
  assert.equal(tiles.length, 3);
  assert.deepEqual(tiles.slice(0, 2).map(t => [t.title, t.tone]), [["Revenue", "good"], ["Gross profit", "good"]]);
  assert.ok(!tiles.some(t => t.title === "Gross margin"), "the flat margin gave way");
  const bad = tiles[2]!;
  assert.equal(bad.tone, "bad");
  // The operating margin fell twenty points (operating income about half): the largest adverse move, shown as its change.
  assert.deepEqual(bad.ref, margin("operating"));
  assert.equal(bad.show, "change");
  assert.ok(Math.abs(bad.resolved.delta! + 0.2) < 1e-9, String(bad.resolved.delta));
});

test("U25: two verified picks gain the bad news as a third tile; picks that already carry bad news stay as they are", () => {
  const two = heroTiles(publication([{ title: "Revenue", ref: { metric: "revenue" }, compare: "yoy" }, { title: "Gross profit", ref: { metric: "gross" }, compare: "yoy" }]), data(), PERIOD, "profit", "en")!;
  assert.equal(two.length, 3);
  assert.equal(two[2]!.tone, "bad");
  const mixed = [{ title: "Revenue", ref: { metric: "revenue" }, compare: "yoy" }, { title: "Operating margin", ref: margin("operating"), compare: "yoy", show: "change" }] as ReportHighlights["profit"];
  assert.deepEqual(heroTiles(publication(mixed), data(), PERIOD, "profit", "en")!.map(t => [t.title, t.tone]), [["Revenue", "good"], ["Operating margin", "bad"]]);
});

test("U25: a quarter with no material bad news keeps the model's picks; too few picks keep the fixed tiles", () => {
  // Expenses as a share of revenue unchanged: every line grows with revenue.
  const steady = data({ operatingExpenses: 125 * 0.3, operating: 125 * 0.3, pretax: 125 * 0.3, net: 125 * 0.24 });
  const picks: ReportHighlights["profit"] = [{ title: "Revenue", ref: { metric: "revenue" }, compare: "yoy" }, { title: "Net income", ref: { metric: "net" }, compare: "yoy" }];
  assert.deepEqual(heroTiles(publication(picks), steady, PERIOD, "profit", "en")!.map(t => [t.title, t.tone]), [["Revenue", "good"], ["Net income", "good"]]);
  assert.equal(heroTiles(publication(picks.slice(0, 1)), data(), PERIOD, "profit", "en"), null);
  assert.equal(heroTiles(null, data(), PERIOD, "profit", "en"), null);
});
