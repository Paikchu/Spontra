/** Synthetic analyst journey through the registered tool and the public valuation projection. No model, network or production writes. */
import assert from "node:assert/strict";
import { calculateImpact, priceImpactOf, scenarioWeightedValue, validateImpactChannels, type ImpactCalculationInput } from "../shared/analysis-runtime/price-impact.ts";
import { impactCalculationTool } from "../workers/analysis/src/price-impact/tool.ts";
import type { ValuationPublication } from "../shared/analysis-contract/valuation.ts";

const results: Array<{ checkpoint: string; status: "pass"; actual: unknown }> = [];
function check(checkpoint: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, checkpoint); results.push({ checkpoint, status: "pass", actual }); }
const interest = (years: number) => calculateImpact({ kind: "interest", currency: "USD", debts: [{ principal: 1e9, rateType: "floating", rateChange: 0.01, repricingYears: years }] });
check("T01 actual repricing time", [interest(1).values.pretaxInterestChange, interest(0.5).values.pretaxInterestChange], [1e7, 5e6]);
check("T02 fixed coupon unchanged", calculateImpact({ kind: "interest", currency: "USD", debts: [{ principal: 2e9, rateType: "fixed", rateChange: 0.01, repricingYears: null }, { principal: 1e9, rateType: "floating", rateChange: 0.01, repricingYears: 1 }] }).values.pretaxInterestChange, 1e7);
const equity = calculateImpact({ kind: "equity_financing", currency: "USD", equityValue: 1e10, shares: 1e8, proceeds: 1e9, issuePrice: 100, fees: 0, cashDeployed: 0, acquiredAssetValue: 0 });
check("T03 financing adds cash and shares", [equity.values.postFinancingEquityValue, equity.values.postFinancingShares, equity.values.postFinancingPerShare], [1.1e10, 1.1e8, 100]);
const prices = calculateImpact({ kind: "price_comparison", currency: "USD", beforeValue: 120, afterValue: 110, referencePrice: 100, latestPrice: 90 });
check("T04 independent value and market comparisons", Object.fromEntries(Object.entries(prices.values).map(([k, v]) => [k, Number(v.toFixed(8))])), { eventValueChange: -10, eventValueChangeFraction: -0.08333333, gapToReference: 0.1, marketChangeFraction: -0.1 });
check("T05 reclassification does not imply refund", calculateImpact({ kind: "contract_reclassification", currency: "USD", reclassifiedAmount: 1.9e9, verifiedRefund: null }).status, "unavailable");
check("T06 incompatible windows rejected", calculateImpact({ kind: "period_ratio", currency: "USD", numerator: 1e9, denominator: 1e8, numeratorStart: "2026-10-01", numeratorEnd: "2028-09-30", denominatorStart: "2026-01-01", denominatorEnd: "2026-09-30", numeratorDirection: "forward", denominatorDirection: "historical" }).status, "unavailable");
check("T07 missing contract exposure", calculateImpact({ kind: "revenue_exposure", currency: "USD", revenue: 1e9, exposedShare: null, priceChange: 0.2, periodFraction: 1, exposureBasis: "unknown" }).status, "unavailable");
const channel = { shockId: "original-demand-release", financialVariable: "revenue", period: "2027", exposureId: "ai-cloud-us", sourceIds: ["original-release"] };
check("T09 duplicate macro/industry shock rejected", validateImpactChannels([channel, { ...channel }]).length, 1);
check("T12 invalid scenario not reweighted", scenarioWeightedValue([{ valid: true, perShare: 100, probability: 0.5, evidenceIds: ["e1"] }, { valid: false, perShare: null, probability: 0.5, evidenceIds: ["e2"] }]), null);
check("T13 missing versus verified zero", [calculateImpact({ kind: "contract_reclassification", currency: "USD", reclassifiedAmount: 0, verifiedRefund: null }).status, calculateImpact({ kind: "contract_reclassification", currency: "USD", reclassifiedAmount: 0, verifiedRefund: 0 }).values.verifiedCashOutflow], ["unavailable", 0]);
const depreciation = calculateImpact({ kind: "depreciation", currency: "USD", depreciableBasis: 120, beforeYears: 6, afterYears: 4 });
check("T15 accounting sensitivity has no cash replacement", [depreciation.values.annualDepreciationChange, Object.keys(depreciation.values)], [10, ["annualDepreciationChange"]]);
check("Period-end capacity not average", calculateImpact({ kind: "capacity_economics", currency: "USD", revenue: 100, periodYears: 1, capacityMw: 2, capacityBasis: "period_end", gpuPerMw: 500, utilization: 1, comparableGpuMix: true }).status, "unavailable");
check("Restricted cash unavailable for debt service", calculateImpact({ kind: "cash_gap", currency: "USD", cash: 100, restrictedCash: 60, cashInflows: 0, committedFinancing: 0, cashOutflows: 80 }).values.fundingGap, 40);
const state = { values: { debt: [1e9], rate: [0.01], time: [0.5] } as Record<string, number[]>, records: [] as unknown[] };
const tool = impactCalculationTool<typeof state>({ sourceExists: (s, id) => id in s.values, sourceValues: (s, id) => s.values[id] ?? null, sourceCalculation: () => null, record: (s, value, inputs) => { s.records.push({ value, inputs }); return `calculation-${s.records.length}`; } });
const calculation: ImpactCalculationInput = { kind: "interest", currency: "USD", debts: [{ principal: 1e9, rateType: "floating", rateChange: 0.01, repricingYears: 0.5 }] };
const inputs = [{ path: "debts.0.principal", sourceId: "debt", basis: "fact", rationale: "synthetic disclosed principal" }, { path: "debts.0.rateChange", sourceId: "rate", basis: "assumption", rationale: "synthetic rate sensitivity" }, { path: "debts.0.repricingYears", sourceId: "time", basis: "fact", rationale: "synthetic reset window" }];
const ctx = { state, signal: new AbortController().signal, recipe: "synthetic-impact-journey", stage: async <T>(_name: string, work: () => Promise<T>) => work() };
const accepted = await tool.execute({ calculation, inputs }, ctx);
check("Analyst calculates and records cited sensitivity", [accepted.error, state.records.length, JSON.parse(accepted.observation).values.pretaxInterestChange], [false, 1, 5e6]);
const rejected = await tool.execute({ calculation: { ...calculation, debts: [{ ...calculation.debts[0], principal: 2e9 }] }, inputs }, ctx);
check("Analyst fabricated numeric fact blocked", [rejected.error, state.records.length], [true, 1]);
// Explicit synthetic report; no fabricated production conclusions or data are published.
const model = { calculatorVersion: "synthetic", modelType: "fcff", currency: "USD", shares: { economic: 1e8 }, scenarios: Object.fromEntries(["bear", "base", "bull"].map((key, i) => [key, { narrative: "Synthetic scenario", triggers: ["Synthetic trigger"], invalidation: ["Synthetic counterevidence"], evidenceIds: ["e1"], result: { perShare: 90 + i * 20 } }])), sensitivities: [], verification: { ok: true }, gates: [], forward: { months: 12 } };
const report = { versionId: "aabbccdd", ticker: "SYNTHETIC", financialPeriodEnd: "2026-09-30", researchAsOf: "2026-11-10", generatedAt: "2026-11-10T12:00:00Z", baseInputFingerprint: "synthetic", calculatorVersion: "synthetic", currency: "USD", reportStatus: "ready", quote: { price: 100, currency: "USD", priceDate: "2026-11-09", source: "synthetic", sourceUrl: "https://example.invalid/fixture", fetchedAt: "2026-11-10", usable: true, limitations: [] }, model, gaps: [], facts: [], diagnostics: [], evidence: [{ evidenceId: "e1" }], sections: { counterEvidence: ["Synthetic counterevidence"], nextChecks: ["Synthetic check"] } } as unknown as ValuationPublication;
const projection = priceImpactOf(report, { latestQuote: { ...report.quote!, price: 90, priceDate: "2026-11-11" } });
check("Summary projection freezes denominator and identity", [projection.resultId, projection.referenceQuote?.price, projection.latestQuote?.price, projection.eventChange, Number(projection.scenarios[1]!.gapToReference!.toFixed(8))], ["price-impact:aabbccdd", 100, 90, null, 0.1]);
check("Incomplete review withholds scenarios", priceImpactOf({ ...report, gaps: [{ code: "review_incomplete", message: "Synthetic pending review", evidenceIds: [] }] }).quantificationStatus, "unavailable");
check("Updating publication withholds current claims", priceImpactOf(report, { outdated: true }).quantificationStatus, "unavailable");
check("Mixed currency withholds model", priceImpactOf({ ...report, currency: "EUR" }).quantificationStatus, "unavailable");
console.log(JSON.stringify({ fixtureKind: "synthetic", modelCalls: 0, productionWrites: 0, results, notCovered: ["T08 source revision storage", "T10 translation", "T11 public research version freeze", "T14 atomic publication", "real-source evidence review", "production browser"] }, null, 2));
