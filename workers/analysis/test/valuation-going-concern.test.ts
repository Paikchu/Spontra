import assert from "node:assert/strict";
import { test } from "node:test";
import type { ValuationDimension, ValuationEvidence } from "../../../shared/analysis-contract/valuation.ts";
import { goingConcernOf, valuationTools, type ValuationState } from "../src/valuation/tools.ts";
import { assemblePublication } from "../src/valuation/workflow.ts";
import { runTool } from "../src/tools/registry.ts";

const now = "2026-10-01T00:00:00.000Z";
const evidenceId = "e1234567890";
const unresolved = "Substantial doubt about our ability to continue as a going concern has not been alleviated by management's plans.";
const resolved = "The completed refinancing alleviates the substantial doubt about our ability to continue as a going concern.";

function stateWith(excerpt = unresolved): ValuationState {
  const evidence: ValuationEvidence = { evidenceId, kind: "sec", title: "ACME 10-Q", url: "https://example.test/10q", documentId: "doc", passageId: "passage", form: "10-Q", publishedAt: "2026-09-30", fetchedAt: now, excerpt, contentSha256: "hash", path: "Liquidity" };
  return {
    input: {
      ticker: "ACME", cik: null, companyName: "Acme", currency: "USD", financialPeriodEnd: "2026-06-30", incomeModel: "operating",
      facts: [{ id: "shares_outstanding", label: "Shares", value: 100, unit: "shares", currency: null, periodType: "instant", periodStart: null, periodEnd: "2026-06-30", basis: "reported", formula: null, sourceRefs: [], rationale: null }],
      distributions: [], diagnostics: [], documents: [], guidance: null, transcripts: [], missing: [], fingerprint: "input",
      data: { quarters: [], history: null, capital: null, fundamentals: null, guidance: null },
      rpo: null, lifecycle: "mature", peers: [], peerBasis: "none", peerNotes: [], management: null, managementNotes: [], trailingQuarters: [],
    },
    researchAsOf: now, now, quote: null, riskFree: null, beta: null, peerMultiples: null, multipleHistory: null,
    evidence: new Map([[evidenceId, evidence]]), hits: [], used: { finds: 0, reads: 0, searches: 0, webReads: 0, transcripts: 0 },
    dimensions: new Map(), researchDone: false, calc: null, modelGaps: [], insufficient: null, assumptionsDone: false, redTeam: null, composed: null, cancelled: false,
  };
}

const dimension = (score: number | null): ValuationDimension => ({
  key: "financialResilience", score, confidence: "medium",
  rationale: "The liquidity assessment uses the current filing and its disclosed financing arrangements, including management's assessment of the funding runway.",
  supportingEvidenceIds: [evidenceId], counterEvidenceIds: [evidenceId], gaps: [], nextCheck: "Read the next quarterly liquidity disclosure.",
});
const assessment = (status: "unresolved" | "resolved" | "unknown", quote = unresolved) => ({
  status, rationale: "The current filing explicitly assesses whether the funding plans alleviate substantial doubt.",
  evidence: status === "unknown" ? [] : [{ evidenceId, quote }],
});
async function call(state: ValuationState, name: string, input: unknown) {
  const tools = valuationTools({
    SEC_REFRESH_KEY: "test", SEC_USER_AGENT: "test",
    SEC_ANALYSIS_WORKFLOW: { async create() { throw new Error("unexpected workflow creation"); } },
    get SEC_FILINGS(): never { throw new Error("unexpected storage access"); },
  });
  return runTool(tools, { allow: [name] }, { name, input }, {
    state, signal: new AbortController().signal, recipe: "test", stage: async (_name, work) => work(),
  });
}
const why = { rationale: "Supported by the current filing's liquidity disclosure.", evidenceIds: [evidenceId] };
const scenario = { narrative: "Stable cash flow supported by the filing.", triggers: ["Cash flow holds"], invalidation: ["Cash flow falls"], evidenceIds: [evidenceId], assumptions: { revenue: why, margin: why, capex: why }, drivers: { modelType: "fcfe", cfo: 150, capex: 20, sbc: 30, normalization: 0, netBorrowing: 0, growth: [0, 0, 0, 0, 0], terminalGrowth: 0 } };
const component = (value: number | null, source: string) => ({ value, source, evidenceIds: [] });
const weight = (w: number, rationale: string) => ({ weight: w, rationale: `${rationale} The equity-level model has no forward-multiple cross-check, so the cash-flow method carries the whole weight.`, evidenceIds: [evidenceId] });
const probability = (p: number, rationale: string) => ({ probability: p, rationale, evidenceIds: [evidenceId] });
export const calculation = {
  modelType: "fcfe", discountRate: { basis: "cost_of_equity", riskFree: component(0.04, "test risk-free"), beta: component(1, "test beta"), equityRiskPremium: component(0.06, "test premium"), costOfDebt: component(null, "not needed: cost of equity"), taxRate: component(null, "not needed: cost of equity"), equityWeight: component(null, "not needed: cost of equity"), rationale: "Cost of equity from the test components." },
  shares: { baseFactId: "shares_outstanding", dilutionPercent: 0, rationale: "No additional dilution." },
  bridge: { nonOperatingAssets: 0, debtAndClaims: 0, nonOperatingEquityAdjustment: 0, notes: ["no net claims in this test"] },
  scenarios: { bear: scenario, base: scenario, bull: scenario }, midYear: false, forwardYears: 3,
  fairValueBasis: { status: "unavailable", reason: "Normal operating bounds were not researched for this liquidity test.", evidenceIds: [] },
  methodWeights: { dcf: weight(1, "The equity cash flows are the only usable method."), ev_ebitda_forward: weight(0, "Not applicable to an equity-level model."), pe_forward: weight(0, "Not applicable to an equity-level model.") },
  scenarioProbabilities: { bear: probability(0.3, "Downside weight from the liquidity risk."), base: probability(0.5, "The filing's own run-rate."), management: { probability: 0, rationale: "no target set", evidenceIds: [] }, bull: probability(0.2, "Upside if refinancing completes early.") },
  managementComparison: null, consensus: { status: "unavailable", reason: "No sell-side target page was read in this test run." },
};

