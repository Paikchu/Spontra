import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseQuarter } from "../../../shared/analysis-runtime/financial-data/earnings-release.ts";
import type { BusinessFlowQuarter, BusinessSegment, FlowAmount } from "../../../shared/analysis-contract/business-flow.ts";

// The prior-quarter rule is about amounts in one table, so these releases are synthetic and belong to different
// issuers. None of the names, scales, or column layouts below is taken from a single company.
const filing = "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/10q.htm";
const releaseUrl = "https://www.sec.gov/Archives/edgar/data/1/000000000126000002/ex99.htm";
const dollars = (millions: number) => Math.round(millions * 1e6);
const figures = (revenue: number) => {
  const cost = 50, research = 20, sales = 10, other = 2, tax = 5;
  const gross = revenue - cost, operating = gross - research - sales, pretax = operating + other, net = pretax - tax;
  return { revenue, cost, gross, research, sales, operating, other, pretax, tax, net };
};
const amount = (value: number, key: string, basis: FlowAmount["basis"] = "reported"): FlowAmount => ({
  value: String(value), basis, definition: key, comparabilityKey: `k:${key}`, sourceIds: ["A"],
  ...(basis === "derived" ? { formula: "f" } : {}),
  lineage: [{ accession: "A", url: filing, concept: key, contextId: "c", periodStart: "2026-04-01", periodEnd: "2026-06-30", dimensions: {}, parserVersion: "v" }],
});
type Child = { id: string; name: string; millions: number };
type Segment = { id: string; name: string; millions: number; children?: Child[] };
const previousQuarter = (segments: Segment[]): BusinessFlowQuarter => {
  const segment = (s: Segment): BusinessSegment => ({
    id: s.id, name: s.name, revenue: amount(dollars(s.millions), `seg:${s.id}`), description: "", products: (s.children ?? []).map(c => c.name),
    customers: null, monetization: null, disclosure: "", sourceIds: ["A"],
    ...(s.children ? { children: s.children.map(c => ({ id: c.id, name: c.name, revenue: amount(dollars(c.millions), `seg:${c.id}`) })) } : {}),
  });
  const f = figures(segments.reduce((sum, s) => sum + dollars(s.millions), 0) / 1e6);
  const value = (n: number) => dollars(n);
  return {
    id: "2026-06-30", incomeModel: "standard", label: "Q", periodStart: "2026-04-01", periodEnd: "2026-06-30", periodType: "3M",
    currency: "USD", scale: 1, basisLabel: "b", reportedAt: null,
    figures: {
      revenue: amount(value(f.revenue), "revenue"), cost: amount(value(f.cost), "cost"), gross: amount(value(f.gross), "gross"),
      operatingExpenses: amount(value(f.research + f.sales), "operatingExpenses", "derived"), operating: amount(value(f.operating), "operating"),
      other: amount(value(f.other), "other", "derived"), pretax: amount(value(f.pretax), "pretax"), tax: amount(value(f.tax), "tax"),
      net: amount(value(f.net), "net"), research: amount(value(f.research), "research"),
    },
    expenseComponents: [
      { id: "ResearchAndDevelopmentExpense", name: "Research and development", group: "research", amount: amount(value(f.research), "rd") },
      { id: "SellingGeneralAndAdministrativeExpense", name: "Selling, general and administrative", group: "other", amount: amount(value(f.sales), "sga") },
    ],
    otherComponents: [{ id: "reported-net-other", name: "Other income (expense), net", amount: amount(value(f.other), "other", "derived") }],
    segments: segments.map(segment), segmentsComplete: true,
    sources: [{ id: "A", title: "10-Q", url: filing, publishedAt: "2026-08-01" }],
  };
};
const line = (label: string, values: number[]) => `<tr><td>${label}</td>${values.map(v => `<td>$</td><td>${v}</td>`).join("")}</tr>`;
const statement = (revenue: number) => {
  const f = figures(revenue);
  return `<p>CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS (In millions)</p><table>
    <tr><td></td><td colspan="2">Three Months Ended September 30, 2026</td><td colspan="2">Three Months Ended September 30, 2025</td></tr>
    ${line("Total revenue", [f.revenue, f.revenue])}${line("Cost of revenue", [f.cost, f.cost])}${line("Gross profit", [f.gross, f.gross])}
    ${line("Research and development", [f.research, f.research])}${line("Selling, general and administrative", [f.sales, f.sales])}
    ${line("Operating income", [f.operating, f.operating])}${line("Other income (expense), net", [f.other, f.other])}
    ${line("Income before income taxes", [f.pretax, f.pretax])}${line("Provision for income taxes", [f.tax, f.tax])}${line("Net income", [f.net, f.net])}</table>`;
};
type Printed = { label: string; current: number; prior?: number };
const segmentTable = (unit: "millions" | "thousands", rows: Printed[], prior: "previous" | "year-ago" | "none", extras = "") => {
  const ends = ["September 30, 2026", ...(prior === "previous" ? ["June 30, 2026"] : prior === "year-ago" ? ["September 30, 2025"] : [])];
  const body = rows.map(r => line(r.label, prior === "none" ? [r.current] : [r.current, r.prior ?? 0])).join("");
  return `<p>Segment revenue (In ${unit})</p><table>
    <tr><td></td>${ends.map(end => `<td colspan="2">Three Months Ended ${end}</td>`).join("")}</tr>
    ${body}${extras}</table>`;
};
const read = (html: string, previous: BusinessFlowQuarter) => releaseQuarter([{ url: releaseUrl, html }], previous, { accession: "B", filedAt: "2026-10-20", parserVersion: "v" });
const split = (result: { quarter: BusinessFlowQuarter | null; issues: string[] }) => result.quarter!.segments.map(s => ({
  id: s.id, name: s.name, millions: Number(s.revenue!.value) / 1e6,
  children: s.children?.map(c => [c.id, Number(c.revenue.value) / 1e6]),
  key: s.revenue!.comparabilityKey,
}));

