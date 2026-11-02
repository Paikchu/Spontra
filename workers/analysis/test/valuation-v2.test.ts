import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelDrivers, ScenarioAssumptions } from "../../../shared/analysis-contract/valuation.ts";
import { calculateValuation, floorBreaches, forwardFundamentals, forwardMultipleValue, methodWeightsOf, multipleHistoryOf, peerMultiplesOf, rpoRevenueFloor, sanityGates, scenarioValue, triangulate, ValuationCalcError, verifyCitedInputs, type CalcRequest } from "../../../shared/analysis-runtime/valuation/calculator.ts";
import { readValuationPublication } from "../../../shared/analysis-runtime/valuation/read.ts";
import { anchorOf, lifecycleOf, priorRequest } from "../../../shared/analysis-runtime/valuation/prior.ts";
import { gateGaps } from "../src/valuation/tools.ts";

const close = (actual: number, expected: number, digits = 2) => assert.equal(Number(actual.toFixed(digits)) + 0, Number(expected.toFixed(digits)) + 0);
const bridge = { nonOperatingAssets: 0, debtAndClaims: 0, nonOperatingEquityAdjustment: 0, notes: [] };
const fill = (n: number, v: number) => new Array<number>(n).fill(v);
const scenario = (drivers: ModelDrivers, probability: number | null = null): ScenarioAssumptions => ({ narrative: "", probability, triggers: [], invalidation: [], evidenceIds: [], drivers });
const rate = (value: number) => ({ value, basis: "wacc" as const, components: { riskFree: null, beta: null, equityRiskPremium: null, costOfEquity: null, costOfDebt: null, taxRate: null, equityWeight: null }, rationale: "", sourceRefs: [] });
const fcff = (years: number, growth: number, margin = 0.2, extra: Partial<Extract<ModelDrivers, { modelType: "fcff" }>> = {}, path: Partial<Extract<ModelDrivers, { modelType: "fcff" }>["path"]> = {}): ModelDrivers =>
  ({ modelType: "fcff", revenue0: 1000, path: { revenueGrowth: fill(years, growth), operatingMargin: fill(years, margin), taxRate: fill(years, 0.2), salesToCapital: fill(years, 2), ...path }, terminalGrowth: 0.03, terminalRoic: 0.15, ...extra });
const request = (years: number, extra: Partial<CalcRequest> = {}): CalcRequest => ({
  modelType: "fcff", currency: "USD", discountRate: rate(0.09), shares: { base: 100, dilutionReserve: 0, basis: "diluted" }, bridge: { ...bridge, nonOperatingAssets: 300, debtAndClaims: 200 }, price: null,
  scenarios: { bear: scenario(fcff(years, 0.02, 0.17)), base: scenario(fcff(years, 0.06)), bull: scenario(fcff(years, 0.10, 0.22)) }, ...extra,
});

test("horizon: a seven-year path runs seven years; four or eleven years and mixed lengths are rejected; five-year payloads are unchanged", () => {
  const seven = scenarioValue(fcff(7, 0.05), 0.09, 100, bridge);
  assert.equal(seven.yearly.length, 7);
  assert.throws(() => scenarioValue(fcff(4, 0.05), 0.09, 100, bridge), (e: unknown) => e instanceof ValuationCalcError && e.code === "invalid_input");
  assert.throws(() => scenarioValue(fcff(11, 0.05), 0.09, 100, bridge), ValuationCalcError);
  assert.throws(() => scenarioValue(fcff(7, 0.05, 0.2, {}, { taxRate: fill(5, 0.2) }), 0.09, 100, bridge), ValuationCalcError);
  const five = calculateValuation(request(5));
  assert.equal(five.horizonYears, 5); assert.equal(five.midYear, false);
  assert.equal(five.methods, undefined, "no context, no cross-check");
  // Year five of a flat path equals the five-year model's year five.
  close(scenarioValue(fcff(7, 0.05), 0.09, 100, bridge).yearly[4]!.cashFlow, scenarioValue(fcff(5, 0.05), 0.09, 100, bridge).yearly[4]!.cashFlow, 6);
});

