import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlowQuarter } from "../../../shared/analysis-contract/business-flow.ts";
import type { CapitalQuarter, CashFlowStatement } from "../../../shared/analysis-contract/capital-structure.ts";
import { PEER_FIGURES, type PeerCompany } from "../../../shared/analysis-contract/peers.ts";
import type { FindingData } from "../../../shared/analysis-runtime/findings.ts";
import { alignedPeerQuarter, depreciationOf, liabilityGroupTotal, peerQuartersFrom, readPeersPublication } from "../../../shared/analysis-runtime/peers.ts";
import { EVENT_TYPES, SUBSCRIPTIONS, TASKS, validateRegistry } from "../src/pipeline/registry.ts";

const ENDS = ["2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];
const amount = (v: number) => ({ value: String(v), basis: "reported" as const, definition: "", comparabilityKey: null, sourceIds: ["s1"] });

function quarter(end: string, i: number): BusinessFlowQuarter {
  const revenue = 100 + i * 5;
  return {
    id: end, label: end, periodStart: null, periodEnd: end, periodType: "3M", currency: "USD", scale: 1e6, basisLabel: "", reportedAt: null,
    figures: { revenue: amount(revenue), gross: amount(revenue * 0.6), operating: amount(revenue * 0.3), net: amount(revenue * 0.2) },
    segments: [], segmentsComplete: true, sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", publishedAt: null } as BusinessFlowQuarter["sources"][number]],
  };
}
const source = (i: number) => ({ accession: `000${i}`, url: "https://www.sec.gov/x", filedAt: "2026-07-30", form: "10-Q" });
function cashFlow(end: string, i: number): CashFlowStatement {
  return {
    periodStart: end, periodEnd: end, currency: "USD", basis: "reported",
    operating: { total: "30000000000", lines: [
      { id: "ni", label: "Net income", concept: "us-gaap:NetIncomeLoss", group: "netIncome", value: "20000000000" },
      { id: "da", label: "Depreciation", concept: "us-gaap:DepreciationDepletionAndAmortization", group: "nonCash", value: "6000000000" },
      { id: "am", label: "Amortization of intangibles", concept: "us-gaap:AmortizationOfIntangibleAssets", group: "nonCash", value: "1000000000" },
      { id: "sbc", label: "Stock comp", concept: "us-gaap:ShareBasedCompensation", group: "nonCash", value: "3000000000" },
    ] },
    investing: { total: "-10000000000", lines: [{ id: "c", label: "Capex", concept: "x", group: "capex", value: "-10000000000" }] },
    financing: { total: "-1000000000", lines: [
      { id: "di", label: "Debt issued", concept: "x", group: "debtIssued", value: "5000000000" },
      { id: "bb", label: "Buybacks", concept: "x", group: "buybacks", value: "-4000000000" },
      { id: "dv", label: "Dividends", concept: "x", group: "dividends", value: "-2000000000" },
    ] },
    fxEffect: null, netChange: "0", supplemental: [], sources: [source(i)],
  } as CashFlowStatement;
}
function capitalQuarter(end: string, i: number): CapitalQuarter {
  return { periodEnd: end, cashFlow: cashFlow(end, i), yearToDate: null,
    rpo: { asOf: end, currency: "USD", total: "140000000000", buckets: [], source: source(i) },
    balanceSheet: {
      asOf: end, currency: "USD",
      assets: [{ id: "cash", label: "Cash", concept: "x", group: "cash", value: "50000000000" }, { id: "sti", label: "Short-term investments", concept: "x", group: "cash", value: "5000000000" }],
      liabilities: [
        { id: "d1", label: "Notes", concept: "x", group: "debt", value: String(20e9 + i * 1e9) }, { id: "d2", label: "Current notes", concept: "x", group: "debt", value: "2000000000" },
        { id: "l", label: "Lease liabilities", concept: "x", group: "leases", value: "7000000000" },
        { id: "ca", label: "Deferred revenue", concept: "x", group: "customerAdvances", value: "9000000000" },
      ],
      equity: [], totals: { assets: "200000000000", liabilities: "80000000000", equity: "120000000000", currentAssets: null, currentLiabilities: null }, source: source(i),
    } };
}
const data: FindingData = {
  quarters: ENDS.map(quarter), history: null,
  capital: { schemaVersion: "capital-structure.v1", ticker: "TEST", quarters: ENDS.map(capitalQuarter) },
  fundamentals: { series: [{ metricKey: "stock_based_compensation", label: "SBC", category: "cash_flow", unitFamily: "currency", currency: "USD", available: true,
    points: ENDS.map(end => ({ periodEnd: end, valueDecimal: "3000000000", sourceAccession: "sbc-1" })) }] },
  guidance: null,
};

test("every figure reads with the findings runtime's quarter semantics, newest first, eight quarters at most", () => {
  const quarters = peerQuartersFrom(data);
  assert.equal(quarters.length, 8);
  assert.equal(quarters[0].periodEnd, "2026-06-30");
  assert.equal(quarters[7].periodEnd, "2024-09-30");
  const f = quarters[0].figures;
  assert.equal(f.revenue, String(145e6));
  assert.equal(f.grossProfit, String(87e6));
  assert.equal(f.operatingIncome, String(43.5e6));
  assert.equal(f.netIncome, String(29e6));
  assert.equal(f.operatingCashFlow, "30000000000");
  assert.equal(f.capex, "10000000000", "capex is positive");
  assert.equal(f.freeCashFlow, "20000000000");
  assert.equal(f.debtIssued, "5000000000");
  assert.equal(f.buybacks, "4000000000", "buybacks and dividends are positive outflows");
  assert.equal(f.dividends, "2000000000");
  assert.equal(f.equityIssued, "0", "a reconciled section with no line in the group reads as zero, as the findings runtime reads it");
  assert.equal(f.totalAssets, "200000000000");
  assert.equal(f.equity, "120000000000");
  assert.equal(f.debt, "31000000000", "debt is the summed liability group");
  assert.equal(f.cash, "55000000000", "cash is the summed asset group");
  assert.equal(f.leases, "7000000000");
  assert.equal(f.customerAdvances, "9000000000");
  assert.equal(f.rpo, "140000000000");
  assert.equal(f.depreciation, "7000000000", "depreciation and amortization non-cash lines, not SBC");
  assert.equal(f.stockBasedCompensation, "3000000000");
  assert.deepEqual(quarters[0].accessions, ["0009", "s1", "sbc-1"], "statement, flow source and series filings, each once");
  assert.ok(PEER_FIGURES.every(figure => figure in f));
});

test("figures the data cannot answer are left out, and a quarter without any is dropped", () => {
  const sparse: FindingData = { quarters: [quarter("2026-06-30", 9)], history: null, capital: { schemaVersion: "capital-structure.v1", ticker: "TEST", quarters: [
    { periodEnd: "2026-06-30", cashFlow: null, yearToDate: null, balanceSheet: { ...capitalQuarter("2026-06-30", 9).balanceSheet!, liabilities: [] } },
    { periodEnd: "2026-03-31", cashFlow: null, yearToDate: null, balanceSheet: null },
  ] }, fundamentals: null, guidance: null };
  const quarters = peerQuartersFrom(sparse);
  assert.equal(quarters.length, 1);
  const f = quarters[0].figures;
  assert.equal(f.revenue, String(145e6));
  assert.equal(f.capex, undefined);
  assert.equal(f.leases, undefined);
  assert.equal(f.customerAdvances, undefined);
  assert.equal(f.depreciation, undefined);
  assert.equal(f.debt, "0", "an empty debt group reads as the findings runtime reads it");
  assert.equal(f.totalAssets, "200000000000");
});

test("depreciation falls back to the SEC series when the statement tags no such line; non-USD figures are dropped", () => {
  const statement = cashFlow("2026-06-30", 9);
  assert.equal(depreciationOf({ ...statement, operating: { total: "1", lines: null } }), null);
  assert.equal(liabilityGroupTotal(capitalQuarter("2026-06-30", 9).balanceSheet!, "payables"), null);
  const withSeries: FindingData = { quarters: [], history: null,
    capital: { schemaVersion: "capital-structure.v1", ticker: "TEST", quarters: [{ periodEnd: "2026-06-30", cashFlow: { ...statement, operating: { total: "1", lines: null } }, yearToDate: null, balanceSheet: null }] },
    fundamentals: { series: [{ metricKey: "depreciation_and_amortization", label: "D&A", category: "cash_flow", unitFamily: "currency", currency: "USD", available: true, points: [{ periodEnd: "2026-06-30", valueDecimal: "6500000000", sourceAccession: "da-1" }] }] }, guidance: null };
  assert.equal(peerQuartersFrom(withSeries)[0].figures.depreciation, "6500000000");
  const euro: FindingData = { quarters: [{ ...quarter("2026-06-30", 9), currency: "EUR" }], history: null, capital: null, fundamentals: null, guidance: null };
  assert.deepEqual(peerQuartersFrom(euro), []);
});

test("alignment takes the latest quarter ending on or before the period, within 120 days", () => {
  const company: Pick<PeerCompany, "quarters"> = { quarters: [
    { periodEnd: "2026-06-30", accessions: [], figures: {} }, { periodEnd: "2026-03-31", accessions: [], figures: {} }, { periodEnd: "2025-12-31", accessions: [], figures: {} },
  ] };
  assert.equal(alignedPeerQuarter(company, "2026-08-31")?.periodEnd, "2026-06-30", "a fiscal quarter two months later aligns to the calendar quarter before it");
  assert.equal(alignedPeerQuarter(company, "2026-06-30")?.periodEnd, "2026-06-30", "ending on the period counts");
  assert.equal(alignedPeerQuarter(company, "2026-06-29")?.periodEnd, "2026-03-31", "a day earlier is the quarter before");
  assert.equal(alignedPeerQuarter(company, "2026-10-28")?.periodEnd, "2026-06-30", "120 days is inside the window");
  assert.equal(alignedPeerQuarter(company, "2026-10-29"), null, "121 days is outside it");
  assert.equal(alignedPeerQuarter(company, "2025-11-30"), null, "before the oldest quarter there is nothing");
  assert.equal(alignedPeerQuarter({ quarters: [...company.quarters].reverse() }, "2026-08-31")?.periodEnd, "2026-06-30", "order of storage does not matter");
  assert.equal(alignedPeerQuarter(company, "not a date"), null);
});

test("the stored publication reads through the contract, unknown fields stripped, bad shapes rejected", () => {
  const stored = { schemaVersion: "peers.v1", generatedAt: "2026-10-14T00:00:00.000Z", extra: 1, companies: [
    { ticker: "ORCL", categories: ["cloud_infrastructure"], newestQuarter: "2026-08-31", quarters: [{ periodEnd: "2026-08-31", accessions: ["0001"], figures: { capex: "12000000000", bogus: "1" }, note: "x" }] },
  ] };
  const publication = readPeersPublication(stored)!;
  assert.ok(publication);
  assert.equal("extra" in publication, false);
  assert.deepEqual(publication.companies[0].quarters[0].figures, { capex: "12000000000" });
  assert.equal("note" in publication.companies[0].quarters[0], false);
  assert.equal(readPeersPublication({ ...stored, schemaVersion: "peers.v2" }), null);
  assert.equal(readPeersPublication({ ...stored, companies: [{ ...stored.companies[0], quarters: [{ periodEnd: "2026-08-31", accessions: [], figures: { capex: "12 billion" } }] }] }), null);
  assert.equal(readPeersPublication(null), null);
  assert.equal(readPeersPublication(peerQuartersFrom(data)), null);
  assert.ok(readPeersPublication({ schemaVersion: "peers.v1", generatedAt: "now", companies: [{ ticker: "TEST", categories: [], newestQuarter: "2026-06-30", quarters: peerQuartersFrom(data) }] }));
});

test("the peers task is a global subscriber of map.derived and fundamentals.updated and the graph stays valid", () => {
  assert.ok(EVENT_TYPES.includes("peers.published"));
  assert.deepEqual(TASKS.peers, { emits: ["peers.published"], debounceMs: 2 * 60_000, maxWaitMs: 30 * 60_000, scope: "global" });
  assert.ok(SUBSCRIPTIONS["map.derived"]!.some(s => s.task === "peers"));
  assert.ok(SUBSCRIPTIONS["fundamentals.updated"]!.some(s => s.task === "peers"));
  assert.deepEqual(validateRegistry(), []);
});