test("a renamed segment is bound by its prior-quarter amount, and its parts stay attached by name", () => {
  const previous = previousQuarter([
    { id: "nw:platforms", name: "Platforms", millions: 400, children: [{ id: "nw:subscriptions", name: "Subscriptions", millions: 250 }, { id: "nw:licenses", name: "Licenses", millions: 150 }] },
    { id: "nw:services", name: "Services", millions: 250 },
  ]);
  const rows: Printed[] = [
    { label: "Subscriptions", current: 300, prior: 250 }, { label: "Licenses", current: 180, prior: 150 },
    { label: "Product Platforms", current: 480, prior: 400 }, { label: "Managed Services", current: 320, prior: 250 },
    { label: "Total", current: 800, prior: 650 },
  ];
  // The old names survive only under operating income, and the revenue block is printed twice. Neither may change the bind.
  const operating = `<tr><td>Income from operations</td></tr>${line("Platforms", [90, 70])}${line("Services", [40, 30])}`;
  const html = `${statement(800)}${segmentTable("millions", rows, "previous", operating)}${segmentTable("millions", rows, "previous")}`;
  const result = read(html, previous);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(split(result), [
    { id: "nw:platforms", name: "Platforms", millions: 480, children: [["nw:subscriptions", 300], ["nw:licenses", 180]], key: "k:seg:nw:platforms" },
    { id: "nw:services", name: "Services", millions: 320, children: undefined, key: "k:seg:nw:services" },
  ]);
  assert.deepEqual(result.quarter!.segments[0]!.children!.map(c => c.revenue.comparabilityKey), ["k:seg:nw:subscriptions", "k:seg:nw:licenses"]);
});