test("build capex is reinvestment ahead of revenue and never reaches the terminal; a normalized terminal margin lifts the terminal NOPAT", () => {
  const plain = scenarioValue(fcff(7, 0.05), 0.09, 100, bridge);
  const build = scenarioValue(fcff(7, 0.05, 0.2, {}, { buildCapex: [100, 50, 0, 0, 0, 0, 0] }), 0.09, 100, bridge);
  close(plain.yearly[0]!.cashFlow - build.yearly[0]!.cashFlow, 100, 6);
  close(plain.yearly[1]!.cashFlow - build.yearly[1]!.cashFlow, 50, 6);
  close(plain.yearly[2]!.cashFlow, build.yearly[2]!.cashFlow, 6);
  close(plain.pvTerminal!, build.pvTerminal!, 6);
  assert.equal(build.yearly[0]!.buildCapex, 100);
  assert.throws(() => scenarioValue(fcff(7, 0.05, 0.2, {}, { buildCapex: [-1, 0, 0, 0, 0, 0, 0] }), 0.09, 100, bridge), ValuationCalcError);
  const normalized = scenarioValue(fcff(5, 0.05, 0.1, { terminalOperatingMargin: 0.2 }), 0.09, 100, bridge);
  const low = scenarioValue(fcff(5, 0.05, 0.1), 0.09, 100, bridge);
  close(normalized.pvTerminal! / low.pvTerminal!, 2, 6);
  assert.ok(normalized.notes.some(n => n.includes("normalized 20.0% margin")));
});

test("mid-year discounting shifts every cash flow half a year earlier", () => {
  const yearEnd = scenarioValue(fcff(5, 0), 0.09, 100, bridge), mid = scenarioValue(fcff(5, 0), 0.09, 100, bridge, { midYear: true });
  close(mid.yearly[0]!.discountFactor, 1 / 1.09 ** 0.5, 8);
  close(mid.pvExplicit! / yearEnd.pvExplicit!, 1.09 ** 0.5, 8);
  close(mid.pvTerminal! / yearEnd.pvTerminal!, 1.09 ** 0.5, 8);
  assert.ok(calculateValuation({ ...request(5), midYear: true }).limitations[0]!.includes("mid-year"));
});

test("RPO floor: a 12-month bucket lands in year one, a 24-month bucket spreads over years two and three, an open bucket runs 24 months", () => {
  const anchor = rpoRevenueFloor({ asOf: "2026-08-31", total: 1000, buckets: [{ startMonths: 0, months: 12, share: 0.13 }, { startMonths: 12, months: 24, share: 0.37 }, { startMonths: 36, months: 24, share: 0.34 }], years: 7, revenue0: 500 });
  close(anchor.floor[0]!, 130); close(anchor.floor[1]!, 185); close(anchor.floor[2]!, 185); close(anchor.floor[3]!, 170); close(anchor.floor[4]!, 170); close(anchor.floor[5]!, 0); close(anchor.floor[6]!, 0);
  close(anchor.floorToRevenue0[0]!, 0.26);
  assert.ok(anchor.notes.some(n => n.includes("16%")), "untimed share is noted");
  const open = rpoRevenueFloor({ asOf: "2026-09-30", total: 1000, buckets: [{ startMonths: 0, months: null, share: 0.55 }], years: 5, revenue0: 500 });
  close(open.floor[0]!, 275); close(open.floor[1]!, 275); close(open.floor[2]!, 0);
  assert.throws(() => rpoRevenueFloor({ asOf: "2026-09-30", total: 1000, buckets: [{ startMonths: 0, months: 12, share: 0.7 }, { startMonths: 12, months: 12, share: 0.5 }], years: 5, revenue0: 500 }), ValuationCalcError);
  // The capital-structure shape: bucket starts as dates the month after the period end.
  const fromDisclosure = anchorOf({ asOf: "2026-08-31", total: 664e9, buckets: [{ start: "2026-09-01", months: 12, share: 0.13 }, { start: "2027-09-01", months: 24, share: 0.37 }, { start: "2029-09-01", months: 24, share: 0.34 }] }, 7, 71.777e9)!;
  close(fromDisclosure.floor[0]! / 1e9, 86.32); close(fromDisclosure.floorToRevenue0[0]!, 1.2026, 4);
  assert.equal(anchorOf(null, 7, 100), null);
  // A path under the floor is a breach; one above it is not.
  const drivers = fcff(7, 0.05) as Extract<ModelDrivers, { modelType: "fcff" }>;
  assert.equal(floorBreaches({ ...drivers, revenue0: 500 }, anchor).length, 0);
  assert.deepEqual(floorBreaches({ ...drivers, revenue0: 100 }, anchor).map(b => b.year), [1, 2, 3, 4, 5]);
});

