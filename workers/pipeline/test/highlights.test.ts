import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlowQuarter } from "../../../shared/analysis-contract/business-flow.ts";
import type { CapitalQuarter, CashFlowStatement } from "../../../shared/analysis-contract/capital-structure.ts";
import type { FindingsPublication, ReportHighlights } from "../../../shared/analysis-contract/findings.ts";
import { readFindingsPublication, resolveEvidence, type FindingData } from "../../../shared/analysis-runtime/findings.ts";
import { highlightChange, highlightsFor, plainTitle, refView, verifyHighlights } from "../../../shared/analysis-runtime/highlights.ts";
import { buildHighlightTable } from "../src/findings/ledger.ts";
import { mergeHighlights, writeHighlights } from "../src/findings/highlights.ts";

const ENDS = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];
const amount = (v: number) => ({ value: String(v), basis: "reported" as const, definition: "", comparabilityKey: null, sourceIds: ["s1"] });

function quarter(end: string, i: number): BusinessFlowQuarter {
  const revenue = 100 + i * 5, cloud = 40 + i * 4;
  return {
    id: end, label: end, periodStart: null, periodEnd: end, periodType: "3M", currency: "USD", scale: 1e6, basisLabel: "", reportedAt: null,
    figures: { revenue: amount(revenue), cost: amount(revenue * 0.4), gross: amount(revenue * 0.6), operating: amount(revenue * 0.3), net: amount(revenue * 0.2) },
    segments: [{ id: "cloud", name: "Cloud", revenue: amount(cloud), description: "", products: [], customers: null, monetization: null, disclosure: "", sourceIds: ["s1"] }],
    segmentsComplete: true, sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", publishedAt: null } as BusinessFlowQuarter["sources"][number]],
  };
}
const source = { accession: "0001", url: "https://www.sec.gov/x", filedAt: "2026-07-30", form: "10-Q" };
function cashFlow(end: string, capex: number): CashFlowStatement {
  return {
    periodStart: end, periodEnd: end, currency: "USD", basis: "reported",
    operating: { total: "30000000000", lines: null },
    investing: { total: String(-capex), lines: [{ id: "c", label: "Capex", concept: "x", group: "capex", value: String(-capex) }] },
    financing: { total: "-1000000000", lines: [] }, fxEffect: null, netChange: "0", supplemental: [], sources: [source],
  } as CashFlowStatement;
}
function capitalQuarter(end: string, i: number): CapitalQuarter {
  // Capex steady at $10 billion, then doubles in the newest quarter.
  return { periodEnd: end, cashFlow: cashFlow(end, i === 5 ? 20e9 : 10e9), yearToDate: null, balanceSheet: {
    asOf: end, currency: "USD", assets: [{ id: "cash", label: "Cash", concept: "x", group: "cash", value: "50000000000" }], liabilities: [{ id: "d", label: "Debt", concept: "x", group: "debt", value: String(20e9 + i * 1e9) }],
    equity: [], totals: { assets: "200000000000", liabilities: "80000000000", equity: "120000000000", currentAssets: null, currentLiabilities: null }, source,
  } };
}
const data: FindingData = { quarters: ENDS.map(quarter), history: null, capital: { schemaVersion: "capital-structure.v1", ticker: "TEST", quarters: ENDS.map(capitalQuarter) }, fundamentals: null, guidance: null };
const PERIOD = ENDS.at(-1)!;

test("figures belong to the statement they are reported on", () => {
  assert.equal(refView({ metric: "revenue" }), "profit");
  assert.equal(refView({ nodeId: "cloud" }), "profit");
  assert.equal(refView({ capital: "capex" }), "cash");
  assert.equal(refView({ capital: "debt" }), "balance");
  assert.equal(refView({ ratio: { numerator: { capital: "capex" }, denominator: { metric: "revenue" } } }), "cash");
  assert.equal(refView({ guidanceId: "g1" }), null);
});

test("the highlight table holds the newest quarter and the five before it, by view", () => {
  const rows = buildHighlightTable(data, PERIOD);
  const capex = rows.find(r => JSON.stringify(r.ref) === JSON.stringify({ capital: "capex" }))!;
  assert.equal(capex.view, "cash");
  assert.deepEqual(capex.quarters.map(q => q.value), ["$10 billion", "$10 billion", "$10 billion", "$10 billion", "$10 billion", "$20 billion"]);
  assert.equal(capex.yoy, "+100.0%");
  assert.ok(rows.some(r => r.view === "profit" && "nodeId" in r.ref));
  assert.ok(rows.some(r => r.view === "balance"));
});

test("verification keeps resolvable tiles on their own view and drops the rest", () => {
  const highlights: ReportHighlights = {
    periodEnd: PERIOD,
    profit: [{ ref: { nodeId: "cloud" }, title: "Cloud revenue growth", compare: "yoy", show: "change" }, { ref: { capital: "capex" }, title: "Capex" }],
    cash: [{ ref: { capital: "capex" }, title: "Capital expenditures", compare: "yoy" }, { ref: { capital: "capex" }, title: "Capex again" }, { ref: { capital: "freeCashFlow" }, title: "Free cash flow", show: "change" }],
    balance: [{ ref: { capital: "debt" }, title: "Total debt", compare: "qoq" }, { ref: { nodeId: "missing" }, title: "Nothing" }],
  };
  const { verified, withheld } = verifyHighlights(highlights, data);
  assert.deepEqual(verified.profit.map(h => h.title), ["Cloud revenue growth"]);
  assert.deepEqual(verified.cash.map(h => h.title), ["Capital expenditures"]);
  assert.deepEqual(verified.balance.map(h => h.title), ["Total debt"]);
  assert.deepEqual(withheld.map(w => `${w.view}:${w.index}`), ["profit:1", "cash:1", "cash:2", "balance:1"]);
  assert.ok(withheld.find(w => w.view === "cash" && w.index === 2)!.reasons.includes("change shown without a measurable change"));
  assert.equal(highlightChange(verified.cash[0].resolved), "+100%");
});

