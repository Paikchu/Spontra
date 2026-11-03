import assert from "node:assert/strict";
import test from "node:test";
import type { BalanceSheet } from "../../../shared/analysis-contract/capital-structure.ts";
import type { PeersPublication } from "../../../shared/analysis-contract/peers.ts";
import type { ModelDrivers, ScenarioAssumptions } from "../../../shared/analysis-contract/valuation.ts";
import { calculateValuation, coreEquityEarnings, forwardMultipleValue, peerMultiplesOf, type CalcRequest } from "../../../shared/analysis-runtime/valuation/calculator.ts";
import { buildPeerFundamentals } from "../src/valuation/input.ts";

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const fill = (n: number) => Array.from({ length: 5 }, () => n);
function request(midYear = false): CalcRequest {
  const drivers: ModelDrivers = { modelType: "fcff", revenue0: 1000, path: { revenueGrowth: fill(0.1), operatingMargin: fill(0.25), taxRate: fill(0.2), salesToCapital: fill(2) }, terminalGrowth: 0.02, terminalRoic: 0.15 };
  const scenario: ScenarioAssumptions = { narrative: "Synthetic operating path", probability: null, triggers: [], invalidation: [], evidenceIds: [], drivers };
  return { modelType: "fcff", currency: "USD", discountRate: { value: 0.1, basis: "wacc", components: { riskFree: 0.04, beta: 1, equityRiskPremium: 0.1, costOfEquity: 0.14, costOfDebt: 0.05, taxRate: 0.2, equityWeight: 0.6 }, rationale: "Synthetic separately stated WACC and equity cost", sourceRefs: [] }, shares: { base: 100, dilutionReserve: 0, basis: "synthetic" }, bridge: { nonOperatingAssets: 50, debtAndClaims: 100, nonOperatingEquityAdjustment: 0, notes: [] }, price: 20, midYear, scenarios: { bear: scenario, base: scenario, bull: scenario }, context: { forwardYears: 3, trailing: { da: 50, ebitda: 300, interestExpense: 10 }, peers: { peers: ["A", "B"], asOf: "2026-01-01", evToEbitda: { p25: 12, median: 12, p75: 12, count: 2 }, peRatio: { p25: 20, median: 20, p75: 20, count: 2 }, notes: [] }, methodWeights: { dcf: 0.5, ev_ebitda_forward: 0.3, pe_forward: 0.2 } } };
}

test("the exit-EV valuation equals PV of each FCFF plus PV of exit EV less today's net claims", () => {
  const r = 0.1, cashFlows = [-100, 80, 120], pvExplicit = cashFlows.reduce((sum, cf, i) => sum + cf / (1 + r) ** (i + 1), 0);
  const value = forwardMultipleValue({ metric: 300, multiples: { p25: 12, median: 12, p75: 12, count: 2 }, horizonYears: 3, r, kind: "ev", bridge: { nonOperatingAssets: 100, debtAndClaims: 400, nonOperatingEquityAdjustment: 0, notes: [] }, shares: 100, pvExplicit });
  const expected = (-100 / 1.1 + 80 / 1.1 ** 2 + 120 / 1.1 ** 3 + 3600 / 1.1 ** 3 + 100 - 400) / 100;
  close(value.base, expected);
  assert.notEqual(value.base, (3600 - (300 - cashFlows.reduce((a, b) => a + b, 0))) / 1.1 ** 3 / 100);
});

test("calculated EV cross-check honors mid-year FCFF timing while PE uses audited cost of equity", () => {
  for (const midYear of [false, true]) {
    const result = calculateValuation(request(midYear));
    const explicit = [170, 187, 205.7].reduce((sum, cf, i) => sum + cf / 1.1 ** (i + 1 - (midYear ? 0.5 : 0)), 0);
    const ebit3 = 1000 * 1.1 ** 3 * 0.25, da3 = 50 * 1.1 ** 3;
    close(result.methods!.find(m => m.method === "ev_ebitda_forward")!.base!, (explicit + (ebit3 + da3) * 12 / 1.1 ** 3 + 50 - 100) / 100);
    const eps3 = (ebit3 - 10) * 0.8 / 100;
    close(result.methods!.find(m => m.method === "pe_forward")!.base!, eps3 * 20 / 1.14 ** 3);
    assert.match(result.methods!.find(m => m.method === "pe_forward")!.basis, /cost of equity 14\.00%/);
    assert.match(result.methods!.find(m => m.method === "pe_forward")!.notes.join(" "), /not a complete FCFE valuation/);
    assert.equal(result.calculatorVersion, "valuation.calc.v9");
  }
});

test("missing equity cost excludes P/E while the enterprise multiple remains available", () => {
  const req = request(); req.discountRate.components.costOfEquity = null;
  const result = calculateValuation(req), pe = result.methods!.find(m => m.method === "pe_forward")!;
  assert.equal(pe.base, null); assert.match(pe.notes.join(" "), /cost of equity.*unavailable/);
  assert.ok(result.methods!.find(m => m.method === "ev_ebitda_forward")!.base != null);
});

test("peer and subject core equity earnings subtract interest; unknown and reported zero remain distinct", async () => {
  close(coreEquityEarnings(100, 20, 0.25)!, 60);
  close(coreEquityEarnings(100, 0, 0.25)!, 75);
  assert.equal(coreEquityEarnings(100, null, 0.25), null);
  const periods = ["2026-09-30", "2026-06-30", "2026-03-31", "2025-12-31"];
  const projection: PeersPublication = { schemaVersion: "peers.v1", generatedAt: "2026-11-01", companies: ["SUBJ", "A", "B"].map(ticker => ({ ticker, categories: [], newestQuarter: periods[0]!, quarters: periods.map(periodEnd => ({ periodEnd, accessions: ["filing"], figures: { operatingIncome: "25", depreciation: "5", debt: "100", cash: "10" } })) })) };
  const sheet: BalanceSheet = { asOf: periods[0]!, currency: "USD", assets: [], liabilities: [{ id: "fin", label: "Finance leases", concept: "FinanceLeaseLiability", group: "leases", value: "0" }], equity: [], totals: { assets: "100", liabilities: "100", equity: "0", currentAssets: null, currentLiabilities: null }, source: { accession: "filing", url: "https://example.org/filing", filedAt: "2026-10-20", form: "10-Q" } };
  const db: D1Database = { prepare() { throw new Error("No database access in this supplied-input test"); }, batch() { throw new Error("No database access"); }, exec() { throw new Error("No database access"); }, dump() { throw new Error("No database access"); }, withSession() { throw new Error("No database access"); } };
  const result = await buildPeerFundamentals(db, "SUBJ", projection, ["A", "B"], async () => 10, async () => sheet, undefined, async ticker => ticker === "A" ? 20 : null);
  assert.equal(result.peers.length, 2);
  close(result.peers[0]!.coreEarnings!, (100 - 20) * 0.79);
  assert.equal(result.peers[1]!.coreEarnings, null);
  assert.equal(result.peers[1]!.ebitda, 120);
  const multiples = peerMultiplesOf(result.peers.map(p => ({ ...p, price: 100 })), "2026-11-01");
  assert.equal(multiples?.evToEbitda?.count, 2);
  assert.equal(multiples?.peRatio, null, "one supported equity denominator is not a two-peer P/E sample");
  assert.ok(result.notes.some(note => /B:.*P\/E omitted, EV\/EBITDA retained/.test(note)));
});
