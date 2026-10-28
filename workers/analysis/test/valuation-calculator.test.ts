import assert from "node:assert/strict";
import { test } from "node:test";
import type { CalcRequest } from "../../../shared/analysis-runtime/valuation/calculator.ts";
import { calculateValuation, dimensionCeilings, discountRateBaseline, distributionOf, impliedGrowth, outsideHistory, overallConfidence, percentileRank, scenarioValue, treasuryStockDilution, valuationRange, valueDriverTerminal, verdictOf, weightedScore, ValuationCalcError } from "../../../shared/analysis-runtime/valuation/calculator.ts";
import type { ModelDrivers, ScenarioAssumptions } from "../../../shared/analysis-contract/valuation.ts";

const close = (actual: number, expected: number, digits = 2) => assert.equal(Number(actual.toFixed(digits)) + 0, Number(expected.toFixed(digits)) + 0);
const bridge = { nonOperatingAssets: 0, debtAndClaims: 0, nonOperatingEquityAdjustment: 0, notes: [] };
const zeros = [0, 0, 0, 0, 0];
const scenario = (drivers: ModelDrivers, probability: number | null = null): ScenarioAssumptions => ({ narrative: "", probability, triggers: [], invalidation: [], evidenceIds: [], drivers });
const rate = (value: number, basis: "wacc" | "cost_of_equity") => ({ value, basis, components: { riskFree: null, beta: null, equityRiskPremium: null, costOfEquity: null, costOfDebt: null, taxRate: null, equityWeight: null }, rationale: "", sourceRefs: [] });

test("FCFE constant: CF 100 for five years at 10% with no terminal growth is worth 1000, 10 per share", () => {
  const result = scenarioValue({ modelType: "fcfe", cfo: 150, capex: 20, sbc: 30, normalization: 0, netBorrowing: 0, growth: zeros, terminalGrowth: 0 }, 0.10, 100, bridge);
  close(result.equityValue, 1000); close(result.perShare, 10);
  assert.equal(result.yearly.length, 5); close(result.yearly[0]!.cashFlow, 100);
});

test("FCFF bridge: operating value 1000, plus 200 non-operating assets, minus 300 claims, 9 per share", () => {
  const drivers: ModelDrivers = { modelType: "fcff", revenue0: 1000, path: { revenueGrowth: zeros, operatingMargin: [0.1, 0.1, 0.1, 0.1, 0.1], taxRate: zeros, salesToCapital: [2, 2, 2, 2, 2] }, terminalGrowth: 0, terminalRoic: 0.15 };
  const result = scenarioValue(drivers, 0.10, 100, { ...bridge, nonOperatingAssets: 200, debtAndClaims: 300 });
  close(result.enterpriseValue!, 1000); close(result.equityValue, 900); close(result.perShare, 9);
});

test("value-driver terminal: growth is paid for with reinvestment", () => {
  close(valueDriverTerminal(100, 0.10, 0.03, 0.15).terminalValue, 1177.14);
  close(valueDriverTerminal(100, 0.10, 0.03, 0.15).reinvestmentRate, 0.2);
  close(valueDriverTerminal(100, 0.10, 0.03, 0.10).terminalValue, 1030);
});

test("driver path: revenue 1000 to 1100 at sales-to-capital 2 reinvests 50; 15% margin gives FCFF 115", () => {
  const drivers: ModelDrivers = { modelType: "fcff", revenue0: 1000, path: { revenueGrowth: [0.1, 0, 0, 0, 0], operatingMargin: [0.15, 0.15, 0.15, 0.15, 0.15], taxRate: zeros, salesToCapital: [2, 2, 2, 2, 2] }, terminalGrowth: 0, terminalRoic: 0.15 };
  const result = scenarioValue(drivers, 0.10, 100, bridge);
  close(result.yearly[0]!.reinvestment!, 50); close(result.yearly[0]!.cashFlow, 115); close(result.yearly[0]!.revenue!, 1100);
});

test("residual income with zero excess return is worth book; with excess returns 1321.94", () => {
  const zero = scenarioValue({ modelType: "residual_income", bookEquity0: 1000, roe: [0.1, 0.1, 0.1, 0.1, 0.1], payout: [1, 1, 1, 1, 1], terminalRoe: 0.10, terminalGrowth: 0 }, 0.10, 100, bridge);
  close(zero.equityValue, 1000); close(zero.perShare, 10);
  assert.ok(zero.yearly.every(y => Math.abs(y.cashFlow) < 1e-9));
  const excess = scenarioValue({ modelType: "residual_income", bookEquity0: 1000, roe: [0.12, 0.12, 0.12, 0.12, 0.12], payout: [0.5, 0.5, 0.5, 0.5, 0.5], terminalRoe: 0.12, terminalGrowth: 0.03 }, 0.10, 100, bridge);
  close(excess.equityValue, 1321.94); close(excess.perShare, 13.2194, 4);
  assert.ok(excess.notes.some(n => n.includes("75.0%")));
});