test("forward multiples: year-3 EBITDA at the peer median, net claims rolled forward by the base cash flows, discounted three years", () => {
  const drivers = fcff(5, 0.10) as Extract<ModelDrivers, { modelType: "fcff" }>;
  const f = forwardFundamentals(drivers, 3, { da0: 50, interestExpense0: 10, shares: 100 });
  close(f.revenue, 1331); close(f.ebit, 266.2); close(f.ebitda!, 266.2 + 66.55); close(f.eps!, (266.2 - 10) * 0.8 / 100, 6);
  const multiples = { p25: 10, median: 12, p75: 14, count: 5 };
  const ev = forwardMultipleValue({ metric: 300, multiples, horizonYears: 3, r: 0.09, kind: "ev", bridge: { ...bridge, nonOperatingAssets: 100, debtAndClaims: 400 }, shares: 100, cumulativeCashFlow: -150 });
  // Net claims 300 today plus 150 of negative cash flow = 450 at the horizon.
  close(ev.base, (300 * 12 - 450) / 1.09 ** 3 / 100, 6); close(ev.low, (300 * 10 - 450) / 1.09 ** 3 / 100, 6);
  const pe = forwardMultipleValue({ metric: 2, multiples, horizonYears: 3, r: 0.09, kind: "equity", bridge, shares: 100, cumulativeCashFlow: 0 });
  close(pe.base, 24 / 1.09 ** 3, 6);
  assert.throws(() => forwardMultipleValue({ metric: 2, multiples: { ...multiples, p25: -1 }, horizonYears: 3, r: 0.09, kind: "equity", bridge, shares: 100, cumulativeCashFlow: 0 }), ValuationCalcError);
});

test("peer multiples: quartiles over the peers that answer; a peer without a quote or with negative EBITDA is left out", () => {
  const peers = peerMultiplesOf([
    { ticker: "A", price: 100, shares: 10, ebitda: 100, coreEarnings: 50, netDebt: 200 },
    { ticker: "B", price: 50, shares: 20, ebitda: 80, coreEarnings: 40, netDebt: -200 },
    { ticker: "C", price: 10, shares: 100, ebitda: -5, coreEarnings: -1, netDebt: 0 },
    { ticker: "D", price: null, shares: 10, ebitda: 100, coreEarnings: 50, netDebt: 0 },
    { ticker: "E", price: 20, shares: 50, ebitda: 50, coreEarnings: 25, netDebt: 0 },
  ], "2026-10-31")!;
  assert.deepEqual(peers.peers, ["A", "B", "E"]);
  // EV/EBITDA 12, 10, 20 → median 12; P/E 20, 25, 40 → median 25.
  close(peers.evToEbitda!.median, 12); close(peers.peRatio!.median, 25); assert.equal(peers.evToEbitda!.count, 3);
  assert.ok(peers.notes.some(n => n.startsWith("C:")) && peers.notes.some(n => n.startsWith("D:")));
  assert.equal(peerMultiplesOf([{ ticker: "D", price: null, shares: 10, ebitda: 100, coreEarnings: 50, netDebt: 0 }], "2026-10-31"), null);
});

