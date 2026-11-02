import assert from "node:assert/strict";
import { test } from "node:test";
import { VALUATION_DIMENSIONS, type CapitalPlan, type ManagementTargetSet, type ModelDrivers, type NormalCaseInput, type ScenarioAssumptions, type ValuationPublication } from "../../../shared/analysis-contract/valuation.ts";
import { CALCULATOR_VERSION, calculateValuation, forwardFundamentals, scenarioValue, ValuationCalcError, type CalcRequest } from "../../../shared/analysis-runtime/valuation/calculator.ts";
import { managementDrivers } from "../../../shared/analysis-runtime/valuation/management.ts";
import { readValuationPublication } from "../../../shared/analysis-runtime/valuation/read.ts";
import { valuationTools } from "../src/valuation/tools.ts";
import { toolSchema } from "../src/tools/registry.ts";

const fill = (n: number) => Array(5).fill(n);
const bridge = { nonOperatingAssets: 50, debtAndClaims: 100, nonOperatingEquityAdjustment: 0, notes: [] };
const plan = (): CapitalPlan => ({ capex: [100, 90, 80, 70, 60], depreciation: [30, 35, 40, 45, 50], workingCapitalChange: [15, -20, 10, 10, 10] });
const explicit = (growth = 0.1, margin = 0.25): Extract<ModelDrivers, { modelType: "fcff" }> => ({ modelType: "fcff", revenue0: 1000, path: { revenueGrowth: fill(growth), operatingMargin: fill(margin), taxRate: fill(0.2), capitalPlan: plan() }, terminalGrowth: 0.02, terminalRoic: 0.15 });
const implicit = (): Extract<ModelDrivers, { modelType: "fcff" }> => ({ ...explicit(), path: { revenueGrowth: fill(0.1), operatingMargin: fill(0.25), taxRate: fill(0.2), salesToCapital: fill(2), buildCapex: [10, 5, 0, 0, 0] } });
const scenario = (drivers: ModelDrivers): ScenarioAssumptions => ({ drivers, narrative: "Normal operations and planned capital investments.", probability: null, triggers: ["Demand follows the disclosed plan."], invalidation: ["Demand weakens materially."], evidenceIds: ["e1234567890"] });
const request = (): CalcRequest => ({ modelType: "fcff", currency: "USD", discountRate: { value: 0.1, basis: "wacc", components: { riskFree: 0.04, beta: 1, equityRiskPremium: 0.06, costOfEquity: 0.1, costOfDebt: 0.05, taxRate: 0.2, equityWeight: 0.8 }, rationale: "Sourced rate components.", sourceRefs: [] }, shares: { base: 100, dilutionReserve: 0, basis: "shares_outstanding" }, bridge, price: 30, scenarios: { bear: scenario(explicit(0.05, 0.22)), base: scenario(explicit()), bull: scenario(explicit(0.15, 0.28)) } });
const normal = (drivers: ModelDrivers): NormalCaseInput => ({ drivers, narrative: "Ordinary variation in the capital execution plan.", triggers: ["Projects begin on schedule."], invalidation: ["A structural delay occurs."], evidenceIds: ["e1234567890"], assumptions: { revenue: { rationale: "Disclosed demand range.", evidenceIds: ["e1234567890"] }, margin: { rationale: "Normal utilization range.", evidenceIds: ["e1234567890"] }, capex: { rationale: "Evidence-backed construction and working-capital schedule.", evidenceIds: ["e1234567890"] } } });
const publication = (model: ReturnType<typeof calculateValuation>): ValuationPublication => ({ schemaVersion: "valuation.v1", ticker: "TST", cik: null, companyName: "Test company", currency: "USD", researchAsOf: "2026-11-03", financialPeriodEnd: "2026-08-31", generatedAt: "2026-11-03", methodVersion: "valuation.v6", calculatorVersion: model.calculatorVersion, baseInputFingerprint: "input", evidenceSetHash: "evidence", reportStatus: "ready", verdict: "pending", weightedScore: 6, confidence: "medium", dimensions: VALUATION_DIMENSIONS.map(key => ({ key, score: 6, confidence: "medium", rationale: "Evidence-backed research.", supportingEvidenceIds: [], counterEvidenceIds: [], gaps: [], nextCheck: "Next release." })), quote: null, model, facts: [], diagnostics: [], distributions: [], sections: { summary: "", thesis: "", expectationsGap: "", catalysts: [], counterEvidence: [], nextChecks: [], modelNotes: "" }, evidence: [], gaps: [], versionId: "version" });
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("explicit capital spending produces NOPAT + D&A - capex - working capital without implicit reinvestment", () => {
  const drivers = explicit(), result = scenarioValue(drivers, 0.1, 100, bridge);
  const first = result.yearly[0]!;
  close(first.revenue!, 1100); close(first.nopat!, 220);
  close(first.reinvestment!, 85); close(first.cashFlow, 135);
  assert.equal(first.capex, 100); assert.equal(first.depreciation, 30); assert.equal(first.workingCapitalChange, 15);
  assert.equal(first.buildCapex, undefined);
  const second = result.yearly[1]!;
  close(second.reinvestment!, 35); close(second.cashFlow, 207);
  assert.equal(second.workingCapitalChange, -20, "a sourced working-capital release is not clamped");
  const future = forwardFundamentals(drivers, 1, { da0: 999, interestExpense0: 5, shares: 100 });
  close(future.ebit, 275); close(future.ebitda!, 305);
  close(forwardFundamentals(drivers, 1, { da0: null, interestExpense0: 5, shares: 100 }).ebitda!, 305);
});