test("earnings multiple and NAV", () => {
  close(scenarioValue({ modelType: "earnings_multiple", epsLow: 2, epsHigh: 2, weight: 0.5, multiple: 15, horizonYears: 0 }, 0.10, 100, bridge).perShare, 30);
  const nav = scenarioValue({ modelType: "asset_nav", assets: [{ units: 10, price: 100, costBasis: 100, taxRate: 0 }], otherNetAssets: 50, debtClaims: 200, preferredClaims: 100, operatingReserve: 50 }, 0.10, 100, bridge);
  close(nav.equityValue, 700); close(nav.perShare, 7);
});

test("cost of capital baseline", () => {
  const baseline = discountRateBaseline({ riskFree: 0.04, beta: 1.2, equityRiskPremium: 0.05, costOfDebt: 0.06, taxRate: 0.25, equityWeight: 0.8 }, "wacc")!;
  close(baseline.costOfEquity, 0.10, 4); close(baseline.value, 0.089, 4);
  assert.equal(discountRateBaseline({ riskFree: 0.04, beta: 1.2, equityRiskPremium: 0.05, costOfDebt: null, taxRate: null, equityWeight: null }, "wacc"), null);
});

test("treasury stock method: 100 base shares, 10 options at 10 against a price of 25 → 106", () => {
  close(treasuryStockDilution({ options: 10, weightedStrike: 10, unvestedUnits: 0, price: 25 }), 6);
});

test("range: probability-weighted expected value, margin of safety and downside coverage", () => {
  const range = valuationRange({ bear: 50, base: 100, bull: 160 }, 102.5, 80);
  close(range.marginOfSafety!, 0.2); close(range.baseUpside!, 0.25); close(range.expectedUpside!, 0.28125, 5); close(range.downsideCoverage!, -0.375, 4);
  assert.equal(valuationRange({ bear: 50, base: 100, bull: 160 }, null, null).marginOfSafety, null);
});

test("history distribution: 14 sits at the 75th percentile of 10..16; 18 and 9 fall outside", () => {
  const history = distributionOf("operatingMargin", [10, 11, 12, 12, 13, 14, 15, 16].map((value, i) => ({ periodEnd: `20${10 + i}-12-31`, value })))!;
  close(percentileRank(history, 14), 0.75); assert.equal(outsideHistory(history, 18), true); assert.equal(outsideHistory(history, 9), true); assert.equal(outsideHistory(history, 12), false);
  assert.equal(history.min, 10); assert.equal(history.max, 16); close(history.median, 12.5);
});

test("weighted score: 8/7/6/5/9 → 6.7; any null → null; confidence is the lowest", () => {
  const dims = [["businessQuality", 8], ["growthExecution", 7], ["valuationSafety", 6], ["mispricingCatalysts", 5], ["financialResilience", 9]] as const;
  assert.equal(weightedScore(dims.map(([key, score]) => ({ key, score }))), 6.7);
  assert.equal(weightedScore(dims.map(([key, score], i) => ({ key, score: i === 2 ? null : score }))), null);
  assert.equal(weightedScore([{ key: "businessQuality", score: 7.3 }, ...dims.slice(1).map(([key, score]) => ({ key, score }))]), null);
  assert.equal(overallConfidence(dims.map(([key, score], i) => ({ key, score, confidence: i === 1 ? "medium" as const : "high" as const }))), "medium");
  assert.equal(overallConfidence(dims.map(([key, score], i) => ({ key, score: i === 4 ? null : score, confidence: "high" as const }))), "low");
});

test("verdict order: not_supported, supported, pending", () => {
  const dims = (mc: number, conf: "high" | "medium" | "low" = "high") => [["businessQuality", 8], ["growthExecution", 7], ["valuationSafety", 6], ["mispricingCatalysts", mc], ["financialResilience", 9]].map(([key, score]) => ({ key: key as never, score: score as number, confidence: conf }));
  assert.equal(verdictOf({ dimensions: dims(8), marginOfSafety: -0.1, hasModel: true, decisiveCounterEvidence: false, coreLogicFailed: false }), "not_supported");
  assert.equal(verdictOf({ dimensions: dims(8), marginOfSafety: 0.2, hasModel: true, decisiveCounterEvidence: false, coreLogicFailed: false }), "supported");
  assert.equal(verdictOf({ dimensions: dims(7.5), marginOfSafety: 0.2, hasModel: true, decisiveCounterEvidence: false, coreLogicFailed: false }), "pending");
  assert.equal(verdictOf({ dimensions: dims(8, "low"), marginOfSafety: 0.2, hasModel: true, decisiveCounterEvidence: false, coreLogicFailed: false }), "pending");
  assert.equal(verdictOf({ dimensions: dims(8), marginOfSafety: null, hasModel: false, decisiveCounterEvidence: false, coreLogicFailed: false }), "pending");
  assert.equal(verdictOf({ dimensions: dims(8), marginOfSafety: 0.2, hasModel: true, decisiveCounterEvidence: false, coreLogicFailed: true }), "not_supported");
});