test("triangulation and weights: methods renormalize over those applied, dispersion is max/min; weights default by life cycle", () => {
  const w = methodWeightsOf(null, "build");
  close(w.dcf, 0.5); close(w.ev_ebitda_forward, 0.3); close(w.pe_forward, 0.2);
  close(methodWeightsOf({ dcf: 0.5, ev_ebitda_forward: 0.5, pe_forward: 0 }, "mature").dcf, 0.5);
  // Explicit weights are judged, never renormalized: they must sum to 1 within the tolerance.
  assert.throws(() => methodWeightsOf({ dcf: 1, ev_ebitda_forward: 1, pe_forward: 0 }, "mature"), (e: unknown) => e instanceof ValuationCalcError && /sum to 1/.test(e.message));
  assert.throws(() => methodWeightsOf({ dcf: 0, ev_ebitda_forward: 0, pe_forward: 0 }, "mature"), ValuationCalcError);
  assert.throws(() => methodWeightsOf({ dcf: 0.5, ev_ebitda_forward: 0.5 }, "mature"), ValuationCalcError);
  close(methodWeightsOf({ dcf: { weight: 0.7, rationale: "r", evidenceIds: [] }, ev_ebitda_forward: 0.3, pe_forward: 0 }, "mature").dcf, 0.7);
  const t = triangulate([
    { method: "dcf", label: "", low: 80, base: 100, high: 120, weight: 0.5, basis: "", notes: [] },
    { method: "ev_ebitda_forward", label: "", low: 150, base: 200, high: 250, weight: 0.3, basis: "", notes: [] },
    { method: "pe_forward", label: "", low: null, base: null, high: null, weight: 0.2, basis: "", notes: [] },
  ])!;
  close(t.base, (0.5 * 100 + 0.3 * 200) / 0.8); close(t.dispersion!, 2); close(t.weights.dcf, 0.625); close(t.weights.pe_forward, 0);
  assert.equal(triangulate([{ method: "pe_forward", label: "", low: null, base: null, high: null, weight: 1, basis: "", notes: [] }]), null);
});

test("verification: revenue within 0.5%, shares exact, claims at least debt plus leases, non-operating assets at most cash plus investments", () => {
  const facts = [{ id: "revenue_ttm", value: 1000, unit: "USD" }, { id: "shares_diluted_weighted", value: 100, unit: "shares" }, { id: "debt", value: 150, unit: "USD" }, { id: "leases", value: 50, unit: "USD" }, { id: "cash", value: 250, unit: "USD" }, { id: "investments", value: 50, unit: "USD" }, { id: "preferred_stock", value: 20, unit: "USD" }];
  const ok = verifyCitedInputs(request(5), facts);
  assert.equal(ok.ok, true);
  assert.equal(ok.checks.find(c => c.field.includes("preferred"))!.status, "flag", "preferred stock left out of the claims is flagged, not failed");
  const wrong = verifyCitedInputs({ ...request(5), bridge: { ...bridge, nonOperatingAssets: 400, debtAndClaims: 150 }, scenarios: { ...request(5).scenarios, base: scenario({ ...fcff(5, 0.06), revenue0: 1100 } as ModelDrivers) } }, facts);
  assert.equal(wrong.ok, false);
  assert.deepEqual(wrong.checks.filter(c => c.status === "fail").map(c => c.field.split(" ")[0]), ["revenue0", "bridge.debtAndClaims", "bridge.nonOperatingAssets"]);
});