test("an unquoted abbreviation is bound by its prior-quarter amount, in a table stated in thousands", () => {
  const previous = previousQuarter([{ id: "hb:logistics", name: "Integrated Logistics", millions: 120 }, { id: "hb:passenger", name: "Passenger Network", millions: 80 }]);
  const rows = [{ label: "IL", current: 140_000, prior: 120_000 }, { label: "PN", current: 95_000, prior: 80_000 }, { label: "Total", current: 235_000, prior: 200_000 }];
  const result = read(`${statement(235)}${segmentTable("thousands", rows, "previous")}`, previous);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(split(result).map(s => [s.id, s.name, s.millions]), [["hb:logistics", "Integrated Logistics", 140], ["hb:passenger", "Passenger Network", 95]]);
});

test("unchanged names still bind when the prior-quarter amounts are equal", () => {
  const previous = previousQuarter([{ id: "kp:orbit", name: "Orbit", millions: 100 }, { id: "kp:ground", name: "Ground", millions: 100 }]);
  const rows = [{ label: "Orbit", current: 140, prior: 100 }, { label: "Ground", current: 160, prior: 100 }, { label: "Total", current: 300, prior: 200 }];
  const result = read(`${statement(300)}${segmentTable("millions", rows, "previous")}`, previous);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(split(result).map(s => [s.id, s.millions]), [["kp:orbit", 140], ["kp:ground", 160]]);
});

test("two renamed segments with the same prior-quarter amount are not bound", () => {
  const previous = previousQuarter([{ id: "ae:north", name: "North Region", millions: 100 }, { id: "ae:south", name: "South Region", millions: 100 }]);
  const rows = [{ label: "Region One", current: 120, prior: 100 }, { label: "Region Two", current: 180, prior: 100 }, { label: "Total", current: 300, prior: 200 }];
  const result = read(`${statement(300)}${segmentTable("millions", rows, "previous")}`, previous);
  assert.deepEqual(result.issues, ["RELEASE_SEGMENT_MATCH_AMBIGUOUS"]);
  assert.deepEqual(result.quarter!.segments.map(s => s.id), ["reported-company-total"]);
});

test("two different prior-quarter bindings of the same segments are not bound", () => {
  const previous = previousQuarter([{ id: "mb:red", name: "Red", millions: 100 }, { id: "mb:blue", name: "Blue", millions: 200 }]);
  const first = [{ label: "Crimson", current: 140, prior: 100 }, { label: "Azure", current: 160, prior: 200 }, { label: "Total", current: 300, prior: 300 }];
  const second = [{ label: "Crimson", current: 150, prior: 100 }, { label: "Azure", current: 150, prior: 200 }, { label: "Total", current: 300, prior: 300 }];
  const result = read(`${statement(300)}${segmentTable("millions", first, "previous")}${segmentTable("millions", second, "previous")}`, previous);
  assert.deepEqual(result.issues, ["RELEASE_SEGMENT_MATCH_AMBIGUOUS"]);
  assert.deepEqual(result.quarter!.segments.map(s => s.id), ["reported-company-total"]);
});

test("a segment split that still adds up to revenue is not bound", () => {
  const previous = previousQuarter([{ id: "sp:alpha", name: "Alpha", millions: 300 }, { id: "sp:beta", name: "Beta", millions: 100 }]);
  const rows = [
    { label: "Alpha East", current: 200, prior: 180 }, { label: "Alpha West", current: 150, prior: 120 },
    { label: "Beta Group", current: 110, prior: 100 }, { label: "Total", current: 460, prior: 400 },
  ];
  const result = read(`${statement(460)}${segmentTable("millions", rows, "previous")}`, previous);
  assert.deepEqual(result.issues, ["RELEASE_SEGMENT_COUNT_CHANGED"]);
  assert.deepEqual(result.quarter!.segments.map(s => s.id), ["reported-company-total"]);
});