test("AD-3: unresolved filing evidence rejects resilience above 7.5 at submission", async () => {
  const state = stateWith();
  const result = await call(state, "submit_dimension", { ...dimension(8), goingConcern: assessment("unresolved") });
  assert.match(result.observation, /Not accepted:.*financialResilience.*7\.5/s);
  assert.equal(state.dimensions.has("financialResilience"), false);
});

for (const status of ["unresolved", "resolved", "unknown"] as const) {
  test(`AD-3: ${status} evidence has the same ceiling at calculation and publication`, async () => {
    const quote = status === "resolved" ? resolved : unresolved;
    const state = stateWith(quote);
    const submitted = await call(state, "submit_dimension", { ...dimension(status === "unresolved" ? 7.5 : 8), goingConcern: assessment(status, quote) });
    assert.match(submitted.observation, /financialResilience recorded/);
    assert.equal(goingConcernOf(state), status);
    assert.equal("goingConcern" in state.dimensions.get("financialResilience")!, false);
    const calculated = await call(state, "calculate_valuation", calculation);
    assert.match(calculated.observation, /^Calculated/);
    assert.equal(calculated.observation.includes("financialResilience ≤ 7.5"), status === "unresolved");
    // Publication must recheck even a score restored from an earlier run's state.
    state.dimensions.set("financialResilience", dimension(8));
    const { publication } = await assemblePublication(state, now, "test");
    const resilience = publication.dimensions.find(d => d.key === "financialResilience")!;
    assert.equal(resilience.score, status === "unresolved" ? 7.5 : 8);
    if (status === "unresolved") assert.ok(resilience.gaps.some(gap => gap.includes("unresolved going-concern evidence")));
    assert.equal("goingConcern" in resilience, false, "internal assessment must not change the public dimension shape");
    assert.ok(publication.evidence.some(e => e.evidenceId === evidenceId));
  });
}

test("AD-3: gaps and keyword mentions alone do not establish unresolved risk", async () => {
  const state = stateWith("Our accounting policies use the going concern basis of accounting.");
  assert.equal(goingConcernOf(state), "unknown");
  // The assessment is required; "unknown" says the evidence establishes neither doubt nor its alleviation.
  const submitted = await call(state, "submit_dimension", { ...dimension(8), gaps: ["Read more about going concern and refinancing."], goingConcern: assessment("unknown") });
  assert.match(submitted.observation, /financialResilience recorded/);
  const { publication } = await assemblePublication(state, now, "test");
  assert.equal(publication.dimensions.find(d => d.key === "financialResilience")!.score, 8);
});

for (const [label, evidence] of [
  ["missing evidence", []],
  ["unregistered evidence", [{ evidenceId: "e0000000000", quote: unresolved }]],
  ["invented quotation", [{ evidenceId, quote: "The company has no going concern uncertainty whatsoever." }]],
] as const) {
  test(`AD-3: an assessment with ${label} is rejected`, async () => {
    const state = stateWith();
    const result = await call(state, "submit_dimension", { ...dimension(7.5), goingConcern: { ...assessment("unresolved"), evidence } });
    assert.match(result.observation, /Not accepted:.*going.concern/is);
    assert.equal(state.dimensions.has("financialResilience"), false);
  });
}

test("AD-3: resubmission cannot drop an existing unresolved assessment by omitting it", async () => {
  const state = stateWith();
  await call(state, "submit_dimension", { ...dimension(7.5), goingConcern: assessment("unresolved") });
  const result = await call(state, "submit_dimension", dimension(8));
  assert.match(result.observation, /Not accepted:.*financialResilience.*7\.5/s);
  assert.equal(state.dimensions.get("financialResilience")!.score, 7.5);
});

test("AD-3: publication enforces the ceiling without a valuation model", async () => {
  const state = stateWith();
  await call(state, "submit_dimension", { ...dimension(7.5), goingConcern: assessment("unresolved") });
  state.dimensions.set("financialResilience", dimension(8));
  assert.equal(state.calc, null);
  const { publication } = await assemblePublication(state, now, "test");
  assert.equal(publication.dimensions.find(d => d.key === "financialResilience")!.score, 7.5);
});

test("AD-3: publication rejects lost assessment evidence instead of silently removing the ceiling", async () => {
  const state = stateWith();
  await call(state, "submit_dimension", { ...dimension(7.5), goingConcern: assessment("unresolved") });
  state.evidence.delete(evidenceId);
  await assert.rejects(assemblePublication(state, now, "test"), /going-concern evidence.*registered passage/);
});