test("gates: negative scenarios and terminal share above 100% flag, terminal growth above 3% flags, above the risk-free rate fails; consensus divergence only flags", () => {
  const result = calculateValuation(request(5));
  const base = (overrides: Partial<Parameters<typeof sanityGates>[0]> = {}) => sanityGates({ result, riskFree: 0.045, anchor: null, consensus: null, triangulation: null, verification: null, impliedMultiple: null, multipleHistory: null, peers: null, ...overrides });
  const plain = base();
  assert.equal(plain.find(g => g.key === "non_negative_scenarios")!.status, "pass");
  assert.equal(plain.find(g => g.key === "terminal_share")!.status, "pass");
  assert.equal(plain.find(g => g.key === "terminal_growth")!.status, "pass");
  assert.equal(plain.find(g => g.key === "method_dispersion")!.status, "flag", "a single method is flagged");
  const consensus = base({ consensus: { mean: result.range.base * 2.5, low: null, high: null, count: 10, asOf: null, evidenceId: null } }).find(g => g.key === "consensus_divergence")!;
  assert.equal(consensus.status, "flag"); assert.ok(consensus.detail.includes("quantify"));
  const history = base({ impliedMultiple: 30, multipleHistory: { factor: "evToEbitda", periods: [], min: 10, p25: 12, median: 14, p75: 16, max: 20 } }).find(g => g.key === "implied_multiple_vs_history")!;
  assert.equal(history.status, "flag"); assert.equal(history.limit, 20);
  // A build-phase path with negative explicit cash flows: terminal share above one and a negative bear case remain visible as flags.
  const heavy = calculateValuation({ ...request(5), scenarios: { bear: scenario(fcff(5, 0.19, 0.25, { terminalGrowth: 0.04, terminalRoic: 0.10 }, { salesToCapital: fill(5, 0.3) })), base: scenario(fcff(5, 0.25, 0.3, { terminalGrowth: 0.045, terminalRoic: 0.125 }, { salesToCapital: fill(5, 0.3) })), bull: scenario(fcff(5, 0.3, 0.31, { terminalGrowth: 0.045, terminalRoic: 0.15 }, { salesToCapital: fill(5, 0.3) })) }, bridge: { ...bridge, nonOperatingAssets: 50, debtAndClaims: 600 }, discountRate: rate(0.11) });
  const gates = sanityGates({ result: heavy, riskFree: 0.045, anchor: null, consensus: null, triangulation: null, verification: null, impliedMultiple: null, multipleHistory: null, peers: null });
  assert.equal(gates.find(g => g.key === "terminal_share")!.status, "flag");
  assert.equal(gates.find(g => g.key === "non_negative_scenarios")!.status, "flag");
  assert.equal(gates.find(g => g.key === "terminal_growth")!.status, "flag");
  assert.equal(sanityGates({ result: heavy, riskFree: 0.04, anchor: null, consensus: null, triangulation: null, verification: null, impliedMultiple: null, multipleHistory: null, peers: null }).find(g => g.key === "terminal_growth")!.status, "fail");
  // Gaps carry the flags and fails, never the passes; a missing consensus is said, never skipped.
  assert.equal(plain.find(g => g.key === "consensus_unavailable")!.status, "flag");
  assert.match(plain.find(g => g.key === "consensus_unavailable")!.detail, /^consensus unavailable/);
  assert.deepEqual(gateGaps(plain).map(g => g.code), ["method_dispersion", "unverified_consensus"]);
});

const crossCheckPeers = peerMultiplesOf([
  { ticker: "A", price: 100, shares: 10, ebitda: 100, coreEarnings: 50, netDebt: 200 },
  { ticker: "B", price: 100, shares: 10, ebitda: 100, coreEarnings: 50, netDebt: 200 },
], "2026-10-31")!;
const crossCheckTrailing = { ebitda: 250, da: 50, interestExpense: 10 };

