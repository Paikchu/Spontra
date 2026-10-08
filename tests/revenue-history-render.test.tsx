import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { TrendPanel } from "../apps/business-site/src/TrendPanel";
import type { RevenueHistory } from "../shared/analysis-contract/revenue-history";
import type { GuidanceItem, GuidancePublication } from "../shared/analysis-contract/guidance";

const history: RevenueHistory = { schemaVersion: "revenue-history.v1", ticker: "X", updatedAt: "2026-10-04", quarters: Array.from({ length: 12 }, (_, i) => ({
  periodStart: new Date(Date.UTC(2023, 8 + i * 3, 1)).toISOString().slice(0, 10),
  periodEnd: new Date(Date.UTC(2023, 11 + i * 3, 0)).toISOString().slice(0, 10),
  currency: "USD", scale: 1, revenue: String(100 + i * 10), basis: "reported",
  segments: [{ id: "a", name: "A", value: String(100 + i * 10) }],
  source: { accession: "0000000001-26-000001", url: "https://www.sec.gov/Archives/edgar/data/1/a.htm", filedAt: "2026-09-11", form: "10-Q" },
})) };
const render = (value: RevenueHistory) => renderToStaticMarkup(<TrendPanel history={value} items={[]} selected={null} currentPeriod="2024-11-30" periods={new Set()} onPickPeriod={() => {}} hue={() => "#408aff"} />);

test("rendered trend keeps five bars but draws five YoY points with the hidden comparison year", () => {
  const html = render(history);
  assert.equal((html.match(/class="trend-col"/g) ?? []).length, 5);
  assert.equal((html.match(/class="trend-dot"/g) ?? []).length, 5);
  assert.equal((html.match(/class="trend-line"/g) ?? []).length, 4);
  assert.match(html, /近 5 季收入/);
  assert.match(html, /同比增速/);
  assert.match(html, /\+23\.5%/); // Latest quarter 210 versus 170, the first visible bar.
  assert.match(html, /2025\.08 以来/);
  assert.ok(!html.includes("2025.05"));
});

test("a recently listed company shows only the quarters it has disclosed", () => {
  const html = render({ ...history, quarters: history.quarters.slice(-3) });
  assert.equal((html.match(/class="trend-col"/g) ?? []).length, 3);
  assert.match(html, /近 3 季收入/);
  assert.match(html, /环比增速/); // No year-ago baseline, so the line reads quarter over quarter.
  assert.ok(!html.includes("trend-ghost"));
});

test("a missing baseline leaves just its point and adjoining line segments absent", () => {
  const html = render({ ...history, quarters: history.quarters.filter((_, i) => i !== 4) });
  assert.equal((html.match(/class="trend-col"/g) ?? []).length, 5);
  assert.equal((html.match(/class="trend-dot"/g) ?? []).length, 4);
  assert.equal((html.match(/class="trend-line"/g) ?? []).length, 2);
});

test("partial growth coverage is explained without drawing missing comparisons", () => {
  const html = render({ ...history, quarters: history.quarters.filter((_, i) => i !== 4) });
  assert.match(html, /4\/5 季可比/);
  assert.match(html, /部分季度缺少本期或比较期的同口径收入，增速留空/);
  assert.ok(!render(history).includes("季可比"));
});

test("million-unit actuals and dollar guidance share the same rendered amounts and chart scale", () => {
  const item: GuidanceItem = { id: "guide", metric: "revenue", measure: "amount", segment: null, label: "Revenue", basis: "gaap", horizon: "quarter", form: "range", fiscalYear: 2026, fiscalQuarter: 4, periodEnd: history.quarters.at(-1)!.periodEnd, unit: "USD", low: 200e6, high: 220e6, direction: null, derived: null, actual: null, text: "收入指引", quote: "$200 million to $220 million", sourceIds: [], issuedAt: "2026-06-01", action: null, previous: null };
  const guidance: GuidancePublication = { schemaVersion: "guidance.v1", ticker: "X", updatedAt: "2026-10-04", items: [item, { ...item, id: "annual", horizon: "annual", fiscalQuarter: null, low: 800e6, high: 900e6 }], sources: [], coverage: [] };
  const value = { ...history, quarters: history.quarters.map(q => ({ ...q, scale: 1_000_000 })) };
  const props = { items: [], selected: null, currentPeriod: null, periods: new Set<string>(), onPickPeriod: () => {}, hue: () => "#408aff", guidance };
  const html = renderToStaticMarkup(<TrendPanel {...props} history={value} />);
  assert.ok(html.includes("$210M"));
  assert.ok(html.includes("指引 $200M–$220M"));
  assert.ok(html.includes("$800M–$900M"));
  assert.match(html, /class="trend-guide"[^>]*bottom:66\.666/);
  const euro = renderToStaticMarkup(<TrendPanel {...props} history={{ ...value, quarters: value.quarters.map(q => ({ ...q, currency: "EUR" })) }} />);
  assert.ok(!euro.includes('class="trend-guide"'));
  assert.ok(euro.includes("$800M–$900M"));
});