test("legacy revenue-growth reinvestment and null capital plans retain their previous cash flows", () => {
  const drivers = implicit(), old = scenarioValue(drivers, 0.1, 100, bridge);
  close(old.yearly[0]!.reinvestment!, 60); close(old.yearly[0]!.cashFlow, 160);
  assert.equal(old.yearly[0]!.capex, undefined);
  const withNull = { ...drivers, path: { ...drivers.path, capitalPlan: null } };
  assert.deepEqual(scenarioValue(withNull, 0.1, 100, bridge), old);
  close(forwardFundamentals(drivers, 1, { da0: 30, interestExpense0: 5, shares: 100 }).ebitda!, 308);
});

test("capital plans reject mixed modes, wrong lengths, negative gross spending or depreciation, and nonfinite inputs", () => {
  const rejects = (mutate: (d: Extract<ModelDrivers, { modelType: "fcff" }>) => void, message: RegExp) => { const d = explicit(); mutate(d); assert.throws(() => scenarioValue(d, 0.1, 100, bridge), e => e instanceof ValuationCalcError && message.test(e.message)); };
  rejects(d => { Object.assign(d.path, { salesToCapital: fill(2) }); }, /mutually exclusive/);
  rejects(d => { Object.assign(d.path, { buildCapex: fill(0) }); }, /mutually exclusive/);
  rejects(d => { d.path.capitalPlan!.capex.pop(); }, /list 5 yearly values/);
  rejects(d => { d.path.capitalPlan!.capex[0] = -1; }, /non-negative/);
  rejects(d => { d.path.capitalPlan!.depreciation[0] = -1; }, /non-negative/);
  rejects(d => { d.path.capitalPlan!.workingCapitalChange[0] = NaN; }, /finite/);
  rejects(d => { d.path.capitalPlan!.capex[0] = Infinity; }, /finite/);
});

test("normal bounds preserve complete plans and share the base investment mode; sensitivities perturb actual capex", () => {
  const r = request();
  r.fairValueBasis = { status: "available", kind: "normal_cases", lower: normal(explicit(0.08, 0.24)), upper: normal(explicit(0.12, 0.26)), rationale: "Normal construction, demand and working-capital variation determines the explicit paths.", evidenceIds: ["e1234567890"] };
  const model = calculateValuation(r), fair = model.fairValueRange;
  assert.equal(model.calculatorVersion, "valuation.calc.v6");
  assert.ok(fair?.status === "available");
  assert.ok(fair.lower.drivers.modelType === "fcff"); assert.deepEqual(fair.lower.drivers.path.capitalPlan, plan());
  assert.equal(model.sensitivities.some(s => s.factor === "salesToCapital"), false);
  assert.ok(model.sensitivities.some(s => s.factor === "capex" && s.changePercent < 0));
  const read = readValuationPublication(publication(model), "TST");
  assert.deepEqual(read?.model?.fairValueRange, fair); assert.deepEqual(read?.model?.scenarios.base.result.yearly, model.scenarios.base.result.yearly);
  r.fairValueBasis.lower = normal(implicit());
  assert.throws(() => calculateValuation(r), /base investment mode/);
  const legacy = request(); legacy.scenarios = { bear: scenario(implicit()), base: scenario(implicit()), bull: scenario(implicit()) };
  assert.ok(calculateValuation(legacy).sensitivities.some(s => s.factor === "salesToCapital"));
});