for (const [label, context] of Object.entries<NonNullable<CalcRequest["context"]>>({
  "no peers": { peers: null, trailing: crossCheckTrailing },
  "one peer without quartiles": { peers: peerMultiplesOf([{ ticker: "A", price: 100, shares: 10, ebitda: 100, coreEarnings: 50, netDebt: 200 }], "2026-10-31"), trailing: crossCheckTrailing },
  "peer multiples without usable forward metrics": { peers: crossCheckPeers },
  "usable forward methods with zero weights": { peers: crossCheckPeers, trailing: crossCheckTrailing, methodWeights: { dcf: 1, ev_ebitda_forward: 0, pe_forward: 0 } },
  "no applied methods": { peers: null, trailing: crossCheckTrailing, methodWeights: { dcf: 0, ev_ebitda_forward: 1, pe_forward: 0 } },
})) {
  test(`calculateValuation flags a missing method cross-check: ${label}`, () => {
    const result = calculateValuation(request(5, { context }));
    assert.equal(result.methods!.length, 3, "unavailable method rows remain visible");
    const applied = result.triangulation ? Object.values(result.triangulation.weights).filter(w => w > 0).length : 0;
    assert.equal(applied, label === "no applied methods" ? 0 : 1);
    const gate = result.gates!.find(g => g.key === "method_dispersion")!;
    assert.equal(gate.status, "flag", "fewer than two applied methods cannot pass the cross-check");
    assert.match(gate.detail, applied === 1 ? /single method/i : /no applied methods/i);
    assert.ok(result.limitations.some(l => /no forward-multiple cross-check/i.test(l)));
    assert.deepEqual(gateGaps([gate]), [{ code: "method_dispersion", field: "method_dispersion", message: gate.detail, evidenceIds: [] }]);
  });
}

for (const [label, peers] of Object.entries({ agreeing: crossCheckPeers, dispersed: { ...crossCheckPeers, evToEbitda: { p25: 100, median: 120, p75: 140, count: 2 } } })) {
  test(`calculateValuation checks dispersion with two applied methods: ${label}`, () => {
    const result = calculateValuation(request(5, { context: { peers, trailing: crossCheckTrailing, methodWeights: { dcf: 0.5, ev_ebitda_forward: 0.5, pe_forward: 0 } } }));
    assert.ok(result.methods!.every(m => m.base != null), "all rows have values, but the zero-weight method is excluded");
    assert.equal(Object.values(result.triangulation!.weights).filter(w => w > 0).length, 2);
    const gate = result.gates!.find(g => g.key === "method_dispersion")!;
    assert.equal(gate.status, label === "agreeing" ? "pass" : "flag");
    assert.equal(gate.value, result.triangulation!.dispersion);
    assert.match(gate.detail, /method bases span/);
    assert.equal(result.limitations.some(l => /no forward-multiple cross-check/i.test(l)), false);
    assert.equal(gateGaps([gate]).length, label === "agreeing" ? 0 : 1);
  });
}

