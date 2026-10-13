import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlowQuarter } from "../../../shared/analysis-contract/business-flow.ts";
import type { CapitalQuarter, CashFlowStatement } from "../../../shared/analysis-contract/capital-structure.ts";
import type { FindingPassage, FindingMaterial, FindingWatch } from "../../../shared/analysis-contract/findings.ts";
import type { LensDocument } from "../../../shared/analysis-contract/lens.ts";
import type { PeersPublication } from "../../../shared/analysis-contract/peers.ts";
import { balanceMetric, readLensDocument, resolveRef, tableScale, watchVerdict, type FindingData } from "../../../shared/analysis-runtime/findings.ts";
import { compileTable } from "../../../shared/analysis-runtime/lens/table.ts";
import { verifyLensDocument, verifyQuote } from "../../../shared/analysis-runtime/lens/verify.ts";
import { buildLedger } from "../src/findings/ledger.ts";

const ENDS = ["2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];
const amount = (v: number) => ({ value: String(v), basis: "reported" as const, definition: "", comparabilityKey: null, sourceIds: ["s1"] });
const quarter = (end: string, i: number): BusinessFlowQuarter => ({
  id: end, label: end, periodStart: null, periodEnd: end, periodType: "3M", currency: "USD", scale: 1e6, basisLabel: "", reportedAt: null,
  figures: { revenue: amount(100 + i * 5), cost: amount(40), gross: amount(60), operating: amount(30), net: amount(20) },
  segments: [{ id: "cloud", name: "Cloud", revenue: amount(40 + i * 4), description: "", products: [], customers: null, monetization: null, disclosure: "", sourceIds: ["s1"] }],
  segmentsComplete: true, sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", publishedAt: null } as BusinessFlowQuarter["sources"][number]],
});
const source = { accession: "0001", url: "https://www.sec.gov/x", filedAt: "2026-07-30", form: "10-Q" };
const line = (id: string, group: string, value: number, concept = "x") => ({ id, label: id, concept, group, value: String(value) });
const cashFlow = (end: string, i: number): CashFlowStatement => ({
  periodStart: end, periodEnd: end, currency: "USD", basis: "reported",
  operating: { total: "30000000000", lines: [line("ni", "netIncome", 20e9), line("da", "nonCash", 5e9 + i * 1e8, "DepreciationDepletionAndAmortization"), line("sbc", "nonCash", 1e9, "ShareBasedCompensation")] },
  investing: { total: "-15000000000", lines: [line("c", "capex", -10e9), line("acq", "acquisitions", -5e9)] },
  financing: { total: "-1000000000", lines: [line("lp", "leasePrincipal", -500e6)] }, fxEffect: null, netChange: "0",
  supplemental: [line("int", "interestPaid", 700e6), line("unpaid", "unpaidCapex", 2e9)], sources: [source],
} as CashFlowStatement);
const capitalQuarter = (end: string, i: number): CapitalQuarter => ({ periodEnd: end, cashFlow: cashFlow(end, i), yearToDate: null, balanceSheet: {
  asOf: end, currency: "USD", assets: [line("cash", "cash", 50e9), line("ppe", "productive", 60e9 + i * 2e9), line("rou", "leaseAssets", 8e9)],
  liabilities: [line("d", "debt", 20e9 + i * 1e9), line("l", "leases", 9e9), line("dr", "customerAdvances", 7e9), line("ap", "payables", 4e9)],
  equity: [], totals: { assets: "200000000000", liabilities: "80000000000", equity: "120000000000", currentAssets: "70000000000", currentLiabilities: "35000000000" }, source,
} });
const PERIOD = ENDS.at(-1)!;
const peers: PeersPublication = { schemaVersion: "peers.v1", generatedAt: "2026-08-01T00:00:00Z", companies: [
  { ticker: "TEST", categories: ["cloud_infrastructure"], newestQuarter: PERIOD, quarters: [] },
  { ticker: "PEER1", categories: ["cloud_infrastructure"], newestQuarter: "2026-06-30", quarters: ENDS.map((end, i) => ({ periodEnd: end, accessions: ["p1"], figures: { capex: String(4e9 + i * 1e8), debt: "9000000000", operatingCashFlow: "6000000000" } })) },
  { ticker: "PEER2", categories: ["cloud_infrastructure"], newestQuarter: "2026-05-31", quarters: [{ periodEnd: "2026-05-31", accessions: ["p2"], figures: { capex: "3000000000" } }] },
  { ticker: "FAR", categories: ["banking"], newestQuarter: PERIOD, quarters: [{ periodEnd: PERIOD, accessions: [], figures: { capex: "1" } }] },
] };
const passages: FindingPassage[] = [{ passageId: "p0b76d7dc904f3a06b1500cd4641d", documentId: "d", title: "10-Q", form: "10-Q", filedAt: "2026-09-11", url: "https://www.sec.gov/x", path: ["Item 1", "LEASES AND OTHER COMMITMENTS"],
  text: "As of August 31, 2026, we had $288 billion of additional lease commitments, substantially all related to data center arrangements.",
  table: { unit: "(in millions)", columns: [""], rows: [{ label: "Remainder of fiscal 2027", cells: [{ text: "$5,449", value: 5449 }] }, { label: "Total", cells: [{ text: "$34,150", value: 34150 }] }, { label: "Share", cells: [{ text: "12.5%", value: 12.5 }] }] } }];
const materials: FindingMaterial[] = [{ id: "m1", kind: "sec", title: "10-Q", url: "https://www.sec.gov/x", publishedAt: "2026-09-11", passageId: "p0b76d7dc904f3a06b1500cd4641d" }];
const data: FindingData = { quarters: ENDS.map(quarter), history: null, capital: { schemaVersion: "capital-structure.v1", ticker: "TEST", quarters: ENDS.map(capitalQuarter) }, fundamentals: null, guidance: null, peers, passages };

test("the new capital metrics resolve from the projected groups, supplemental lines and non-cash lines", () => {
  const at = (ref: Parameters<typeof resolveRef>[1]) => resolveRef(data, ref, PERIOD, "quarter")?.value;
  assert.equal(at({ capital: "leases" }), 9e9);
  assert.equal(at({ capital: "customerAdvances" }), 7e9);
  assert.equal(at({ capital: "productive" }), 60e9 + 7 * 2e9);
  assert.equal(at({ capital: "currentLiabilities" }), 35e9);
  assert.equal(at({ capital: "acquisitions" }), 5e9);
  assert.equal(at({ capital: "leasePrincipal" }), 500e6);
  assert.equal(at({ capital: "depreciation" }), 5e9 + 7 * 1e8);
  assert.equal(at({ capital: "stockCompensation" }), 1e9);
  assert.equal(at({ capital: "interestPaid" }), 700e6);
  assert.equal(at({ capital: "unpaidCapex" }), 2e9);
  assert.equal(at({ capital: "taxesPaid" }), undefined);
  assert.equal(balanceMetric(data.capital!.quarters[0]!.balanceSheet!, "inventory"), 0);
  const ledger = buildLedger(data, PERIOD, [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", kind: "sec", publishedAt: null }]);
  assert.ok(ledger.rows.some(r => "ratio" in r.ref && "capital" in r.ref.ratio.denominator && r.ref.ratio.denominator.capital === "depreciation" && r.value.endsWith("x")));
  assert.ok(ledger.rows.some(r => "capital" in r.ref && r.ref.capital === "customerAdvances"));
});

test("peer references read the peer's aligned quarter, sum four quarters for a flow, and refuse an unaligned or unknown peer", () => {
  assert.equal(resolveRef(data, { peer: { ticker: "PEER1", ref: { capital: "capex" } } }, PERIOD, "quarter")?.value, 4e9 + 7 * 1e8);
  assert.equal(resolveRef(data, { peer: { ticker: "PEER1", ref: { capital: "capex" } } }, PERIOD, "fiscal_year")?.value, [4, 5, 6, 7].reduce((s, i) => s + 4e9 + i * 1e8, 0));
  assert.equal(resolveRef(data, { peer: { ticker: "PEER1", ref: { capital: "debt" } } }, PERIOD, "fiscal_year")?.value, 9e9);
  assert.equal(resolveRef(data, { peer: { ticker: "PEER2", ref: { capital: "capex" } } }, PERIOD, "quarter")?.value, 3e9);
  assert.equal(resolveRef(data, { peer: { ticker: "PEER2", ref: { capital: "capex" } } }, "2024-12-31", "quarter"), null);
  assert.equal(resolveRef(data, { peer: { ticker: "NOPE", ref: { capital: "capex" } } }, PERIOD, "quarter"), null);
});

test("a peers table keeps the company and the peers with a figure, drops the rest, and needs two peers; a periods table trims leading empty periods", () => {
  const result = compileTable({ columns: "peers", span: "quarter", rows: [{ ref: { capital: "capex" }, compare: "yoy" }, { ref: { capital: "debt" } }] }, data, "TEST", PERIOD);
  assert.ok(result.table);
  assert.deepEqual(result.table!.columns.map(c => c.key), ["TEST", "PEER1", "PEER2"]);
  assert.equal(result.table!.rows[0]!.cells[1]!.text, "$4.7B");
  assert.ok(result.table!.rows[0]!.cells[0]!.change?.startsWith("+") || result.table!.rows[0]!.cells[0]!.change === "0.0%");
  assert.equal(result.table!.rows[1]!.cells[2], null);
  const thin = compileTable({ columns: "peers", span: "quarter", peers: ["PEER2"], rows: [{ ref: { capital: "capex" } }] }, data, "TEST", PERIOD);
  assert.equal(thin.table, null);
  assert.match(thin.errors.join(" "), /needs two/);
  const periods = compileTable({ columns: "periods", span: "quarter", periods: 3, rows: [{ ref: { capital: "capex" } }, { ref: { passageCell: { passageId: "p0b76d7dc904f3a06b1500cd4641d", row: 1, col: 0 } }, label: "Purchase obligations" }] }, data, "TEST", PERIOD);
  assert.equal(periods.table!.columns.length, 3);
  assert.deepEqual(periods.table!.rows[1]!.cells.map(c => c?.text ?? null), [null, null, "$34.1B"]);
});

test("a table cell resolves only with a parsed scale and no percent; a quote must be found verbatim in the served passage", () => {
  assert.equal(tableScale("(Dollars in thousands)"), 1e3);
  assert.equal(tableScale(null), null);
  assert.equal(resolveRef(data, { passageCell: { passageId: "p0b76d7dc904f3a06b1500cd4641d", row: 1, col: 0 } }, PERIOD, "quarter")?.value, 34150e6);
  assert.equal(resolveRef(data, { passageCell: { passageId: "p0b76d7dc904f3a06b1500cd4641d", row: 2, col: 0 } }, PERIOD, "quarter"), null);
  assert.ok(verifyQuote(materials, passages, "m1", "we had $288 billion of additional lease commitments, substantially all related to data center arrangements"));
  assert.equal(verifyQuote(materials, passages, "m1", "we had $288 billion of additional debt"), null);
  assert.equal(verifyQuote(materials, [], "m1", "we had $288 billion"), null);
});

test("a document with quotes, tables and a record verifies; a bad quote and a thin table are taken out and the rest stands", () => {
  const watch: FindingWatch = { ref: { capital: "capex" }, condition: "Capex below its year-ago level.", horizon: "next_quarter", compare: "yoy", test: { expect: "below", against: "yoy" } };
  const doc: LensDocument = { rows: [
    { title: "Spending", cells: [[{ kind: "judgment" }, { kind: "figures" }, { kind: "watch" }]] },
    { title: "Commitments", cells: [[{ kind: "quote", materialId: "m1", text: "we had $288 billion of additional lease commitments" }], [{ kind: "quote", materialId: "m1", text: "we had no commitments at all" }]] },
    { cells: [[{ kind: "table", table: { columns: "peers", span: "quarter", rows: [{ ref: { capital: "capex" } }] } }], [{ kind: "table", table: { columns: "peers", span: "quarter", peers: ["FAR"], rows: [{ ref: { capital: "capex" } }] } }]] },
    { cells: [[{ kind: "record" }]] },
  ] };
  assert.ok(readLensDocument(doc));
  const lens = verifyLensDocument(doc, { watch }, [], data, PERIOD, {}, { ticker: "TEST", materials, record: [{}] })!;
  assert.equal(lens.document.rows.length, 4);
  assert.equal(lens.document.rows[1]!.cells.length, 1);
  assert.equal(Object.keys(lens.quotes).length, 1);
  assert.equal(Object.keys(lens.tables).length, 1);
  assert.equal(lens.reasons.length, 2);
  const noRecord = verifyLensDocument(doc, { watch }, [], data, PERIOD, {}, { ticker: "TEST", materials, record: [] })!;
  assert.equal(noRecord.document.rows.length, 3);
});

test("a watch test scores pass or fail from the data once its period exists, and stays unscored before", () => {
  const written = "2026-03-31";
  const below: FindingWatch = { ref: { capital: "capex" }, condition: "x", horizon: "next_quarter", test: { expect: "below", against: "yoy" } };
  assert.equal(watchVerdict(data, below, written)?.verdict, "fail");
  const within: FindingWatch = { ref: { capital: "capex" }, condition: "x", horizon: "next_quarter", test: { expect: "within", against: "qoq", tolerance: 1 } };
  assert.equal(watchVerdict(data, within, written)?.verdict, "pass");
  const above: FindingWatch = { ref: { capital: "depreciation" }, condition: "x", horizon: "next_quarter", test: { expect: "above", against: { ref: { capital: "stockCompensation" } } } };
  assert.equal(watchVerdict(data, above, written)?.verdict, "pass");
  assert.equal(watchVerdict(data, below, PERIOD), null);
  assert.equal(watchVerdict(data, { ...below, test: undefined }, written), null);
});