test("a title that states a number or dramatises the move falls back to the figure's plain name", () => {
  const highlights: ReportHighlights = {
    periodEnd: PERIOD,
    profit: [{ ref: { nodeId: "cloud" }, title: "Cloud infrastructure jumps", compare: "yoy", show: "change" }, { ref: { ratio: { numerator: { metric: "operating" }, denominator: { metric: "revenue" } } }, title: "Operating margin climbs", compare: "yoy" }],
    cash: [{ ref: { capital: "capex" }, title: "Capex up 100%", compare: "yoy" }, { ref: { capital: "freeCashFlow" }, title: "Free cash flow stays negative" }],
    balance: [{ ref: { capital: "debt" }, title: "Inventory turnover and holdings", compare: "qoq" }],
  };
  const { verified } = verifyHighlights(highlights, data);
  assert.deepEqual(verified.profit.map(h => h.title), ["Cloud growth", "Operating margin"]);
  assert.deepEqual(verified.cash.map(h => h.title), ["Capex", "Free cash flow"]);
  assert.deepEqual(verified.balance.map(h => h.title), ["Inventory turnover and holdings"]);
  assert.equal(plainTitle(verified.profit[1].resolved, "change"), "Operating margin change");
});

test("a view with fewer than two verified tiles keeps its fixed tiles", () => {
  const highlights: ReportHighlights = { periodEnd: PERIOD, profit: [{ ref: { metric: "revenue" }, title: "Total revenue", compare: "yoy" }], cash: [{ ref: { capital: "capex" }, title: "Capex surges", compare: "yoy" }, { ref: { capital: "operatingCashFlow" }, title: "Operating cash flow" }], balance: [] };
  const publication = { highlights: [highlights] } as FindingsPublication;
  assert.equal(highlightsFor(publication, data, PERIOD, "profit"), null);
  assert.equal(highlightsFor(publication, data, PERIOD, "cash")?.length, 2);
  assert.equal(highlightsFor(publication, data, "2025-12-31", "cash"), null);
});

test("the writer keeps only verified tiles, and earlier reports keep theirs", async () => {
  const model = async () => ({
    profit: [{ ref: { nodeId: "cloud" }, title: "Cloud revenue growth", compare: "yoy", show: "change" }, { ref: { metric: "nope" }, title: "Bad" }],
    cash: [{ ref: { capital: "capex" }, title: "Capex", compare: "yoy" }],
    balance: "not a list",
  });
  const { highlights } = await writeHighlights({ ticker: "TEST", companyName: "Test", periodEnd: PERIOD, table: buildHighlightTable(data, PERIOD), findings: [], data, model, stage: (_, callback) => callback() });
  assert.deepEqual(highlights, { periodEnd: PERIOD, profit: [{ ref: { nodeId: "cloud" }, title: "Cloud revenue growth", compare: "yoy", show: "change" }], cash: [{ ref: { capital: "capex" }, title: "Capex", compare: "yoy" }], balance: [] });
  const older: ReportHighlights = { periodEnd: "2026-03-31", profit: [], cash: [], balance: [] }, stale: ReportHighlights = { periodEnd: PERIOD, profit: [], cash: [], balance: [] };
  assert.deepEqual(mergeHighlights(highlights, [stale, older])!.map(h => h.periodEnd), [PERIOD, "2026-03-31"]);
  assert.deepEqual(mergeHighlights(null, [stale, older])!.map(h => h.periodEnd), [PERIOD, "2026-03-31"]);
});

test("the published contract carries highlights through validation", () => {
  const publication = {
    schemaVersion: "findings.v1", ticker: "TEST", periodEnd: PERIOD, generatedAt: "2026-07-30", model: "m",
    findings: [{ id: "a", kind: "risk", severity: 2, title: "Capex surges", judgment: { text: "Capex doubled.", sourceIds: ["s1"] }, evidence: [{ ref: { capital: "capex" }, periodEnd: PERIOD, span: "quarter" }], anchors: { view: "cash", nodeIds: [], metrics: [] }, lens: { type: "compare_bars", refs: [{ capital: "capex" }], span: "quarter" } }],
    sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", kind: "sec", publishedAt: null }],
    highlights: [{ periodEnd: PERIOD, profit: [], cash: [{ ref: { capital: "capex" }, title: "Capex surges", compare: "yoy" }], balance: [] }],
  };
  assert.equal(readFindingsPublication(publication, "TEST")?.highlights?.[0].cash[0].title, "Capex surges");
  assert.ok(resolveEvidence(data, { ref: { capital: "capex" }, periodEnd: PERIOD, span: "quarter", compare: "yoy" }));
});

test("highlights alone are a publication; an empty one is not", () => {
  const shell = { schemaVersion: "findings.v1", ticker: "TEST", periodEnd: PERIOD, generatedAt: "2026-07-30", model: "m", findings: [], sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", kind: "sec", publishedAt: null }] };
  assert.equal(readFindingsPublication(shell, "TEST"), null);
  const withHighlights = readFindingsPublication({ ...shell, highlights: [{ periodEnd: PERIOD, profit: [], cash: [{ ref: { capital: "capex" }, title: "Capex surges" }], balance: [] }] }, "TEST");
  assert.deepEqual(withHighlights?.findings, []);
  assert.equal(withHighlights?.highlights?.length, 1);
});
