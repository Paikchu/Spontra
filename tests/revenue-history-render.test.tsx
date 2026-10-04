import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { TrendPanel } from "../apps/business-site/src/TrendPanel";
import type { RevenueHistory } from "../shared/analysis-contract/revenue-history";

const history: RevenueHistory = { schemaVersion: "revenue-history.v1", ticker: "X", updatedAt: "2026-10-04", quarters: Array.from({ length: 12 }, (_, i) => ({
  periodStart: new Date(Date.UTC(2023, 8 + i * 3, 1)).toISOString().slice(0, 10),
  periodEnd: new Date(Date.UTC(2023, 11 + i * 3, 0)).toISOString().slice(0, 10),
  currency: "USD", scale: 1, revenue: String(100 + i * 10), basis: "reported",
  segments: [{ id: "a", name: "A", value: String(100 + i * 10) }],
  source: { accession: "0000000001-26-000001", url: "https://www.sec.gov/Archives/edgar/data/1/a.htm", filedAt: "2026-09-11", form: "10-Q" },
})) };
const render = (value: RevenueHistory) => renderToStaticMarkup(<TrendPanel history={value} items={[]} selected={null} currentPeriod="2024-11-30" periods={new Set()} onPickPeriod={() => {}} hue={() => "#408aff"} />);

test("rendered trend keeps eight bars but draws eight YoY points with the hidden comparison year", () => {
  const html = render(history);
  assert.equal((html.match(/class="trend-col"/g) ?? []).length, 8);
  assert.equal((html.match(/class="trend-dot"/g) ?? []).length, 8);
  assert.equal((html.match(/class="trend-line"/g) ?? []).length, 7);
  assert.match(html, /同比增速/);
  assert.match(html, /\+40\.0%/); // First visible quarter: 140 versus the hidden 100 baseline.
  assert.match(html, /2024\.11 以来/);
  assert.ok(!html.includes("2023.11"));
});

test("a missing baseline leaves just its point and adjoining line segments absent", () => {
  const html = render({ ...history, quarters: history.quarters.filter((_, i) => i !== 1) });
  assert.equal((html.match(/class="trend-col"/g) ?? []).length, 8);
  assert.equal((html.match(/class="trend-dot"/g) ?? []).length, 7);
  assert.equal((html.match(/class="trend-line"/g) ?? []).length, 5);
});
