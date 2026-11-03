import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { DIAGNOSTIC_UNITS, PEER_SELECTION_BASES, type ValuationDimension } from "../../../shared/analysis-contract/valuation.ts";
import { historyAssumptionsSchema, historyInputSchema } from "../../../shared/analysis-runtime/valuation/history.ts";
import { referenceQuoteSchema } from "../../../shared/analysis-runtime/valuation/price-guide.ts";
import { ASSUMPTION_TOOLS, commonValuationSchema, registerEvidence, VALUATION_CASE_TOOLS, valuationDraftStatus, valuationTools, type ValuationState } from "../src/valuation/tools.ts";
import { runTool, toolSchema } from "../src/tools/registry.ts";
import { sha256 } from "../src/sha256.ts";
import fixture from "./fixtures/valuation-staged-orcl-success.json" with { type: "json" };

const tools = valuationTools({ SEC_REFRESH_KEY: "test", SEC_USER_AGENT: "test", SEC_ANALYSIS_WORKFLOW: { async create() { throw new Error("Unexpected workflow creation"); } }, get SEC_FILINGS(): never { throw new Error("Unexpected storage read"); } });
const contextSchema = historyAssumptionsSchema.shape.request.shape.context.unwrap();
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
function stateWith(): ValuationState {
  const input = fixture.input;
  return {
    input: { ...input, facts: historyInputSchema.shape.facts.parse(input.facts), diagnostics: input.diagnostics.map(d => ({ ...d, unit: z.enum(DIAGNOSTIC_UNITS).parse(d.unit) })), documents: [], transcripts: [], distributions: [], guidance: null, rpo: null, lifecycle: z.enum(["build", "growth", "mature"]).parse(input.lifecycle), peerBasis: z.enum(PEER_SELECTION_BASES).parse(input.peerBasis), management: historyInputSchema.shape.management.parse(input.management) },
    ...fixture.market, quote: referenceQuoteSchema.parse(fixture.market.quote), peerMultiples: contextSchema.shape.peers.parse(fixture.market.peerMultiples) ?? null,
    researchAsOf: fixture.provenance.cutoff, now: fixture.provenance.producedAt,
    evidence: new Map(historyAssumptionsSchema.shape.evidence.parse(fixture.evidence).map(e => [e.evidenceId, e])), hits: [], used: { finds: 0, reads: 0, searches: 0, webReads: 0, transcripts: 0 },
    dimensions: new Map(), researchDone: true, calc: null, modelGaps: [], insufficient: null, assumptionsDone: false, redTeam: null, composed: null, cancelled: false,
  };
}
const call = (state: ValuationState, name: string, input: unknown = {}) => runTool(tools, { allow: [name] }, { name, input }, { state, signal: new AbortController().signal, recipe: "staged-tool-test", stage: async (_name, work) => work() });
function commonArgs() {
  const { scenarios: _scenarios, fairValueBasis, ...common } = fixture.args;
  const { lower: _lower, upper: _upper, ...fairMetadata } = fairValueBasis;
  return commonValuationSchema.parse({ ...common, fairValueBasis: fairMetadata });
}
async function stageAll(state: ValuationState) {
  assert.match((await call(state, "configure_valuation", commonArgs())).observation, /^Valuation configured/);
  for (const key of ["base", "bear", "bull"] as const) assert.match((await call(state, VALUATION_CASE_TOOLS[key], fixture.args.scenarios[key])).observation, new RegExp(`^${key} case recorded`));
  for (const key of ["lower", "upper"] as const) assert.match((await call(state, VALUATION_CASE_TOOLS[key], fixture.args.fairValueBasis[key])).observation, new RegExp(`^${key} case recorded`));
}
const safety = (): ValuationDimension => ({ key: "valuationSafety", score: 7, confidence: "medium", rationale: "The validated model has been considered together with its evidence and risks.", supportingEvidenceIds: [], counterEvidenceIds: [], gaps: [], nextCheck: "Check the next filing." });
function markDerived(state: ValuationState) {
  state.dimensions.set("valuationSafety", safety()); state.assumptionsDone = true;
  state.redTeam = { weakestAssumptions: [], decisiveCounterEvidence: false, counterEvidenceIds: [] };
  state.composed = { sections: { summary: "prior", thesis: "prior", expectationsGap: "prior", catalysts: [], counterEvidence: [], nextChecks: [], modelNotes: "prior" }, coreLogicFailed: false, decisiveCounterEvidence: false };
  state.nearTermForecast = { status: "unavailable", reason: "Prior forecast assessment." };
  state.modelGaps = [{ code: "missing_inputs", message: "Prior model gap", evidenceIds: [] }]; state.insufficient = "Prior model insufficiency";
}
function assertInvalidated(state: ValuationState) {
  assert.equal(state.calc, null); assert.equal(state.dimensions.has("valuationSafety"), false); assert.equal(state.assumptionsDone, false);
  assert.equal(state.redTeam, null); assert.equal(state.composed, null); assert.equal(state.nearTermForecast, undefined);
  assert.equal(state.insufficient, null); assert.deepEqual(state.modelGaps, []);
}