test("calculateValuation with a context: methods, triangulation, gates, verification and the anchor ride on the result; a v2 payload reads back", () => {
  const facts = [{ id: "revenue_ttm", value: 1000, unit: "USD" }, { id: "shares_diluted_weighted", value: 100, unit: "shares" }, { id: "debt", value: 200, unit: "USD" }, { id: "cash", value: 300, unit: "USD" }];
  const peers = { peers: ["A", "B"], asOf: "2026-10-31", evToEbitda: { p25: 10, median: 12, p75: 14, count: 2 }, peRatio: { p25: 18, median: 20, p75: 22, count: 2 }, notes: [] };
  const anchor = rpoRevenueFloor({ asOf: "2026-08-31", total: 600, buckets: [{ startMonths: 0, months: 12, share: 0.5 }, { startMonths: 12, months: 12, share: 0.5 }], years: 5, revenue0: 1000 });
  const result = calculateValuation({ ...request(5), context: { facts, riskFree: 0.045, anchor, peers, trailing: { ebitda: 250, da: 50, interestExpense: 10 }, lifecycle: "growth", consensus: { mean: 12, low: 9, high: 15, count: 20, asOf: "2026-10-31", evidenceId: "e0123456789" } } });
  assert.equal(result.methods!.length, 3);
  assert.ok(result.methods!.every(m => m.base != null));
  close(result.methods!.find(m => m.method === "dcf")!.weight, 0.6);
  assert.ok(result.triangulation!.dispersion! >= 1);
  assert.equal(result.verification!.ok, true);
  assert.deepEqual(result.anchors!.revenue!.floor, [300, 300, 0, 0, 0]);
  assert.ok(result.gates!.some(g => g.key === "rpo_floor" && g.status === "pass"));
  assert.ok(result.gates!.some(g => g.key === "consensus_divergence"));
  assert.equal(result.consensus!.mean, 12);
  // The publication contract accepts the new fields and still accepts a v1 model without them.
  const publication = (model: unknown) => ({
    schemaVersion: "valuation.v1", ticker: "ACME", cik: null, companyName: "Acme", currency: "USD", researchAsOf: "2026-10-31T00:00:00.000Z", financialPeriodEnd: "2026-08-31", generatedAt: "2026-10-31T00:00:00.000Z", methodVersion: "valuation.v4", calculatorVersion: "valuation.calc.v2",
    baseInputFingerprint: "f", evidenceSetHash: "h", reportStatus: "ready", verdict: "pending", weightedScore: 6, confidence: "medium",
    dimensions: ["businessQuality", "growthExecution", "valuationSafety", "mispricingCatalysts", "financialResilience"].map(key => ({ key, score: 6, confidence: "medium", rationale: "r", supportingEvidenceIds: [], counterEvidenceIds: [], gaps: [], nextCheck: "n" })),
    quote: null, model, facts: [], diagnostics: [], distributions: [], sections: { summary: "", thesis: "", expectationsGap: "", catalysts: [], counterEvidence: [], nextChecks: [], modelNotes: "" }, evidence: [], gaps: [{ code: "method_dispersion", message: "m", evidenceIds: [] }], versionId: "v",
  });
  const v2 = readValuationPublication(publication(JSON.parse(JSON.stringify(result))), "ACME");
  assert.ok(v2); assert.equal(v2!.model!.methods!.length, 3); assert.equal(v2!.model!.gates!.length, result.gates!.length);
  const { methods, triangulation, gates, anchors, verification, peers: p, consensus, horizonYears, midYear, ...v1 } = result;
  void methods; void triangulation; void gates; void anchors; void verification; void p; void consensus; void horizonYears; void midYear;
  assert.ok(readValuationPublication(publication(JSON.parse(JSON.stringify(v1))), "ACME"));
});

test("multiple history: EV/EBITDA week by week from closes and the trailing quarter on or before each week", () => {
  const closes = [{ date: "2026-01-09", close: 10 }, { date: "2026-04-10", close: 12 }, { date: "2026-07-10", close: 15 }];
  const quarters = [{ periodEnd: "2025-12-31", ebitdaTtm: 100, netDebt: 200 }, { periodEnd: "2026-03-31", ebitdaTtm: 120, netDebt: 180 }, { periodEnd: "2026-06-30", ebitdaTtm: 150, netDebt: 150 }];
  const history = multipleHistoryOf(closes, 100, quarters)!;
  // (1000 + 200) / 100 = 12; (1200 + 180) / 120 = 11.5; (1500 + 150) / 150 = 11.
  close(history.max, 12); close(history.min, 11); close(history.median, 11.5);
  assert.equal(multipleHistoryOf(closes, 0, quarters), null);
});