test("ceilings follow the numbers", () => {
  assert.equal(dimensionCeilings({ marginOfSafety: -0.05, downsideCoverage: null, bearProbability: null, terminalShare: null, hasIndependentConsensus: false, impliedGap: null, impliedGapThreshold: null, goingConcernUnresolved: false }).valuationSafety, 5.5);
  const c = dimensionCeilings({ marginOfSafety: 0.2, downsideCoverage: -0.5, bearProbability: 0.3, terminalShare: 0.85, hasIndependentConsensus: false, impliedGap: 0.01, impliedGapThreshold: 0.03, goingConcernUnresolved: true });
  assert.equal(c.valuationSafety, 7.5); assert.equal(c.mispricingCatalysts, 6); assert.equal(c.financialResilience, 7.5);
  assert.equal(dimensionCeilings({ marginOfSafety: 0.2, downsideCoverage: -0.1, bearProbability: 0.3, terminalShare: 0.5, hasIndependentConsensus: false, impliedGap: 0.08, impliedGapThreshold: 0.03, goingConcernUnresolved: false }).mispricingCatalysts, undefined);
});

const fcff = (growth: number, margin = 0.2, s2c = 2): ModelDrivers => ({ modelType: "fcff", revenue0: 1000, path: { revenueGrowth: [growth, growth, growth, growth, growth], operatingMargin: [margin, margin, margin, margin, margin], taxRate: [0.2, 0.2, 0.2, 0.2, 0.2], salesToCapital: [s2c, s2c, s2c, s2c, s2c] }, terminalGrowth: 0.03, terminalRoic: 0.15 });
const request = (price: number | null, probabilities: [number | null, number | null, number | null] = [null, null, null]): CalcRequest => ({
  modelType: "fcff", currency: "USD", discountRate: rate(0.09, "wacc"), shares: { base: 100, dilutionReserve: 2, basis: "diluted" }, bridge: { ...bridge, nonOperatingAssets: 300, debtAndClaims: 200 }, price,
  scenarios: { bear: scenario(fcff(0.02, 0.17), probabilities[0]), base: scenario(fcff(0.06), probabilities[1]), bull: scenario(fcff(0.10, 0.22), probabilities[2]) },
});

test("full model: ordered scenarios, sensitivities by impact, implied growth recovers the price", () => {
  const base = request(null);
  const result = calculateValuation(base);
  assert.ok(result.range.low < result.range.base && result.range.base < result.range.high);
  assert.equal(result.shares.economic, 102);
  assert.ok(result.sensitivities.length >= 5);
  for (let i = 1; i < result.sensitivities.length; i++) assert.ok(Math.abs(result.sensitivities[i - 1]!.changePercent) >= Math.abs(result.sensitivities[i]!.changePercent));
  // A price equal to the base value is explained by the base's average growth.
  const priced = calculateValuation({ ...base, price: result.range.base });
  assert.ok(priced.implied && priced.implied.converged); close(priced.implied!.implied, 0.06, 4); close(priced.implied!.gap, 0, 4);
  close(priced.range.marginOfSafety!, 0, 6);
  // Explicit probabilities give an expected value; a partial set is rejected.
  const weighted = calculateValuation(request(80, [0.25, 0.5, 0.25]));
  close(weighted.range.expected!, 0.25 * weighted.range.low + 0.5 * weighted.range.base + 0.25 * weighted.range.high, 6);
  assert.throws(() => calculateValuation(request(80, [0.25, null, null])), ValuationCalcError);
});

test("rejections: r <= g, shares <= 0, a bull case that grows faster but reinvests less, out-of-order scenarios, wrong rate basis", () => {
  assert.throws(() => scenarioValue(fcff(0.05), 0.03, 100, bridge), (e: unknown) => e instanceof ValuationCalcError && e.code === "rate_order");
  assert.throws(() => scenarioValue(fcff(0.05), 0.10, 0, bridge), (e: unknown) => e instanceof ValuationCalcError && e.code === "shares");
  const lazyBull = request(null); lazyBull.scenarios.bull = scenario(fcff(0.10, 0.22, 10));
  assert.throws(() => calculateValuation(lazyBull), (e: unknown) => e instanceof ValuationCalcError && /reinvestment_inconsistent/.test(e.message));
  const inverted = request(null); inverted.scenarios.bull = scenario(fcff(0.01, 0.1));
  assert.throws(() => calculateValuation(inverted), (e: unknown) => e instanceof ValuationCalcError && e.code === "scenario_order");
  assert.throws(() => calculateValuation({ ...request(null), discountRate: rate(0.09, "cost_of_equity") }), ValuationCalcError);
  assert.equal(impliedGrowth(request(null), 0.09, 102, 1e9)?.converged, false);
});