test("a segment merge that still adds up to revenue is not bound", () => {
  const previous = previousQuarter([{ id: "mg:alpha", name: "Alpha", millions: 100 }, { id: "mg:beta", name: "Beta", millions: 200 }, { id: "mg:gamma", name: "Gamma", millions: 300 }]);
  const rows = [{ label: "Alpha and Beta", current: 350, prior: 300 }, { label: "Gamma Unit", current: 400, prior: 300 }, { label: "Total", current: 750, prior: 600 }];
  const result = read(`${statement(750)}${segmentTable("millions", rows, "previous")}`, previous);
  assert.deepEqual(result.issues, ["RELEASE_SEGMENT_COUNT_CHANGED"]);
  assert.deepEqual(result.quarter!.segments.map(s => s.id), ["reported-company-total"]);
});

test("a prior-quarter amount within half a printed unit still binds the renamed row", () => {
  const previous = previousQuarter([{ id: "rd:first", name: "First", millions: 100.5 }, { id: "rd:second", name: "Second", millions: 200.5 }]);
  const rows = [{ label: "New First", current: 150, prior: 100 }, { label: "New Second", current: 250, prior: 201 }, { label: "Total", current: 400, prior: 301 }];
  const result = read(`${statement(400)}${segmentTable("millions", rows, "previous")}`, previous);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(split(result).map(s => [s.id, s.name, s.millions]), [["rd:first", "First", 150], ["rd:second", "Second", 250]]);
});

test("a prior-quarter amount beyond half a printed unit does not bind, even when the rounded lines still add up", () => {
  const previous = previousQuarter([{ id: "rd:first", name: "First", millions: 100.5 }, { id: "rd:second", name: "Second", millions: 200.5 }]);
  const rows = [{ label: "New First", current: 150, prior: 99 }, { label: "New Second", current: 250, prior: 202 }, { label: "Total", current: 400, prior: 301 }];
  const result = read(`${statement(400)}${segmentTable("millions", rows, "previous")}`, previous);
  assert.deepEqual(result.issues, ["RELEASE_SEGMENT_MATCH_AMBIGUOUS"]);
  assert.deepEqual(result.quarter!.segments.map(s => s.id), ["reported-company-total"]);
});

test("renamed rows whose current amounts do not add up to revenue are not bound", () => {
  const previous = previousQuarter([{ id: "sm:one", name: "One", millions: 400 }, { id: "sm:two", name: "Two", millions: 250 }]);
  const rows = [{ label: "Unit One", current: 480, prior: 400 }, { label: "Unit Two", current: 320, prior: 250 }, { label: "Total", current: 800, prior: 650 }];
  const result = read(`${statement(900)}${segmentTable("millions", rows, "previous")}`, previous);
  assert.deepEqual(result.issues, ["RELEASE_SEGMENT_SUM_MISMATCH"]);
  assert.equal(Number(result.quarter!.figures.revenue!.value), dollars(900));
  assert.deepEqual(result.quarter!.segments.map(s => s.id), ["reported-company-total"]);
});

test("a rename is not bound when the table has no previous-quarter column", () => {
  const previous = previousQuarter([{ id: "np:desk", name: "Desk", millions: 400 }, { id: "np:field", name: "Field", millions: 250 }]);
  const rows = [{ label: "Workspace", current: 480, prior: 400 }, { label: "Field Ops", current: 320, prior: 250 }];
  const onlyCurrent = read(`${statement(800)}${segmentTable("millions", rows, "none")}`, previous);
  assert.deepEqual(onlyCurrent.issues, ["RELEASE_SEGMENTS_NOT_FOUND"]);
  assert.deepEqual(onlyCurrent.quarter!.segments.map(s => s.id), ["reported-company-total"]);
  // A year-ago column that repeats the verified amounts is still not the previous quarter.
  const yearAgo = read(`${statement(800)}${segmentTable("millions", rows, "year-ago")}`, previous);
  assert.deepEqual(yearAgo.issues, ["RELEASE_SEGMENTS_NOT_FOUND"]);
  assert.deepEqual(yearAgo.quarter!.segments.map(s => s.id), ["reported-company-total"]);
});