test("life cycle and prior: a build-phase company gets seven years, build capex that ends, a 3% terminal growth cap and RPO-anchored growth", () => {
  const facts = [["revenue_ttm", 71.777e9, "USD"], ["operating_income_ttm", 23.056e9, "USD"], ["cfo_ttm", 46.94e9, "USD"], ["capex_ttm", 75.66e9, "USD"], ["da_ttm", 10.043e9, "USD"], ["interest_expense_ttm", 5.103e9, "USD"], ["cash", 37.077e9, "USD"], ["debt", 125.337e9, "USD"], ["leases", 30.594e9, "USD"], ["preferred_stock", 4.954e9, "USD"], ["minority_interest", 0.424e9, "USD"], ["equity", 67.196e9, "USD"], ["shares_diluted_weighted", 3.0e9, "shares"], ["effective_tax_rate_ttm", 0.1295, "ratio"], ["fcf_ttm", -28.72e9, "USD"]].map(([id, value, unit]) => ({ id: id as string, value: value as number, unit: unit as string }));
  const distribution = (factor: string, values: number[]) => ({ factor, periods: values.map((value, i) => ({ periodEnd: `20${20 + i}-05-31`, value })), min: Math.min(...values), p25: values[1]!, median: values[2]!, p75: values[3]!, max: Math.max(...values) });
  const distributions = [distribution("revenueGrowth", [0.06, 0.097, 0.149, 0.175, 0.216]), distribution("operatingMargin", [0.257, 0.283, 0.304, 0.306, 0.321]), distribution("capexToRevenue", [0.106, 0.13, 0.174, 0.37, 0.826])];
  const diagnostics = [{ key: "capexToDa", value: 7.53 }, { key: "roic", value: 0.108 }, { key: "revenueGrowthTtm", value: 0.216 }];
  assert.equal(lifecycleOf({ facts, diagnostics }), "build");
  assert.equal(lifecycleOf({ facts: facts.map(f => f.id === "fcf_ttm" ? { ...f, value: 1 } : f.id === "capex_ttm" ? { ...f, value: 5e9 } : f), diagnostics: [{ key: "capexToDa", value: 0.5 }, { key: "revenueGrowthTtm", value: 0.216 }] }), "growth");
  const rpo = { asOf: "2026-08-31", total: 664e9, buckets: [{ start: "2026-09-01", months: 12, share: 0.13 }, { start: "2027-09-01", months: 24, share: 0.37 }, { start: "2029-09-01", months: 24, share: 0.34 }] };
  const prior = priorRequest({ currency: "USD", facts, distributions, diagnostics, rpo, riskFree: 0.05, beta: 1.83, price: 130.53 })!;
  const base = prior.scenarios.base.drivers as Extract<ModelDrivers, { modelType: "fcff" }>;
  assert.equal(base.path.revenueGrowth.length, 7);
  // Contracted revenue is 120% of trailing revenue in year one and 171% in year two: a 30.8% two-year compound rate beats the 14.9% median.
  close(base.path.revenueGrowth[0]!, 0.3082, 4); close(base.path.revenueGrowth[1]!, 0.3082, 4);
  assert.ok(base.path.revenueGrowth[6]! < base.path.revenueGrowth[0]!);
  assert.equal(floorBreaches(base, prior.context!.anchor!).length, 0, "the prior's base path respects the floor");
  assert.equal(base.path.buildCapex!.filter(v => v > 0).length, 4);
  close(base.path.buildCapex![0]!, 75.66e9 - 1.5 * 10.043e9, 0);
  assert.equal(base.terminalGrowth, 0.03);
  close(prior.bridge.debtAndClaims, 125.337e9 + 30.594e9 + 4.954e9 + 0.424e9, 0);
  assert.equal(prior.context!.lifecycle, "build");
  assert.ok(prior.context!.anchor);
  const result = calculateValuation(prior);
  assert.ok(result.range.low > 0, `bear ${result.range.low}`);
  assert.ok(result.scenarios.base.result.terminalShare! < 1, `terminal share ${result.scenarios.base.result.terminalShare}`);
  assert.ok(result.gates!.every(g => g.status !== "fail"), result.gates!.filter(g => g.status === "fail").map(g => g.detail).join("; "));
  assert.equal(priorRequest({ currency: "USD", facts, distributions, diagnostics, rpo, riskFree: null, beta: 1.83, price: 130.53 }), null);
});