test("management explicit plans apply sourced capex anchors without changing D&A/NWC or forcing a cash-flow floor", () => {
  const set: ManagementTargetSet = { ticker: "TST", fiscalYearEndMonth: 12, asOf: "2026-11-01", sources: [{ id: "source", title: "Management plan", url: "https://example.test/plan", date: "2026-11-01" }], targets: [
    { metric: "revenue", fiscalYear: 2029, value: 1400, unit: "currency", basis: "gaap", kind: "target", sourceIds: ["source"] },
    { metric: "capex", fiscalYear: 2027, value: 150, unit: "currency", basis: "gaap", kind: "target", sourceIds: ["source"] },
    { metric: "capex", fiscalYear: 2029, value: 100, unit: "currency", basis: "gaap", kind: "target", sourceIds: ["source"] },
    { metric: "fcf", fiscalYear: 2028, value: 1000, unit: "currency", basis: "gaap", kind: "floor", sourceIds: ["source"] },
  ] };
  const base = explicit(), facts = { revenue0: 1000, operatingMargin0: 0.25, sbcToRevenue: 0, da0: 999, capex0: 200 };
  const output = managementDrivers(base, set, "2026-12-31", facts);
  assert.ok(output?.drivers.path.capitalPlan);
  assert.deepEqual(output.drivers.path.capitalPlan.capex, [150, 125, 100, 70, 60]);
  assert.deepEqual(output.drivers.path.capitalPlan.depreciation, plan().depreciation);
  assert.deepEqual(output.drivers.path.capitalPlan.workingCapitalChange, plan().workingCapitalChange);
  assert.equal(output.drivers.path.salesToCapital, undefined); assert.equal(output.drivers.path.buildCapex, undefined);
  assert.ok(output.anchors.find(a => a.metric === "fcf")!.path! < 1000);
  assert.ok(output.notes.some(n => n.includes("not changed to force")));
  const noCapex = managementDrivers(base, { ...set, targets: set.targets.filter(t => t.metric !== "capex") }, "2026-12-31", facts);
  assert.deepEqual(noCapex?.drivers.path.capitalPlan, plan());
  assert.ok(noCapex?.notes.some(n => n.includes("No cited capex target")));
  assert.deepEqual(base.path.capitalPlan, plan(), "management reference never mutates the researched base");
});

test("agent and publication schemas keep the explicit plan and reject mixed paths rather than stripping one mode", () => {
  const r = request();
  const tool = valuationTools({ SEC_REFRESH_KEY: "test", SEC_USER_AGENT: "test", SEC_ANALYSIS_WORKFLOW: { async create() { throw new Error("not used"); } }, get SEC_FILINGS(): never { throw new Error("not used"); } }).find(t => t.name === "calculate_valuation")!;
  assert.doesNotThrow(() => toolSchema(tool));
  const judgement = { rationale: "The disclosed capital schedule and operating plan support this assumption.", evidenceIds: ["e1234567890"] };
  const component = (value: number) => ({ value, source: "test source", evidenceIds: [] });
  const argumentsFor = (drivers: ModelDrivers) => ({ modelType: "fcff", discountRate: { basis: "wacc", riskFree: component(0.04), beta: component(1), equityRiskPremium: component(0.06), costOfDebt: component(0.05), taxRate: component(0.2), equityWeight: component(0.8), rationale: judgement.rationale }, shares: { baseFactId: "shares_outstanding", dilutionPercent: 0, rationale: judgement.rationale }, bridge: { ...bridge, notes: ["Test claims."] }, scenarios: Object.fromEntries(["bear", "base", "bull"].map(k => [k, { ...scenario(drivers), assumptions: { revenue: judgement, margin: judgement, capex: judgement } }])), fairValueBasis: { status: "unavailable", reason: "Normal bounds have not been researched in this schema test.", evidenceIds: [] }, midYear: false, forwardYears: 3, methodWeights: { dcf: { ...judgement, weight: 1 }, ev_ebitda_forward: { ...judgement, weight: 0 }, pe_forward: { ...judgement, weight: 0 } }, scenarioProbabilities: { bear: { ...judgement, probability: 0.25 }, base: { ...judgement, probability: 0.5 }, management: { rationale: "no target set", evidenceIds: [], probability: 0 }, bull: { ...judgement, probability: 0.25 } }, managementComparison: null, consensus: { status: "unavailable", reason: "No consensus source in the test." } });
  assert.ok(tool.parameters.safeParse(argumentsFor(explicit())).success);
  assert.ok(tool.parameters.safeParse(argumentsFor(implicit())).success);
  const bad = explicit(); Object.assign(bad.path, { salesToCapital: fill(2) });
  assert.equal(tool.parameters.safeParse(argumentsFor(bad)).success, false);
  const stored = publication(calculateValuation(r));
  assert.equal(stored.calculatorVersion, CALCULATOR_VERSION);
  assert.ok(stored.model?.scenarios.base.drivers.modelType === "fcff");
  Object.assign(stored.model.scenarios.base.drivers.path, { buildCapex: fill(0) });
  assert.equal(readValuationPublication(stored, "TST"), null);
});
