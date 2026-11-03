import assert from "node:assert/strict";
import { test } from "node:test";
import { EXTENDED_SCENARIO_KEYS, VALUATION_METHODS, type ModelDrivers, type ScenarioAssumptions, type ScenarioProbabilities, type ValuationEvidence, type ValuationPublication } from "../../../shared/analysis-contract/valuation.ts";
import { CALCULATOR_VERSION, calculateValuation, ValuationCalcError, type CalcRequest } from "../../../shared/analysis-runtime/valuation/calculator.ts";
import { managementComparisonRows } from "../../../shared/analysis-runtime/valuation/management.ts";
import { readValuationPublication } from "../../../shared/analysis-runtime/valuation/read.ts";
import { managementTargetSet, parseTargets } from "../src/valuation/curated.ts";
import inputs from "./fixtures/valuation-inputs.json" with { type: "json" };
import { methodChangeHeldBack } from "../src/valuation/reassess.ts";
import { gateGaps, registerManagementEvidence, valuationTools, type ValuationState } from "../src/valuation/tools.ts";
import { assemblePublication, judgementLines, openingAssume, RED_TEAM_SCHEMA, VALUATION_VERSION } from "../src/valuation/workflow.ts";
import { runTool } from "../src/tools/registry.ts";

/* Judged weights and the management scenario (valuation.v5 / valuation.calc.v4). */

const close = (actual: number, expected: number, digits = 2) => assert.equal(Number(actual.toFixed(digits)) + 0, Number(expected.toFixed(digits)) + 0);
const fill = (n: number, v: number) => new Array<number>(n).fill(v);
const bridge = { nonOperatingAssets: 37e9, debtAndClaims: 161e9, nonOperatingEquityAdjustment: 0, notes: [] };
const rate = (value: number) => ({ value, basis: "wacc" as const, components: { riskFree: 0.049, beta: 1.82, equityRiskPremium: 0.0433, costOfEquity: 0.128, costOfDebt: 0.055, taxRate: 0.13, equityWeight: 0.72 }, rationale: "", sourceRefs: [] });
const fcff = (g: number, m: number, build: number[] = [40e9, 30e9, 20e9, 10e9, 0, 0, 0]): Extract<ModelDrivers, { modelType: "fcff" }> =>
  ({ modelType: "fcff", revenue0: 71.777e9, path: { revenueGrowth: fill(7, g), operatingMargin: fill(7, m), taxRate: fill(7, 0.13), salesToCapital: fill(7, 1.44), buildCapex: build }, terminalGrowth: 0.03, terminalRoic: 0.111 });
const scenario = (drivers: ModelDrivers, probability: number | null = null): ScenarioAssumptions => ({ narrative: "", probability, triggers: [], invalidation: [], evidenceIds: [], drivers });
const orcl = managementTargetSet("ORCL", parseTargets(inputs.ORCL.targets), 5, "2026-11-01").set!;
const facts = [["revenue_ttm", 71.777e9, "USD"], ["operating_margin_ttm", 0.3212, "ratio"], ["sbc_ttm", 4.814e9, "USD"], ["da_ttm", 9.428e9, "USD"], ["capex_ttm", 75.66e9, "USD"], ["shares_outstanding", 3e9, "shares"], ["debt", 125e9, "USD"], ["leases", 30e9, "USD"], ["finance_leases", 30e9, "USD"], ["other_senior_claims", 6e9, "USD"], ["cash", 37e9, "USD"], ["ebitda_ttm", 32.5e9, "USD"], ["interest_expense_ttm", 5.1e9, "USD"]].map(([id, value, unit]) => ({ id: id as string, value: value as number, unit: unit as string }));
const peers = { peers: ["A", "B"], asOf: "2026-11-01", evToEbitda: { p25: 15.3, median: 16.7, p75: 18.3, count: 2 }, peRatio: { p25: 27.1, median: 28.9, p75: 30.4, count: 2 }, notes: [], basis: "curated" as const, weights: { A: 0.5, B: 0.5 } };
const judged = (dcf: number, ev: number, pe: number) => ({ dcf: { weight: dcf, rationale: "dcf", evidenceIds: ["e1"] }, ev_ebitda_forward: { weight: ev, rationale: "ev", evidenceIds: ["e1"] }, pe_forward: { weight: pe, rationale: "pe", evidenceIds: ["e1"] } });
const probabilities = (bear: number, base: number, management: number, bull: number): ScenarioProbabilities => ({ bear: { probability: bear, rationale: "bear", evidenceIds: ["e1"] }, base: { probability: base, rationale: "base", evidenceIds: ["e1"] }, management: { probability: management, rationale: "management", evidenceIds: ["m1"] }, bull: { probability: bull, rationale: "bull", evidenceIds: ["e1"] } });
const request = (context: Partial<NonNullable<CalcRequest["context"]>> = {}): CalcRequest => ({
  modelType: "fcff", currency: "USD", discountRate: rate(0.106), shares: { base: 3e9, dilutionReserve: 0, basis: "shares_outstanding" }, bridge, price: 130.67, midYear: false,
  scenarios: { bear: scenario(fcff(0.15, 0.28)), base: scenario(fcff(0.2, 0.3212)), bull: scenario(fcff(0.3, 0.34)) },
  context: { facts, riskFree: 0.049, peers, trailing: { ebitda: 32.5e9, da: 9.428e9, interestExpense: 5.1e9 }, lifecycle: "build", management: orcl, periodEnd: "2026-08-31", methodWeights: judged(0.5, 0.3, 0.2), scenarioProbabilities: probabilities(0.2, 0.4, 0.25, 0.15),
    managementComparison: { rationale: "The base discounts the FY30 target for capacity timing.", evidenceIds: ["m1"] }, consensusNote: { status: "unavailable", source: null, reason: "no consensus page was readable" }, ...context },
});