test("real successful ORCL artifact produces exactly the same request, result and gaps through staged and original tools", async () => {
  const direct = stateWith(), staged = stateWith();
  assert.match((await call(direct, "calculate_valuation", fixture.args)).observation, /^Calculated/);
  await stageAll(staged);
  assert.equal(staged.calc, null, "recording inputs does not calculate or fill default assumptions");
  assert.match((await call(staged, "calculate_prepared_valuation")).observation, /^Calculated/);
  assert.deepEqual(staged.calc, direct.calc);
  assert.equal(await sha256(JSON.stringify(stable(staged.calc!.request))), fixture.provenance.canonicalRequestSha256, "the reconstructed request still exactly matches the actual successful artifact");
  assert.deepEqual(staged.modelGaps, direct.modelGaps);
  const status = valuationDraftStatus(staged); assert.ok(status.status === "configured"); assert.deepEqual(status.missing, []);
  assert.equal(ASSUMPTION_TOOLS.includes("calculate_valuation"), false);
  assert.ok(tools.some(t => t.name === "calculate_valuation"), "the offline compatibility tool still exists");
  for (const name of ["configure_valuation", ...Object.values(VALUATION_CASE_TOOLS), "calculate_prepared_valuation"]) assert.doesNotThrow(() => toolSchema(tools.find(t => t.name === name)!));
});

test("prepared calculation names missing cases and never substitutes stress paths for absent normal bounds", async () => {
  const state = stateWith();
  assert.deepEqual(valuationDraftStatus(state), { status: "unconfigured" });
  assert.match((await call(state, "calculate_prepared_valuation")).observation, /configure_valuation first/);
  assert.match((await call(state, "set_base_case", fixture.args.scenarios.base)).observation, /configure_valuation before/);
  assert.equal(commonValuationSchema.safeParse(fixture.args).success, false, "the configure contract rejects a giant one-shot payload");
  await call(state, "configure_valuation", commonArgs());
  for (const key of ["base", "bear", "bull"] as const) await call(state, VALUATION_CASE_TOOLS[key], fixture.args.scenarios[key]);
  const missing = await call(state, "calculate_prepared_valuation");
  assert.match(missing.observation, /missing cases lower, upper/); assert.equal(state.calc, null);
  await call(state, "configure_valuation", { ...commonArgs(), fairValueBasis: { status: "unavailable", reason: "The source evidence does not support independent normal bounds.", evidenceIds: [] } });
  assert.match((await call(state, "calculate_prepared_valuation")).observation, /^Calculated/);
  assert.equal(state.calc?.result.fairValueRange?.status, "unavailable");
});

test("case and common edits invalidate every dependent result; model type changes clear all cases", async () => {
  const state = stateWith(); await stageAll(state); await call(state, "calculate_prepared_valuation");
  assert.ok(state.calc); markDerived(state);
  await call(state, "set_base_case", { ...fixture.args.scenarios.base, narrative: fixture.args.scenarios.base.narrative + " The numerical path is unchanged." });
  assertInvalidated(state);
  assert.match((await call(state, "finish_assumptions")).observation, /calculate_prepared_valuation or declare_model_insufficient/);
  await call(state, "calculate_prepared_valuation"); markDerived(state);
  const savedCases = state.valuationDraft!.cases;
  await call(state, "configure_valuation", commonArgs());
  assertInvalidated(state); assert.deepEqual(state.valuationDraft!.cases, savedCases);
  await call(state, "configure_valuation", { ...commonArgs(), modelType: "fcfe", discountRate: { ...commonArgs().discountRate, basis: "cost_of_equity" } });
  assert.deepEqual(state.valuationDraft!.cases, {});
  assert.match((await call(state, "set_base_case", fixture.args.scenarios.base)).observation, /configured model is fcfe/);
});

