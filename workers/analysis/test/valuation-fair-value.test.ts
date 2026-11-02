import assert from "node:assert/strict";
import { test } from "node:test";
import { VALUATION_DIMENSIONS, type FairValueBasis, type ModelDrivers, type NormalCaseInput, type ScenarioAssumptions, type ValuationPublication } from "../../../shared/analysis-contract/valuation.ts";
import { calculateValuation, ValuationCalcError, type CalcRequest } from "../../../shared/analysis-runtime/valuation/calculator.ts";
import { readValuationPublication } from "../../../shared/analysis-runtime/valuation/read.ts";
import { collectProse, localize } from "../../../shared/analysis-runtime/translation.ts";

const path = (growth: number, margin: number): ModelDrivers => ({ modelType: "fcff", revenue0: 1000, path: { revenueGrowth: Array(5).fill(growth), operatingMargin: Array(5).fill(margin), taxRate: Array(5).fill(0.2), salesToCapital: Array(5).fill(2) }, terminalGrowth: 0.02, terminalRoic: 0.15 });
const scenario = (growth: number, margin: number, probability: number): ScenarioAssumptions => ({ drivers: path(growth, margin), probability, narrative: "A researched operating path.", triggers: ["Demand develops as forecast."], invalidation: ["Demand deteriorates."], evidenceIds: ["e1234567890"] });
const normal = (growth: number, margin: number): NormalCaseInput => ({ drivers: path(growth, margin), narrative: "Ordinary variation in renewal demand and utilization.", triggers: ["Renewals remain within the disclosed range."], invalidation: ["A structural demand shock invalidates normal operations."], evidenceIds: ["eabcdef1234"], assumptions: { revenue: { rationale: "Renewal volumes remain inside the disclosed demand range.", evidenceIds: ["eabcdef1234"] }, margin: { rationale: "Utilization moves within the normal range.", evidenceIds: ["eabcdef1234"] }, capex: { rationale: "Planned reinvestment follows normal demand.", evidenceIds: ["eabcdef1234"] } } });
const basis = (): FairValueBasis => ({ status: "available", kind: "normal_cases", lower: normal(0.08, 0.24), upper: normal(0.12, 0.26), rationale: "The independently specified bounds reflect ordinary renewal and utilization variation documented in the filing.", evidenceIds: ["eabcdef1234"] });
const request = (): CalcRequest => ({
  modelType: "fcff", currency: "USD", discountRate: { value: 0.1, basis: "wacc", components: { riskFree: 0.045, beta: 1, equityRiskPremium: 0.05, costOfEquity: 0.095, costOfDebt: 0.06, taxRate: 0.2, equityWeight: 0.9 }, rationale: "Sourced inputs.", sourceRefs: [] },
  shares: { base: 100, dilutionReserve: 0, basis: "shares_outstanding" }, bridge: { nonOperatingAssets: 50, debtAndClaims: 100, nonOperatingEquityAdjustment: 0, notes: [] }, price: 30,
  scenarios: { bear: scenario(0.02, 0.2, 0.25), base: scenario(0.1, 0.25, 0.5), bull: scenario(0.18, 0.3, 0.25) },
  context: { facts: [{ id: "revenue_ttm", value: 1000, unit: "USD" }, { id: "shares_outstanding", value: 100, unit: "shares" }, { id: "cash", value: 50, unit: "USD" }, { id: "debt", value: 100, unit: "USD" }], riskFree: 0.045, methodWeights: { dcf: 0.5, ev_ebitda_forward: 0.3, pe_forward: 0.2 }, trailing: { ebitda: 300, da: 50, interestExpense: 6 }, peers: { peers: ["AAA", "BBB"], asOf: "2026-11-01", evToEbitda: { p25: 12, median: 15, p75: 18, count: 2 }, peRatio: { p25: 18, median: 22, p75: 26, count: 2 }, notes: [] } },
});
const publication = (model: ReturnType<typeof calculateValuation>): ValuationPublication => ({ schemaVersion: "valuation.v1", ticker: "TST", cik: null, companyName: "Test company", currency: "USD", researchAsOf: "2026-11-02", financialPeriodEnd: "2026-08-31", generatedAt: "2026-11-02", methodVersion: "valuation.v6", calculatorVersion: model.calculatorVersion, baseInputFingerprint: "input", evidenceSetHash: "evidence", reportStatus: "ready", verdict: "pending", weightedScore: 6, confidence: "medium", dimensions: VALUATION_DIMENSIONS.map(key => ({ key, score: 6, confidence: "medium", rationale: "Evidence-backed research.", supportingEvidenceIds: [], counterEvidenceIds: [], gaps: [], nextCheck: "Next release." })), quote: null, model, facts: [], diagnostics: [], distributions: [], sections: { summary: "", thesis: "", expectationsGap: "", catalysts: [], counterEvidence: [], nextChecks: [], modelNotes: "" }, evidence: [], gaps: [], versionId: "version" });

