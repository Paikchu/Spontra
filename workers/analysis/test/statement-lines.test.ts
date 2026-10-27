import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDisclosedQuarters, type DocumentSource } from "../src/financial-data/parser.ts";
import { mergeHistory } from "../../../shared/analysis-runtime/financial-data/history.ts";
import type { RevenueHistoryQuarter } from "../../../shared/analysis-contract/revenue-history.ts";

// Synthetic statements: the rules read the statement's own arithmetic, so no name or amount below is any issuer's.
const source: DocumentSource = { url: "https://www.sec.gov/Archives/edgar/data/1/000000000126000002/ex99.htm", accession: "0000000001-26-000002", filedAt: "2026-09-10", cik: "0000000001", industry: "standard" };
const line = (label: string, values: number[]) => `<tr><td>${label}</td>${values.map(v => `<td>$</td><td>${v}</td>`).join("")}</tr>`;
const heading = (label: string) => `<tr><td>${label}</td><td></td><td></td><td></td><td></td></tr>`;
const statement = (rows: string) => `<p>CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS ($ in millions)</p><table>
  <tr><td></td><td colspan="2">Three Months Ended August 31, 2026</td><td colspan="2">Three Months Ended August 31, 2025</td></tr>${rows}</table>`;

test("a statement without cost of revenue splits revenue by its printed lines and draws its direct costs", () => {
  const html = statement([
    heading("REVENUES"), line("Platform", [600, 500]), line("Licenses", [300, 280]), line("Support", [100, 120]), line("Total revenues", [1000, 900]),
    heading("OPERATING EXPENSES"), line("Platform and licenses", [250, 220]), line("Support", [60, 70]), line("Sales and marketing", [150, 140]),
    line("Research and development", [200, 190]), line("General and administrative", [40, 30]), line("Total operating expenses", [700, 650]),
    line("OPERATING INCOME", [300, 250]), line("Interest expense", [-20, -20]), line("INCOME BEFORE INCOME TAXES", [280, 230]),
    line("Provision for income taxes", [50, 40]), line("NET INCOME", [230, 190]),
  ].join(""));
  const [current] = extractDisclosedQuarters(html, source).quarters;
  assert.ok(current);
  assert.equal(current.periodEnd, "2026-08-31");
  assert.equal(current.incomeModel, "direct_operating");
  assert.deepEqual(current.segments.map(s => [s.name, s.revenue.value]), [["Platform", "600000000"], ["Licenses", "300000000"], ["Support", "100000000"]]);
  assert.deepEqual(current.expenseComponents?.map(e => [e.name, e.group]), [
    ["Platform and licenses", "direct"], ["Support", "direct"], ["Sales and marketing", "sales"], ["Research and development", "research"], ["General and administrative", "administration"],
  ]);
  assert.equal(current.figures.operatingExpenses?.value, "700000000");
});

test("lines that do not add up to the revenue total are not read as a split", () => {
  const html = statement([
    heading("REVENUES"), line("Platform", [600, 500]), line("Licenses", [300, 280]), line("Total revenues", [1000, 900]),
    line("Total operating expenses", [700, 650]), line("OPERATING INCOME", [300, 250]), line("INCOME BEFORE INCOME TAXES", [300, 250]),
    line("Provision for income taxes", [50, 40]), line("NET INCOME", [250, 210]),
  ].join(""));
  const [current] = extractDisclosedQuarters(html, source).quarters;
  assert.equal(current?.segments.length, 1);
  assert.equal(current?.segments[0]?.id, "reported-company-total");
});

const quarter = (periodEnd: string, form: string, names: string[], filedAt: string): RevenueHistoryQuarter => {
  const value = 100 * names.length;
  return {
    periodStart: new Date(Date.parse(periodEnd) - 90 * 86_400_000).toISOString().slice(0, 10), periodEnd, currency: "USD", scale: 1, revenue: String(value), basis: "reported",
    segments: names.map(name => ({ id: name, name, value: "100" })),
    source: { accession: `0000000001-${filedAt.slice(2, 4)}-${filedAt.slice(5, 7)}${filedAt.slice(8, 10)}${form === "8-K" ? "08" : "10"}`, url: "https://www.sec.gov/x.htm", filedAt, form },
  };
};

test("a release's lines stand only where a neighbouring periodic report splits revenue the same way", () => {
  const history = mergeHistory("ACME", [], [
    quarter("2026-03-31", "10-Q", ["East", "West"], "2026-05-01"),
    quarter("2026-06-30", "8-K", ["Products", "Services"], "2026-07-30"),
    quarter("2026-09-30", "10-Q", ["East", "West"], "2026-11-01"),
    quarter("2026-12-31", "8-K", ["East", "West"], "2027-01-30"),
  ], "2027-02-01T00:00:00Z");
  const byEnd = new Map(history.quarters.map(q => [q.periodEnd, q.segments.map(s => s.name)]));
  assert.deepEqual(byEnd.get("2026-06-30"), ["Total company (segment split not yet verified)"]);
  assert.deepEqual(byEnd.get("2026-12-31"), ["East", "West"]);
});

test("a release at a change of presentation keeps the split of the report on its side", () => {
  const history = mergeHistory("ACME", [], [
    quarter("2026-02-28", "10-Q", ["Old A", "Old B"], "2026-03-30"),
    quarter("2026-05-31", "8-K", ["Old A", "Old B"], "2026-06-20"),
    quarter("2026-08-31", "10-Q", ["New A", "New B"], "2026-09-30"),
  ], "2026-10-01T00:00:00Z");
  assert.deepEqual(history.quarters.find(q => q.periodEnd === "2026-05-31")?.segments.map(s => s.name), ["Old A", "Old B"]);
});