test("invalid citations are rejected on submission and rechecked before prepared calculation", async () => {
  const state = stateWith();
  const invalid = await call(state, "configure_valuation", { ...commonArgs(), fairValueBasis: { ...commonArgs().fairValueBasis, evidenceIds: ["e0000000000"] } });
  assert.match(invalid.observation, /neither registered evidence/); assert.equal(state.valuationDraft, undefined);
  await call(state, "configure_valuation", commonArgs());
  assert.match((await call(state, "set_base_case", { ...fixture.args.scenarios.base, evidenceIds: ["e0000000000"] })).observation, /neither registered evidence/);
  assert.equal(state.valuationDraft?.cases.base, undefined);
  await stageAll(state);
  state.evidence.clear();
  assert.match((await call(state, "calculate_prepared_valuation")).observation, /Not accepted/); assert.equal(state.calc, null);
});

test("a 5000-character frozen excerpt retains a late exact quotation under a new evidence ID without overwriting the old ID", async () => {
  const state = stateWith(); state.researchDone = false;
  const quotation = "Substantial doubt about our ability to continue as a going concern remains unresolved.";
  const text = "A".repeat(2300) + quotation + "B".repeat(5000 - 2300 - quotation.length);
  const documentId = "frozen-source", passageId = `${documentId}:0`, contentHash = await sha256(text);
  const legacyId = `e${(await sha256(`sec|${documentId}|${passageId}|${contentHash}`)).slice(0, 10)}`;
  const old = { ...fixture.evidence[0]!, evidenceId: legacyId, kind: "sec" as const, documentId, passageId, excerpt: text.slice(0, 1500), contentSha256: contentHash };
  state.evidence.set(legacyId, old);
  state.frozenSources = [{ sourceId: documentId, title: "Frozen filing", text, url: "https://example.test/filing", publishedAt: state.researchAsOf, form: "10-Q", kind: "sec" }];
  const read = await call(state, "read_snapshot_source", { sourceId: documentId, offset: 0, length: 5000 });
  const id = /\[(e[0-9a-f]{10})\]/.exec(read.observation)![1]!;
  assert.notEqual(id, legacyId); assert.equal(state.evidence.get(legacyId), old);
  assert.equal(state.evidence.get(id)!.excerpt, text); assert.equal(state.evidence.get(id)!.contentSha256, contentHash);
  assert.match((await call(state, "read_valuation_evidence", { evidenceIds: [id] })).observation, /Substantial doubt/);
  const assessment = { key: "financialResilience", score: 7, confidence: "medium", rationale: "The current source explicitly discusses substantial doubt and financing risk, so the resilience assessment stays below the cap.", supportingEvidenceIds: [id], counterEvidenceIds: [id], gaps: [], nextCheck: "Read the next liquidity disclosure.", goingConcern: { status: "unresolved", rationale: "The quoted filing says the doubt remains unresolved.", evidence: [{ evidenceId: id, quote: quotation }] } };
  assert.match((await call(state, "submit_dimension", assessment)).observation, /financialResilience recorded/);
  assert.match((await call(state, "submit_dimension", { ...assessment, goingConcern: { ...assessment.goingConcern, evidence: [{ evidenceId: id, quote: quotation + " An invented assertion." }] } })).observation, /quote a registered passage verbatim/);
  const passage = { documentId, passageId, title: "Frozen filing", form: "10-Q", filedAt: state.researchAsOf, url: "https://example.test/filing", path: [], text, table: null };
  assert.equal(await registerEvidence(state, passage, "sec", state.researchAsOf), id);
  const focused = await registerEvidence(state, passage, "sec", state.researchAsOf, quotation);
  assert.notEqual(focused, id); assert.equal(state.evidence.get(focused)!.contentSha256, contentHash);
});