test("normal range is independently calculated, keeps original probabilities and stress values, and follows path changes rather than a price percentage", () => {
  const r = request(), old = calculateValuation(r), result = calculateValuation({ ...r, fairValueBasis: basis() });
  const fair = result.fairValueRange;
  assert.ok(fair?.status === "available");
  assert.deepEqual(result.range, old.range);
  assert.deepEqual(result.scenarios, old.scenarios);
  assert.equal(fair.base, result.range.base);
  assert.ok(fair.low > result.range.low && fair.high < result.range.high);
  assert.equal(fair.low, fair.lower.valuation.perShare);
  assert.equal(fair.high, fair.upper.valuation.perShare);
  assert.deepEqual(fair.lower.valuation.weights, result.scenarios.base.valuation?.weights);
  assert.ok(fair.lower.verification?.ok && fair.upper.verification?.ok);
  assert.equal("probability" in fair.lower, false);
  assert.deepEqual(calculateValuation({ ...r, price: 300, fairValueBasis: basis() }).fairValueRange, fair);
  const changed = basis();
  assert.ok(changed.status === "available");
  changed.upper = normal(0.14, 0.27);
  const next = calculateValuation({ ...r, fairValueBasis: changed }).fairValueRange;
  assert.ok(next?.status === "available" && next.high > fair.high && next.low === fair.low);
});

test("normal paths reject wrong order, model/horizon, nonfinite values, source mismatches and failing gates", () => {
  const rejects = (edit: (b: Extract<FairValueBasis, { status: "available" }>) => void, message: RegExp) => {
    const b = basis(); assert.ok(b.status === "available"); edit(b);
    assert.throws(() => calculateValuation({ ...request(), fairValueBasis: b }), e => e instanceof ValuationCalcError && message.test(e.message));
  };
  rejects(b => { b.lower = normal(0.14, 0.27); }, /out of order/);
  rejects(b => { b.lower.drivers = { modelType: "earnings_multiple", epsLow: 1, epsHigh: 2, weight: 0.5, multiple: 20, horizonYears: 3 }; }, /base model type/);
  rejects(b => { if (b.lower.drivers.modelType === "fcff") b.lower.drivers.path.revenueGrowth.push(0.08); }, /forecast horizon/);
  rejects(b => { if (b.lower.drivers.modelType === "fcff") b.lower.drivers.revenue0 = Infinity; }, /finite/);
  rejects(b => { if (b.lower.drivers.modelType === "fcff") b.lower.drivers.revenue0 = 900; }, /cited_inputs/);
  rejects(b => { if (b.upper.drivers.modelType === "fcff") b.upper.drivers.terminalGrowth = 0.06; }, /terminal_growth/);
});

test("normal range never hides unavailable positive-weight methods; explicit unavailability and old reports stay unestimated", () => {
  const r = request();
  assert.throws(() => calculateValuation({ ...r, context: { ...r.context, peers: null }, fairValueBasis: basis() }), /positive-weight methods.*unavailable/);
  const absent = { status: "unavailable", reason: "Normal demand bounds lack sufficient evidence.", evidenceIds: [] } satisfies FairValueBasis;
  assert.deepEqual(calculateValuation({ ...r, fairValueBasis: absent }).fairValueRange, absent);
  assert.equal(calculateValuation(r).fairValueRange, undefined);
  assert.equal(readValuationPublication(publication(calculateValuation(r)), "TST")?.model?.fairValueRange, undefined);
});

test("normal range survives publication parsing and translation; malformed persisted bands are rejected", () => {
  const report = publication(calculateValuation({ ...request(), fairValueBasis: basis() }));
  const read = readValuationPublication(JSON.parse(JSON.stringify(report)), "TST");
  assert.deepEqual(read?.model?.fairValueRange, report.model?.fairValueRange);
  const fair = read?.model?.fairValueRange; assert.ok(fair?.status === "available");
  const prose = collectProse("valuation", report);
  assert.ok(prose.includes(fair.rationale) && prose.includes(fair.lower.assumptions.revenue.rationale));
  const localized = localize("valuation", report, { [fair.rationale]: "正常经营区间依据。", [fair.lower.assumptions.revenue.rationale]: "收入路径依据。" });
  assert.ok(localized.model?.fairValueRange?.status === "available");
  assert.equal(localized.model.fairValueRange.rationale, "正常经营区间依据。");
  assert.equal(localized.model.fairValueRange.low, fair.low);
  assert.deepEqual(localized.model.fairValueRange.lower.evidenceIds, fair.lower.evidenceIds);
  fair.base += 1;
  assert.equal(readValuationPublication(read, "TST"), null);
});


test("non-positive normal residuals are retained rather than changed to pass an economic gate", () => {
  const r = request(); r.bridge.debtAndClaims = 10000;
  r.context!.facts = r.context!.facts!.map(f => f.id === "debt" ? { ...f, value: 10000 } : f);
  const result = calculateValuation({ ...r, fairValueBasis: basis() });
  const fair = result.fairValueRange; assert.ok(fair?.status === "available");
  assert.ok(fair.low < fair.base && fair.base < fair.high && fair.high < 0);
  assert.equal(result.gates!.find(g => g.key === "non_negative_scenarios")!.status, "flag");
  assert.ok(!result.gates!.some(g => g.status === "fail"));
  assert.deepEqual(readValuationPublication(publication(result), "TST")?.model?.fairValueRange, fair);
});