test("calc.v4: each scenario is valued by method on its own path, the range is method-weighted, and the expected value weighs bear, base, management and bull", () => {
  const result = calculateValuation(request());
  assert.equal(result.calculatorVersion, CALCULATOR_VERSION);
  for (const key of ["bear", "base", "bull"] as const) {
    const s = result.scenarios[key];
    assert.ok(s.valuation, `${key} carries its method valuation`);
    assert.equal(s.valuation!.methods.dcf, s.result.perShare);
    assert.ok(s.valuation!.methods.ev_ebitda_forward != null && s.valuation!.methods.pe_forward != null, `${key}: both forward methods apply`);
    close(VALUATION_METHODS.reduce((sum, k) => sum + s.valuation!.weights[k], 0), 1, 8);
    close(s.valuation!.weights.dcf, 0.5, 8);
    close(s.valuation!.perShare, VALUATION_METHODS.reduce((sum, k) => sum + s.valuation!.weights[k] * s.valuation!.methods[k]!, 0), 6);
  }
  // The headline range is the weighted value, the DCF stays visible beside it.
  assert.equal(result.range.base, result.scenarios.base.valuation!.perShare);
  assert.equal(result.range.low, result.scenarios.bear.valuation!.perShare); assert.equal(result.range.high, result.scenarios.bull.valuation!.perShare);
  assert.ok(result.range.base > result.scenarios.base.result.perShare, "the multiples lift the build-phase base above its DCF");
  assert.ok(result.scenarios.bear.valuation!.perShare < result.scenarios.base.valuation!.perShare && result.scenarios.base.valuation!.perShare < result.scenarios.bull.valuation!.perShare);
  close(result.range.marginOfSafety!, 1 - 130.67 / result.range.base, 8);
  // The management scenario: computed from the cited targets, valued the same way, carrying the judged probability and its evidence.
  const m = result.managementScenario!;
  assert.equal(m.probability, 0.25); assert.deepEqual(m.evidenceIds, ["m1"]);
  assert.ok(m.valuation && m.result.perShare > result.scenarios.base.result.perShare);
  assert.equal(m.anchors.filter(a => a.metric === "revenue").length, 2);
  assert.match(m.narrative, /FY2030 revenue 225\.0B in year 4/);
  const expected = 0.2 * result.range.low + 0.4 * result.range.base + 0.25 * m.valuation!.perShare + 0.15 * result.range.high;
  close(result.range.expected!, expected, 6);
  close(result.range.expectedUpside!, expected / 130.67 - 1, 8);
  for (const key of ["bear", "base", "bull"] as const) assert.equal(result.scenarios[key].probability, request().context!.scenarioProbabilities![key].probability);
  // The judgements ride on the result verbatim; the comparison has the computed rows and the explanation; the consensus note its reason.
  assert.equal(result.methodWeights!.ev_ebitda_forward.rationale, "ev");
  assert.equal(result.scenarioProbabilities!.management.evidenceIds[0], "m1");
  assert.equal(result.managementComparison!.rows.length, 2); assert.equal(result.managementComparison!.explanation, "The base discounts the FY30 target for capacity timing.");
  close(result.managementComparison!.rows[0]!.gap, 71.777 * 1.2 / 90 - 1, 6);
  assert.deepEqual(result.consensusNote, { status: "unavailable", source: null, reason: "no consensus page was readable" });
  const consensus = result.gates!.find(g => g.key === "consensus_unavailable")!;
  assert.equal(consensus.status, "flag"); assert.equal(consensus.detail, "consensus unavailable: no consensus page was readable");
  assert.ok(!result.gates!.some(g => g.status === "fail"), result.gates!.filter(g => g.status === "fail").map(g => g.detail).join("; "));
  assert.ok(result.limitations.some(l => /weighs each scenario's DCF with the forward multiples/.test(l)));
  assert.equal(result.references, undefined);
  // Pure: the same request gives the same numbers.
  close(calculateValuation(JSON.parse(JSON.stringify(request())) as CalcRequest).range.expected!, result.range.expected!, 8);
});

test("calc.v4: weights and probabilities are schema-enforced, never bounded or defaulted: sum 1 within 1e-6, non-negative, management weight only with a scenario", () => {
  assert.throws(() => calculateValuation(request({ methodWeights: judged(0.5, 0.3, 0.1) })), (e: unknown) => e instanceof ValuationCalcError && /sum to 1/.test(e.message));
  assert.throws(() => calculateValuation(request({ methodWeights: judged(1.2, -0.2, 0) })), (e: unknown) => e instanceof ValuationCalcError && /non-negative/.test(e.message));
  assert.doesNotThrow(() => calculateValuation(request({ methodWeights: judged(0.5, 0.3, 0.2 + 5e-7) })), "inside the tolerance");
  assert.throws(() => calculateValuation(request({ scenarioProbabilities: probabilities(0.3, 0.4, 0.25, 0.15) })), (e: unknown) => e instanceof ValuationCalcError && /sum to 1/.test(e.message));
  assert.throws(() => calculateValuation(request({ scenarioProbabilities: probabilities(-0.1, 0.6, 0.3, 0.2) })), ValuationCalcError);
  // Without a target set there is no management scenario: its probability has to be 0.
  assert.throws(() => calculateValuation(request({ management: null })), (e: unknown) => e instanceof ValuationCalcError && /management scenario could not be computed/.test(e.message));
  const none = calculateValuation(request({ management: null, scenarioProbabilities: probabilities(0.3, 0.45, 0, 0.25) }));
  assert.equal(none.managementScenario, null); assert.equal(none.managementComparison, null);
  close(none.range.expected!, 0.3 * none.range.low + 0.45 * none.range.base + 0.25 * none.range.high, 6);
  // Any weighting the model judges stands: all the weight on the multiples, or all on the DCF.
  const multiples = calculateValuation(request({ methodWeights: judged(0, 0.5, 0.5) }));
  assert.equal(multiples.scenarios.base.valuation!.weights.dcf, 0);
  close(multiples.range.base, 0.5 * multiples.scenarios.base.valuation!.methods.ev_ebitda_forward! + 0.5 * multiples.scenarios.base.valuation!.methods.pe_forward!, 6);
  const dcfOnly = calculateValuation(request({ methodWeights: judged(1, 0, 0) }));
  assert.equal(dcfOnly.range.base, dcfOnly.scenarios.base.result.perShare);
});

test("calc.v4 gates: weight on a method the path cannot apply is spread and flagged method_unavailable; a usable method at weight 0 is a soft method_zero_weight flag; neither fails", () => {
  const noPeers = calculateValuation(request({ peers: null }));
  for (const key of ["bear", "base", "bull"] as const) { assert.equal(noPeers.scenarios[key].valuation!.weights.dcf, 1); assert.equal(noPeers.scenarios[key].valuation!.perShare, noPeers.scenarios[key].result.perShare); }
  const unavailable = noPeers.gates!.find(g => g.key === "method_unavailable")!;
  assert.equal(unavailable.status, "flag"); assert.match(unavailable.detail, /EV\/EBITDA on year 3 weighted 30% but not applicable \(no peer EV\/EBITDA\)/); assert.match(unavailable.detail, /P\/E on year 3 weighted 20%/);
  close(unavailable.value!, 0.5, 8);
  assert.ok(!noPeers.gates!.some(g => g.key === "method_zero_weight"));
  assert.ok(noPeers.managementScenario && noPeers.managementScenario.valuation!.weights.dcf === 1);
  const zero = calculateValuation(request({ methodWeights: judged(1, 0, 0) }));
  const soft = zero.gates!.find(g => g.key === "method_zero_weight")!;
  assert.equal(soft.status, "flag"); assert.match(soft.detail, /EV\/EBITDA on year 3 is usable \([\d.]+ \/ [\d.]+ \/ [\d.]+\) but weighted 0/); assert.match(soft.detail, /weight rationale must say why/);
  assert.ok(!zero.gates!.some(g => g.key === "method_unavailable"));
  assert.ok(zero.gates!.some(g => g.key === "method_dispersion" && g.status === "flag"), "a single applied method is still flagged for dispersion");
  assert.deepEqual(gateGaps([unavailable, soft]).map(g => g.code), ["method_unavailable", "method_zero_weight"]);
  // Weight on an equity-level model's multiples: the DCF carries it, the flag says so.
  const fcfe: ModelDrivers = { modelType: "fcfe", cfo: 30e9, capex: 10e9, sbc: 5e9, normalization: 0, netBorrowing: 0, growth: fill(5, 0.05), terminalGrowth: 0.03 };
  const equity = calculateValuation({ ...request({ management: null, scenarioProbabilities: probabilities(0.25, 0.5, 0, 0.25) }), modelType: "fcfe", discountRate: { ...rate(0.11), basis: "cost_of_equity" }, scenarios: { bear: scenario({ ...fcfe, growth: fill(5, 0.02) }), base: scenario(fcfe), bull: scenario({ ...fcfe, growth: fill(5, 0.08) }) } });
  assert.equal(equity.scenarios.base.valuation!.weights.dcf, 1); assert.equal(equity.range.base, equity.scenarios.base.result.perShare);
  assert.equal(equity.methods!.length, 1, "no forward methods on an equity-level model");
  assert.ok(!equity.gates!.some(g => g.status === "fail"));
});

test("calc.v4: a method-weighted order that contradicts the DCF order is rejected, and a weighted value below zero flags the modeled shortfall", () => {
  // A bull path whose multiples value sits under the base's: the forward EBITDA follows the margin, so a bull with a far lower margin is out of order on the weighted values.
  const inverted = request();
  inverted.scenarios.bull = scenario(fcff(0.31, 0.2));
  assert.throws(() => calculateValuation(inverted), (e: unknown) => e instanceof ValuationCalcError && e.code === "scenario_order");
  const heavy = request({ methodWeights: judged(0, 1, 0) });
  heavy.bridge = { ...bridge, debtAndClaims: 1500e9 };
  heavy.scenarios = { bear: scenario(fcff(0.15, 0.28, [300e9, 300e9, 300e9, 100e9, 0, 0, 0])), base: scenario(fcff(0.2, 0.3212, [300e9, 300e9, 300e9, 100e9, 0, 0, 0])), bull: scenario(fcff(0.3, 0.34, [300e9, 300e9, 300e9, 100e9, 0, 0, 0])) };
  try {
    const result = calculateValuation(heavy);
    assert.equal(result.gates!.find(g => g.key === "non_negative_scenarios")!.status, "flag");
  } catch (error) {
    assert.ok(error instanceof ValuationCalcError, String(error));
  }
});

test("calc.v4 reads back through the contract, and older payloads (no judgements, a reference list) still read", () => {
  const result = calculateValuation(request());
  const publication = (model: unknown, calculatorVersion = result.calculatorVersion) => ({
    schemaVersion: "valuation.v1", ticker: "ORCL", cik: null, companyName: "Oracle", currency: "USD", researchAsOf: "2026-11-02", financialPeriodEnd: "2026-08-31", generatedAt: "2026-11-02", methodVersion: VALUATION_VERSION, calculatorVersion, baseInputFingerprint: "f", evidenceSetHash: "h", reportStatus: "ready", verdict: "pending", weightedScore: 6, confidence: "medium",
    dimensions: ["businessQuality", "growthExecution", "valuationSafety", "mispricingCatalysts", "financialResilience"].map(key => ({ key, score: 6, confidence: "medium", rationale: "r", supportingEvidenceIds: [], counterEvidenceIds: [], gaps: [], nextCheck: "n" })),
    quote: null, model, facts: [], diagnostics: [], distributions: [], sections: { summary: "", thesis: "", expectationsGap: "", catalysts: [], counterEvidence: [], nextChecks: [], modelNotes: "" }, evidence: [], gaps: gateGaps(result.gates!), versionId: "v",
  }) as unknown as ValuationPublication;
  const read = readValuationPublication(JSON.parse(JSON.stringify(publication(result))), "ORCL")!;
  assert.ok(read, "the calc.v4 payload reads");
  assert.equal(read.model!.managementScenario!.probability, 0.25);
  assert.equal(read.model!.scenarioProbabilities!.bull.rationale, "bull");
  assert.equal(read.model!.scenarios.base.valuation!.weights.dcf, 0.5);
  assert.equal(read.model!.consensusNote!.status, "unavailable");
  assert.ok(read.gaps.some(g => g.code === "unverified_consensus"));
  // An older model: no judgements, the management case under `references`, probabilities null.
  const { methodWeights, scenarioProbabilities, managementScenario, managementComparison, consensusNote, ...older } = result;
  void methodWeights; void scenarioProbabilities; void managementComparison; void consensusNote;
  const old = { ...older, scenarios: Object.fromEntries(Object.entries(older.scenarios).map(([k, s]) => { const { valuation, assumptions, ...rest } = s; void valuation; void assumptions; return [k, { ...rest, probability: null }]; })), range: { ...older.range, expected: null },
    references: [{ key: "management", label: "Management case (cited targets)", drivers: managementScenario!.drivers, result: managementScenario!.result, triangulation: managementScenario!.triangulation, methods: managementScenario!.methods, anchors: managementScenario!.anchors, sources: managementScenario!.sources, notes: managementScenario!.notes }] };
  const v2 = readValuationPublication(JSON.parse(JSON.stringify(publication(old, "valuation.calc.v2"))), "ORCL")!;
  assert.ok(v2); assert.equal(v2.model!.references![0]!.key, "management"); assert.equal(v2.model!.managementScenario, undefined); assert.equal(v2.model!.scenarios.base.valuation, undefined);
});

/* ---- the tool: every judgement required, management evidence cited, consensus or its reason ---- */

const now = "2026-11-02T00:00:00.000Z";
const evidenceId = "e1234567890";
function stateWith(): ValuationState {
  const evidence: ValuationEvidence = { evidenceId, kind: "sec", title: "ORCL 10-Q", url: "https://example.test/10q", documentId: "doc", passageId: "passage", form: "10-Q", publishedAt: "2026-09-30", fetchedAt: now, excerpt: "Remaining performance obligations were $455 billion.", contentSha256: "hash", path: "MD&A" };
  return {
    input: {
      ticker: "ORCL", cik: null, companyName: "Oracle", currency: "USD", financialPeriodEnd: "2026-08-31", incomeModel: "operating",
      facts: facts.map(f => ({ ...f, label: f.id, currency: f.unit === "USD" ? "USD" : null, periodType: "ttm" as const, periodStart: null, periodEnd: "2026-08-31", basis: "reported" as const, formula: null, sourceRefs: [], rationale: null })),
      distributions: [], diagnostics: [], documents: [], guidance: null, transcripts: [], missing: [], fingerprint: "input",
      data: { quarters: [], history: null, capital: null, fundamentals: null, guidance: null },
      rpo: null, lifecycle: "build", peers: [], peerBasis: "curated", peerNotes: [], management: orcl, managementNotes: [], trailingQuarters: [],
    },
    researchAsOf: now, now, quote: { price: 130.67, currency: "USD", priceDate: "2026-10-30", source: "test", sourceUrl: "https://example.test", fetchedAt: now, usable: true, limitations: [] }, riskFree: { value: 0.049, label: "10Y", date: "2026-10-30" } as ValuationState["riskFree"], beta: null, peerMultiples: peers, multipleHistory: null,
    evidence: new Map([[evidenceId, evidence]]), hits: [], used: { finds: 0, reads: 0, searches: 0, webReads: 0, transcripts: 0 },
    dimensions: new Map(), researchDone: true, calc: null, modelGaps: [], insufficient: null, assumptionsDone: false, redTeam: null, composed: null, cancelled: false,
  };
}
async function call(state: ValuationState, name: string, input: unknown) {
  const tools = valuationTools({ SEC_REFRESH_KEY: "test", SEC_USER_AGENT: "test", SEC_ANALYSIS_WORKFLOW: { async create() { throw new Error("unexpected workflow creation"); } }, get SEC_FILINGS(): never { throw new Error("unexpected storage access"); } });
  return runTool(tools, { allow: [name] }, { name, input }, { state, signal: new AbortController().signal, recipe: "test", stage: async (_name, work) => work() });
}
const why = (text: string, ids: string[] = [evidenceId]) => ({ rationale: `${text} (supported by the registered filing passage).`, evidenceIds: ids });
const component = (value: number | null, source: string) => ({ value, source, evidenceIds: [] });
function fullArgs(managementIds: string[]) {
  const sc = (g: number, m: number, narrative: string) => ({ narrative: `${narrative} Revenue follows the contracted backlog and the capacity coming on line.`, triggers: ["OCI revenue growth holds"], invalidation: ["Capex rises without revenue"], evidenceIds: [evidenceId], assumptions: { revenue: why("Backlog conversion"), margin: why("Operating leverage"), capex: why("Build phase ends in year four") }, drivers: fcff(g, m) });
  const weight = (w: number, text: string) => ({ weight: w, rationale: `${text} The build phase makes the terminal value and build capex decisive, so the market's pricing of peers' post-forecast growth is a needed check on it.`, evidenceIds: [evidenceId] });
  return {
    modelType: "fcff",
    discountRate: { basis: "wacc", riskFree: component(0.049, "CBOE 10Y 2026-10-30"), beta: component(1.82, "105 weekly returns vs ^GSPC"), equityRiskPremium: component(0.0433, "Damodaran implied ERP"), costOfDebt: component(0.055, "10Y + 60bp for a Baa issuer"), taxRate: component(0.13, "effective_tax_rate_ttm"), equityWeight: component(0.72, "market cap over market cap plus debt and leases"), rationale: "WACC from the sourced components, identical in every scenario." },
    shares: { baseFactId: "shares_outstanding", dilutionPercent: 0, rationale: "No equity note read; no reserve." },
    bridge: { leaseTreatment: "operating_expense", nonOperatingAssets: 37e9, debtAndClaims: 161e9, nonOperatingEquityAdjustment: 0, notes: ["debt 125B + leases 30B + other 6B; cash 37B"] },
    fairValueBasis: { status: "unavailable", reason: "The normal operating bounds have not been researched in this fixture.", evidenceIds: [] },
    scenarios: { bear: sc(0.15, 0.28, "Capacity slips a year."), base: sc(0.2, 0.3212, "Backlog converts on schedule."), bull: sc(0.3, 0.34, "Demand exceeds capacity.") }, midYear: false, forwardYears: 3,
    methodWeights: { dcf: weight(0.5, "Own cash flows."), ev_ebitda_forward: weight(0.3, "Peers' pricing of EBITDA."), pe_forward: weight(0.2, "Peers' pricing of earnings.") },
    scenarioProbabilities: { bear: { probability: 0.2, rationale: "Capacity and financing risk in the build.", evidenceIds: [evidenceId] }, base: { probability: 0.4, rationale: "Backlog cover for the next two years.", evidenceIds: [evidenceId] }, management: { probability: 0.25, rationale: "Management has delivered its FY26 OCI target; the FY30 plan needs capacity not yet financed.", evidenceIds: managementIds }, bull: { probability: 0.15, rationale: "Demand above capacity would lift pricing.", evidenceIds: [evidenceId] } },
    managementComparison: { explanation: "The base path reaches the FY27 floor and discounts the FY30 target by the capacity that is not yet contracted or financed.", evidenceIds: managementIds.length ? managementIds : [evidenceId] },
    consensus: { status: "unavailable", reason: "No sell-side consensus page was among the registered evidence of this run." },
  };
}

test("calculate_valuation: every judgement is required; the reply names each scenario's DCF and weighted value, the management scenario and the expected value; the publication carries the judgements", async () => {
  const state = stateWith();
  const managementIds = await registerManagementEvidence(state);
  assert.ok(managementIds.length >= 5, "the cited sources are registered as evidence");
  const args = fullArgs([managementIds[0]!]);
  const ok = await call(state, "calculate_valuation", args);
  assert.match(ok.observation, /^Calculated \(fcff, 7 years, r = /, ok.observation);
  assert.match(ok.observation, /base: DCF [\d.]+, weighted [\d.]+ per share, p=40\.0%/);
  assert.match(ok.observation, /management \(cited targets, computed by code\): DCF [\d.]+, weighted [\d.]+ per share, p=25\.0%/);
  assert.match(ok.observation, /expected \(probability-weighted over bear\/base\/management\/bull\): [\d.]+/);
  assert.match(ok.observation, /consensus_unavailable flag: consensus unavailable: No sell-side consensus page/);
  assert.match(ok.observation, /management comparison: year 1 \(FY2027\)/);
  const calc = state.calc!.result;
  assert.equal(calc.methodWeights!.dcf.weight, 0.5); assert.equal(calc.scenarioProbabilities!.management.probability, 0.25);
  assert.equal(calc.managementScenario!.evidenceIds[0], managementIds[0]);
  assert.equal(calc.discountRate.sources!.equityRiskPremium.source, "Damodaran implied ERP");
  assert.ok(calc.scenarios.base.assumptions && calc.scenarios.base.assumptions.capex.rationale.startsWith("Build phase ends"));
  assert.ok(state.modelGaps.some(g => g.code === "discount_rate_unsourced"), "an ERP without registered evidence is a gap");
  assert.ok(state.modelGaps.some(g => g.code === "unverified_consensus"));
  // The opening tells the model which methods apply and what the management scenario needs.
  const opening = openingAssume(state, null);
  assert.match(opening, /Methods available: dcf; ev_ebitda_forward yes; pe_forward yes/); assert.match(opening, /Management scenario: computed by code/);
  // The publication: the judgements are appended to the model notes and their evidence is in the cited set.
  const lines = judgementLines(calc);
  assert.equal(lines.length, 6);
  assert.match(lines.shift()!, /Normal fair-value range unavailable/);
  assert.match(lines[0]!, /^Method weights: dcf 50% — Own cash flows\./); assert.match(lines[1]!, /management 25% — Management has delivered/); assert.match(lines[3]!, /^Consensus unavailable: No sell-side/);
  const { publication } = await assemblePublication(state, now, VALUATION_VERSION);
  assert.match(publication.sections.modelNotes, /Method weights: dcf 50%/);
  assert.ok(publication.evidence.some(e => e.evidenceId === managementIds[0]), "the management evidence the probability cites is published");
  assert.equal(publication.model!.range.base, calc.scenarios.base.valuation!.perShare);
  assert.ok(readValuationPublication(JSON.parse(JSON.stringify(publication)), "ORCL"), "the publication passes the contract");
});

test("calculate_valuation: a missing or malformed judgement is a schema error the model reads; management must cite its targets; consensus needs a source or a reason", async () => {
  const state = stateWith();
  const managementIds = await registerManagementEvidence(state);
  const args = fullArgs([managementIds[0]!]);
  const missing = (patch: (a: Record<string, unknown>) => void) => { const copy = JSON.parse(JSON.stringify(args)) as Record<string, unknown>; patch(copy); return copy; };
  const schema = async (patch: (a: Record<string, unknown>) => void, expect: RegExp) => { const r = await call(state, "calculate_valuation", missing(patch)); assert.ok(r.error, "rejected"); assert.match(r.observation, /^The arguments do not match calculate_valuation's schema/); assert.match(r.observation, expect, r.observation); assert.equal(state.calc, null); };
  await schema(a => { delete a.methodWeights; }, /methodWeights/);
  await schema(a => { delete a.fairValueBasis; }, /fairValueBasis/);
  await schema(a => { (a.methodWeights as Record<string, { weight: number }>).dcf.weight = 0.4; }, /method weights must sum to 1/);
  await schema(a => { delete (a.methodWeights as Record<string, Record<string, unknown>>).pe_forward.rationale; }, /methodWeights\.pe_forward\.rationale/);
  await schema(a => { (a.methodWeights as Record<string, { evidenceIds: string[] }>).dcf.evidenceIds = []; }, /methodWeights\.dcf\.evidenceIds/);
  await schema(a => { delete a.scenarioProbabilities; }, /scenarioProbabilities/);
  await schema(a => { (a.scenarioProbabilities as Record<string, { probability: number }>).bull.probability = 0.3; }, /scenario probabilities must sum to 1/);
  await schema(a => { delete (a.scenarioProbabilities as Record<string, unknown>).management; }, /scenarioProbabilities\.management/);
  await schema(a => { delete (a.discountRate as Record<string, unknown>).costOfDebt; }, /discountRate\.costOfDebt/);
  await schema(a => { ((a.discountRate as Record<string, unknown>).taxRate as { value: number | null }).value = null; }, /wacc needs a value/);
  await schema(a => { delete ((a.scenarios as Record<string, Record<string, unknown>>).base).assumptions; }, /scenarios\.base\.assumptions/);
  await schema(a => { ((a.scenarios as Record<string, Record<string, unknown>>).bear).triggers = []; }, /scenarios\.bear\.triggers/);
  await schema(a => { delete a.managementComparison; }, /managementComparison/);
  await schema(a => { a.consensus = { status: "unavailable" }; }, /consensus/);
  await schema(a => { a.consensus = { status: "cited", mean: 235.8, low: null, high: null, count: 43, asOf: "2026-10-31", evidenceId }; }, /consensus/);
  await schema(a => { delete a.midYear; }, /midYear/);
  await schema(a => { delete a.forwardYears; }, /forwardYears/);
  // Code checks after the schema: management evidence, a target set without a comparison, unknown ids.
  const uncited = await call(state, "calculate_valuation", missing(a => { (a.scenarioProbabilities as Record<string, { evidenceIds: string[] }>).management.evidenceIds = [evidenceId]; }));
  assert.match(uncited.observation, /Not accepted:[\s\S]*scenarioProbabilities\.management must cite management's registered target evidence/);
  const noComparison = await call(state, "calculate_valuation", missing(a => { a.managementComparison = null; }));
  assert.match(noComparison.observation, /managementComparison is required: this company has cited management targets/);
  const unknown = await call(state, "calculate_valuation", missing(a => { (a.methodWeights as Record<string, { evidenceIds: string[] }>).dcf.evidenceIds = ["e0000000000"]; }));
  assert.match(unknown.observation, /methodWeights\.dcf cites e0000000000/);
  // A cited consensus is compared, never copied; its note names the source.
  const cited = await call(state, "calculate_valuation", missing(a => { a.consensus = { status: "cited", mean: 235.8, low: 110, high: 400, count: 43, asOf: "2026-10-31", evidenceId, source: "MarketBeat consensus page" }; }));
  assert.match(cited.observation, /^Calculated/, cited.observation);
  assert.deepEqual(state.calc!.result.consensusNote, { status: "cited", source: "MarketBeat consensus page", reason: null });
  assert.ok(state.calc!.result.gates!.some(g => g.key === "consensus_divergence"));
  assert.ok(!state.calc!.result.gates!.some(g => g.key === "consensus_unavailable"));
  // Without a target set: management 0 with "no target set", comparison null; a positive probability is refused.
  const plain = stateWith(); plain.input.management = null;
  const noSet = await call(plain, "calculate_valuation", missing(a => { a.managementComparison = null; (a.scenarioProbabilities as Record<string, Record<string, unknown>>).management = { probability: 0, rationale: "no target set", evidenceIds: [] }; (a.scenarioProbabilities as Record<string, { probability: number }>).base.probability = 0.65; }));
  assert.match(noSet.observation, /^Calculated/, noSet.observation);
  assert.match(noSet.observation, /management scenario: none/);
  assert.equal(plain.calc!.result.managementScenario, null);
  const refused = await call(plain, "calculate_valuation", missing(a => { a.managementComparison = null; (a.scenarioProbabilities as Record<string, { evidenceIds: string[] }>).management.evidenceIds = [evidenceId]; (a.managementComparison as unknown) = { explanation: "An explanation that should not be given without a target set at all.", evidenceIds: [evidenceId] }; }));
  assert.match(refused.observation, /scenarioProbabilities\.management must be 0 \(rationale: no target set\)/);
  assert.match(refused.observation, /managementComparison must be null/);
});

test("other valuation tool schemas: financialResilience needs its going-concern assessment, the composed report its lists and model notes, an insufficiency its missing facts", async () => {
  const state = stateWith();
  const dimension = { key: "financialResilience", score: 7, confidence: "medium", rationale: "The liquidity assessment uses the current filing and its disclosed financing arrangements, including management's assessment of the funding runway.", supportingEvidenceIds: [evidenceId], counterEvidenceIds: [], gaps: [], nextCheck: "Read the next quarterly liquidity disclosure." };
  state.researchDone = false;
  const bare = await call(state, "submit_dimension", dimension);
  assert.match(bare.observation, /financialResilience needs goingConcern/);
  const assessed = await call(state, "submit_dimension", { ...dimension, goingConcern: { status: "unknown", rationale: "The current filing does not assess substantial doubt either way.", evidence: [] } });
  assert.match(assessed.observation, /financialResilience recorded/);
  const composed = await call(state, "compose_valuation", { summary: `Summary of the valuation with a citation [${evidenceId}] and enough words to pass the minimum length.`, thesis: "Thesis long enough to satisfy the minimum length of the schema for this field in the test harness here.", expectationsGap: "The gap to the price is quantified in the model notes.", catalysts: [], counterEvidence: ["Capex overruns"], nextChecks: ["OCI revenue"], modelNotes: "short", coreLogicFailed: false, decisiveCounterEvidence: false });
  assert.match(composed.observation, /^The arguments do not match compose_valuation's schema/); assert.match(composed.observation, /catalysts/); assert.match(composed.observation, /modelNotes/);
  const insufficient = await call(state, "declare_model_insufficient", { reason: "No share count could be resolved from the statements.", missingFactIds: [] });
  assert.match(insufficient.observation, /^The arguments do not match declare_model_insufficient's schema/);
});

test("the counter-evidence reviewer's reply has one shape; a half-formed one is no review", () => {
  assert.ok(RED_TEAM_SCHEMA.safeParse({ weakestAssumptions: [{ factor: "margin", why: "history", evidenceIds: ["e1"] }], decisiveCounterEvidence: false, counterEvidenceIds: [] }).success);
  assert.ok(!RED_TEAM_SCHEMA.safeParse({ weakestAssumptions: [], decisiveCounterEvidence: false, counterEvidenceIds: [] }).success);
  assert.ok(!RED_TEAM_SCHEMA.safeParse({ weakestAssumptions: [{ factor: "margin" }], decisiveCounterEvidence: false, counterEvidenceIds: [] }).success);
  assert.ok(!RED_TEAM_SCHEMA.safeParse({ weakestAssumptions: [{ factor: "margin", why: "x", evidenceIds: [] }], counterEvidenceIds: [] }).success);
});

test("management comparison rows: one per total-revenue target inside the horizon, with the base figure and the gap", () => {
  const rows = managementComparisonRows(fcff(0.2, 0.3), orcl, "2026-08-31");
  assert.deepEqual(rows.map(r => [r.metric, r.fiscalYear, r.year]), [["revenue", 2027, 1], ["revenue", 2030, 4]]);
  close(rows[0]!.base / 1e9, 71.777 * 1.2, 3); close(rows[1]!.target / 1e9, 225, 6);
  assert.deepEqual(managementComparisonRows(fcff(0.2, 0.3), { ...orcl, targets: orcl.targets.filter(t => t.metric !== "revenue") }, "2026-08-31"), []);
});

test("the version bump reassesses only the marked company: an ORCL report under valuation.v4/calc.v2 runs, every other company on unchanged material is held", () => {
  assert.equal(VALUATION_VERSION, "valuation.v9");
  const published = { methodVersion: "valuation.v4", calculatorVersion: "valuation.calc.v2", financialPeriodEnd: "2026-08-31" };
  const current = { methodVersion: VALUATION_VERSION, calculatorVersion: CALCULATOR_VERSION, financialPeriodEnd: "2026-08-31" };
  assert.equal(methodChangeHeldBack(true, published, current, "ORCL"), null);
  for (const other of ["GOOGL", "MSFT", "NVDA"]) {
    const held = methodChangeHeldBack(false, published, current, other);
    assert.ok(held && held.reason.includes(`valuation.v4/valuation.calc.v2 → ${VALUATION_VERSION}/${CALCULATOR_VERSION}`) && held.reason.includes(other));
  }
  assert.ok(methodChangeHeldBack(false, { ...published, methodVersion: "valuation.v4", calculatorVersion: "valuation.calc.v3" }, current, "GOOGL"), "a calc.v3 report is held too");
  assert.deepEqual(EXTENDED_SCENARIO_KEYS, ["bear", "base", "management", "bull"]);
});


test("normal bounds pass through the tool, retain their own evidence in the publication, and require a completed counter-evidence review", async () => {
  const state = stateWith();
  state.quote!.price = 1000;
  const managementIds = await registerManagementEvidence(state);
  const original = fullArgs([managementIds[0]!]);
  const normalId = "eabcdef1234";
  state.evidence.set(normalId, { ...state.evidence.get(evidenceId)!, evidenceId: normalId, excerpt: "Normal utilization varies inside the disclosed range.", contentSha256: "normal-hash" });
  const normal = (g: number, m: number) => ({ ...original.scenarios.base, drivers: fcff(g, m), narrative: "Ordinary renewal timing and utilization variation within the disclosed operating plan.", evidenceIds: [normalId], assumptions: { revenue: why("Normal renewal timing", [normalId]), margin: why("Normal utilization variation", [normalId]), capex: why("Scheduled capacity spending", [normalId]) } });
  const fairValueBasis = { status: "available", kind: "normal_cases", lower: normal(0.18, 0.31), upper: normal(0.22, 0.33), rationale: "Normal renewal timing and utilization set the bounds; disruptive demand or refinancing events belong to stress scenarios.", evidenceIds: [normalId] };
  const invalid = await call(state, "calculate_valuation", { ...original, fairValueBasis: { ...fairValueBasis, lower: { ...fairValueBasis.lower, evidenceIds: ["e0000000000"] } } });
  assert.match(invalid.observation, /normal lower cites e0000000000/);
  assert.equal(state.calc, null);
  const ok = await call(state, "calculate_valuation", { ...original, fairValueBasis });
  assert.match(ok.observation, /Normal fair-value range: [\d.]+ – [\d.]+ – [\d.]+ per share/);
  assert.ok(state.calc?.result.fairValueRange?.status === "available");
  const withoutNormal = calculateValuation({ ...state.calc.request, fairValueBasis: undefined });
  assert.deepEqual(state.calc.result.range, withoutNormal.range, "the four-scenario expectation is unchanged");
  assert.deepEqual(state.calc.result.managementScenario, withoutNormal.managementScenario, "the management case retains its own targets and probability");
  for (const key of ["businessQuality", "growthExecution", "valuationSafety", "mispricingCatalysts", "financialResilience"] as const) state.dimensions.set(key, { key, score: 5, confidence: "medium", rationale: "Supported facts but no evidence of a mispricing opportunity.", supportingEvidenceIds: [evidenceId], counterEvidenceIds: [], gaps: [], nextCheck: "Check the next release." });
  state.composed = { sections: { summary: "The reference close is compared with the normal operating range.", thesis: "The business remains viable within the evidenced bounds.", expectationsGap: "No confirmed expectations gap.", catalysts: ["Next release."], counterEvidence: ["Margins can weaken."], nextChecks: ["Next release."], modelNotes: "Normal paths use the common economics." }, coreLogicFailed: false, decisiveCounterEvidence: false };
  const incomplete = await assemblePublication(state, now, VALUATION_VERSION);
  assert.equal(incomplete.publication.reportStatus, "insufficient");
  assert.ok(incomplete.publication.gaps.some(g => g.code === "review_incomplete"));
  assert.ok(incomplete.evidence.some(e => e.evidenceId === normalId), "evidence cited only by the normal bounds is stored");
  state.redTeam = { weakestAssumptions: [], decisiveCounterEvidence: false, counterEvidenceIds: [] };
  const completed = await assemblePublication(state, now, VALUATION_VERSION);
  assert.equal(completed.publication.reportStatus, "ready");
  assert.equal(completed.publication.verdict, "not_supported", "a negative investment verdict alone does not invalidate completed research");
  assert.ok(readValuationPublication(JSON.parse(JSON.stringify(completed.publication)), "ORCL"));
  state.redTeam = { weakestAssumptions: [], decisiveCounterEvidence: true, counterEvidenceIds: [normalId] };
  const contradicted = await assemblePublication(state, now, VALUATION_VERSION);
  assert.equal(contradicted.publication.reportStatus, "insufficient");
  assert.deepEqual(contradicted.publication.gaps.find(g => g.code === "unresolved_counter_evidence")?.evidenceIds, [normalId]);
});
