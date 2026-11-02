import { z } from "zod";
import type { FindingPassage } from "../../../../shared/analysis-contract/findings.ts";
import { DISCOUNT_RATE_COMPONENTS, EXTENDED_SCENARIO_KEYS, SCENARIO_KEYS, VALUATION_DIMENSIONS, VALUATION_METHODS, VALUATION_MODEL_TYPES, type ConsensusNote, type ConsensusTarget, type DiscountRate, type DiscountRateSources, type FactorDistribution, type ManagementTarget, type PeerMultiples, type SanityGate, type ScenarioAssumptions, type ValuationDimension, type ValuationDimensionKey, type ValuationEvidence, type ValuationGap, type ValuationModelResult, type ValuationSections } from "../../../../shared/analysis-contract/valuation.ts";
import { calculateValuation, dimensionCeilings, discountRateBaseline, horizonOf, MAX_FORECAST_YEARS, MIN_FORECAST_YEARS, outsideHistory, percentileRank, ValuationCalcError, WEIGHT_SUM_TOLERANCE, type CalcContext, type CalcRequest } from "../../../../shared/analysis-runtime/valuation/calculator.ts";
import { anchorOf } from "../../../../shared/analysis-runtime/valuation/prior.ts";
import { EXCLUDED_HOSTS, PAGE_CACHE_MS, hostOf, readWebPage } from "../analyst/web.ts";
import { renderTable } from "../analyst/agent.ts";
import { sha256 } from "../sha256.ts";
import { libraryFindAcross, libraryRead } from "../filing-library/tool.ts";
import { libraryPassages, readLibraryDocument } from "../filing-library/store.ts";
import type { AnalysisEnv } from "../operations.ts";
import { defineTool, type AnyTool } from "../tools/registry.ts";
import { readyTranscripts } from "../transcripts/library.ts";
import type { SearchHit } from "../web-search/types.ts";
import { researchSearch, researchSearchConfigured } from "../web-search/research-search.ts";
import type { BetaEstimate, RiskFreeRate } from "./market.ts";
import type { ValuationInput } from "./input.ts";
import type { ReferenceQuote } from "../../../../shared/analysis-contract/valuation.ts";

/**
 * The tools of the valuation agent (docs/valuation-assessment-implementation.md §5, docs/valuation-methodology-optimization.md §8).
 * Reads register evidence; scores and assumptions may only cite what was registered; every figure comes from the
 * calculator. Three recipes share one state and allow different subsets: research, assumptions and composition.
 */
export const RESEARCH_BUDGET = { finds: 5, reads: 10, searches: 3, webReads: 4, transcripts: 2 } as const;
const READ_CHARS = 5_000, EXCERPT_CHARS = 500, PASSAGE_CHARS = 2_000;

export type RedTeam = { weakestAssumptions: Array<{ factor: string; why: string; evidenceIds: string[] }>; decisiveCounterEvidence: boolean; counterEvidenceIds: string[] };
const goingConcernSchema = z.object({
  status: z.enum(["unresolved", "resolved", "unknown"]),
  rationale: z.string().min(20).max(800),
  evidence: z.array(z.object({ evidenceId: z.string(), quote: z.string().min(20).max(1500) })).max(6),
});
type GoingConcernAssessment = z.infer<typeof goingConcernSchema>;
export type FrozenResearchSource = { sourceId: string; title: string; text: string; url: string; publishedAt: string; form: string; kind: "sec" | "web" };

export type ValuationState = {
  frozenSources?: FrozenResearchSource[];
  nearTermForecast?: { status: "unavailable"; reason: string } | { status: "available"; forecasts: Array<{ metric: string; periodStart: string; periodEnd: string; value: number; unit: string; basis: string; rationale: string; evidenceIds: string[] }> };
  input: ValuationInput;
  researchAsOf: string;
  now: string;
  quote: ReferenceQuote | null;
  riskFree: RiskFreeRate | null;
  beta: BetaEstimate | null;
  /** The ranking peers' trailing multiples at their reference closes, and the company's own EV/EBITDA history; null when the market did not answer. */
  peerMultiples: PeerMultiples | null;
  multipleHistory: FactorDistribution | null;
  evidence: Map<string, ValuationEvidence>;
  hits: SearchHit[];
  used: { finds: number; reads: number; searches: number; webReads: number; transcripts: number };
  dimensions: Map<ValuationDimensionKey, ValuationDimension>;
  /** Internal research classification; public dimensions retain their existing shape. */
  goingConcern?: GoingConcernAssessment;
  researchDone: boolean;
  calc: { request: CalcRequest; result: ValuationModelResult } | null;
  modelGaps: ValuationGap[];
  insufficient: string | null;
  assumptionsDone: boolean;
  redTeam: RedTeam | null;
  composed: { sections: ValuationSections; coreLogicFailed: boolean; decisiveCounterEvidence: boolean } | null;
  cancelled: boolean;
};

const tool = defineTool<ValuationState>();
const untrusted = (host: string, text: string) => `<untrusted source="${host}">\n${text}\n</untrusted>`;
const money = (v: number) => Math.abs(v) >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v.toFixed(2);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
export const factLine = (f: ValuationInput["facts"][number]) => `${f.id} | ${f.label} | ${f.unit === "ratio" ? f.value.toFixed(4) : f.unit === "shares" ? money(f.value) : money(f.value)} ${f.unit === "ratio" ? "" : f.unit} | ${f.periodType}${f.periodEnd ? ` to ${f.periodEnd}` : ""} | ${f.basis}${f.formula ? ` (${f.formula})` : ""}`;

/** Registers a passage once and returns its id: source identity plus content hash, so a re-split passage is new evidence. */
export async function registerEvidence(state: ValuationState, passage: FindingPassage, kind: "sec" | "web", publishedAt: string | null): Promise<string> {
  const contentSha256 = await sha256(passage.text);
  const evidenceId = `e${(await sha256(`${kind}|${passage.documentId}|${passage.passageId}|${contentSha256}`)).slice(0, 10)}`;
  if (!state.evidence.has(evidenceId)) {
    // A filing passage and a management-target passage keep their document and passage ids (the latter are found by `management:<ticker>`); a web page carries none.
    const keepIds = kind === "sec" || passage.form === "management";
    state.evidence.set(evidenceId, { evidenceId, kind, title: passage.title.slice(0, 300), url: passage.url, documentId: keepIds ? passage.documentId : null, passageId: keepIds ? passage.passageId : null, form: passage.form,
      publishedAt: kind === "sec" ? passage.filedAt : publishedAt, fetchedAt: state.now, excerpt: passage.table ? renderTable(passage.table, []).slice(0, 1500) : passage.text.slice(0, 1500), contentSha256, path: passage.path.join(" › ") });
  }
  return evidenceId;
}

const knownId = (state: ValuationState, id: string) => state.evidence.has(id) || state.input.facts.some(f => f.id === id) || state.input.diagnostics.some(d => d.key === id);
/** Evidence ids as prose cites them: in brackets, in parentheses or bare. */
export const CITATION = /\be[0-9a-f]{10}\b/g;
const checkIds = (state: ValuationState, ids: string[], what: string): string[] => ids.filter(id => !knownId(state, id)).map(id => `${what} cites ${id}, which is neither registered evidence, a fact id nor a diagnostic key`);

class GoingConcernEvidenceError extends Error {}

/** The researcher interprets the disclosure, including negation and mitigation; code verifies its citations.
 * No assessment means unknown, never resolved. Gaps and keyword mentions alone are not assessments.
 * Revalidate at every consumer so invalid evidence cannot silently disable the ceiling at publication.
 */
export function goingConcernOf(state: ValuationState, assessment = state.goingConcern): GoingConcernAssessment["status"] {
  if (!assessment) return "unknown";
  if (assessment.status !== "unknown" && !assessment.evidence.length) throw new GoingConcernEvidenceError("going-concern unresolved/resolved assessments need quoted registered evidence");
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  for (const cite of assessment.evidence) {
    const evidence = state.evidence.get(cite.evidenceId);
    if (!evidence || normalize(cite.quote).length < 20 || !normalize(evidence.excerpt).includes(normalize(cite.quote))) {
      throw new GoingConcernEvidenceError(`going-concern evidence ${cite.evidenceId} must quote a registered passage verbatim`);
    }
  }
  return assessment.status;
}

const dimensionSchema = z.object({
  key: z.enum(VALUATION_DIMENSIONS), score: z.number().nullable(), confidence: z.enum(["high", "medium", "low"]),
  rationale: z.string().min(80).max(2000), supportingEvidenceIds: z.array(z.string()).max(12), counterEvidenceIds: z.array(z.string()).max(12),
  gaps: z.array(z.string().max(300)).max(6), nextCheck: z.string().min(10).max(400),
  goingConcern: goingConcernSchema.optional(),
});

function submitDimension(state: ValuationState, value: z.infer<typeof dimensionSchema>, allowed: ValuationDimensionKey[]): string {
  const { goingConcern, ...dimension } = value;
  const errors: string[] = [];
  if (!allowed.includes(value.key)) errors.push(`${value.key} is not scored in this phase`);
  if (value.score != null && (value.score < 0 || value.score > 10 || Math.abs(value.score * 2 - Math.round(value.score * 2)) > 1e-9)) errors.push("score must be 0–10 in steps of 0.5, or null");
  errors.push(...checkIds(state, value.supportingEvidenceIds, "supportingEvidenceIds"), ...checkIds(state, value.counterEvidenceIds, "counterEvidenceIds"));
  if (value.score != null && !value.supportingEvidenceIds.some(id => state.evidence.has(id) && state.evidence.get(id)!.kind === "sec")) errors.push("a scored dimension needs at least one registered filing passage among its supporting evidence");
  if (value.score == null && !value.gaps.length) errors.push("an unscored dimension must name the gap that prevents a score");
  if (goingConcern && value.key !== "financialResilience") errors.push("goingConcern belongs only to financialResilience");
  if (value.key === "financialResilience") {
    const assessment = goingConcern ?? state.goingConcern;
    if (!assessment) errors.push("financialResilience needs goingConcern: unresolved, resolved or unknown, with the rationale and the quoted evidence");
    try {
      if (goingConcernOf(state, assessment) === "unresolved" && value.score != null && value.score > 7.5) errors.push("financialResilience cannot exceed 7.5 with unresolved going-concern evidence");
    } catch (error) {
      if (!(error instanceof GoingConcernEvidenceError)) throw error;
      errors.push(error.message);
    }
    for (const cite of assessment?.evidence ?? []) {
      if (![...value.supportingEvidenceIds, ...value.counterEvidenceIds].includes(cite.evidenceId)) errors.push(`going-concern evidence ${cite.evidenceId} must also be cited by the dimension`);
    }
  }
  if (errors.length) return `Not accepted:\n  ${errors.join("\n  ")}`;
  if (goingConcern) state.goingConcern = goingConcern;
  state.dimensions.set(value.key, dimension);
  return `${value.key} recorded: score ${value.score ?? "null"}, confidence ${value.confidence}.`;
}

const years = z.array(z.number()).min(MIN_FORECAST_YEARS).max(MAX_FORECAST_YEARS);
const commonPath = { revenueGrowth: years, operatingMargin: years, taxRate: years, normalization: years.optional() };
const capitalPlan = z.object({ capex: z.array(z.number().nonnegative()).min(MIN_FORECAST_YEARS).max(MAX_FORECAST_YEARS), depreciation: z.array(z.number().nonnegative()).min(MIN_FORECAST_YEARS).max(MAX_FORECAST_YEARS), workingCapitalChange: years });
const driverPath = z.union([
  z.object({ ...commonPath, salesToCapital: years, buildCapex: years.optional(), capitalPlan: z.null().optional() }),
  z.object({ ...commonPath, capitalPlan, salesToCapital: z.never().optional(), buildCapex: z.never().optional() }),
]);
const drivers = z.discriminatedUnion("modelType", [
  z.object({ modelType: z.literal("fcff"), revenue0: z.number(), path: driverPath, terminalGrowth: z.number(), terminalRoic: z.number(), terminalOperatingMargin: z.number().optional() }),
  z.object({ modelType: z.literal("fcfe"), cfo: z.number(), capex: z.number(), sbc: z.number(), normalization: z.number(), netBorrowing: z.number(), growth: z.array(z.number()).length(5), terminalGrowth: z.number() }),
  z.object({ modelType: z.literal("revenue_fcfe"), revenue0: z.number(), growth: z.array(z.number()).length(5), afterSbcEquityCashMargin: z.array(z.number()).length(5), terminalGrowth: z.number() }),
  z.object({ modelType: z.literal("residual_income"), bookEquity0: z.number(), roe: z.array(z.number()).length(5), payout: z.array(z.number()).length(5), terminalRoe: z.number(), terminalGrowth: z.number() }),
  z.object({ modelType: z.literal("earnings_multiple"), epsLow: z.number(), epsHigh: z.number(), weight: z.number().min(0).max(1), multiple: z.number(), horizonYears: z.number() }).refine(d => d.epsLow <= d.epsHigh, "epsLow must not exceed epsHigh"),
  z.object({ modelType: z.literal("reported_earnings_multiple"), commonEarnings: z.number(), earningsScale: z.number(), multiple: z.number(), horizonYears: z.number() }),
  z.object({ modelType: z.literal("proforma_earnings_multiple"), commonEarnings: z.number(), earningsScale: z.number(), multiple: z.number(), horizonYears: z.number() }),
  z.object({ modelType: z.literal("asset_nav"), assets: z.array(z.object({ units: z.number(), price: z.number(), costBasis: z.number(), taxRate: z.number() })).min(1), otherNetAssets: z.number(), debtClaims: z.number(), preferredClaims: z.number(), operatingReserve: z.number() }),
  z.object({ modelType: z.literal("affo_multiple"), affoLow: z.number(), affoHigh: z.number(), weight: z.number().min(0).max(1), recurringCostPerShare: z.number(), multiple: z.number(), horizonYears: z.number() }).refine(d => d.affoLow <= d.affoHigh, "affoLow must not exceed affoHigh"),
  z.object({ modelType: z.literal("affo_dcf"), annualAffo: z.number(), recurringCost: z.number(), growth: z.array(z.number()).length(5), terminalGrowth: z.number() }),
]);
/**
 * Every judgement the calculation rests on is a required argument (docs/valuation-v2-SPEC.md, "v3: judged weights and the
 * management scenario"): a missing or malformed one is a schema error the model reads and corrects; nothing is defaulted by code.
 */
const ids = (max: number, min = 0) => z.array(z.string().max(40)).min(min).max(max);
const judgement = z.object({ rationale: z.string().min(20).max(1200), evidenceIds: ids(10, 1) });
const weightJudgement = z.object({ weight: z.number().min(0).max(1), rationale: z.string().min(60).max(1500), evidenceIds: ids(10, 1) });
const probabilityJudgement = z.object({ probability: z.number().min(0).max(1), rationale: z.string().min(20).max(1000), evidenceIds: ids(10) });
/** The management scenario's probability: without a target set the rationale is just "no target set". */
const managementProbability = probabilityJudgement.extend({ rationale: z.string().min(5).max(1000) });
const sumsToOne = (values: number[]) => Math.abs(values.reduce((a, b) => a + b, 0) - 1) <= WEIGHT_SUM_TOLERANCE;
/** A discount-rate component: its value (null only when the basis does not need it), where it came from and the evidence or fact ids behind it. */
const component = z.object({ value: z.number().nullable(), source: z.string().min(3).max(400), evidenceIds: ids(6) });
const scenarioSchema = z.object({
  narrative: z.string().min(20).max(1500), triggers: z.array(z.string().min(5).max(400)).min(1).max(6), invalidation: z.array(z.string().min(5).max(400)).min(1).max(6), evidenceIds: ids(12, 1), drivers,
  /** Why the revenue, margin and capex paths run as they do, each with its evidence. */
  assumptions: z.object({ revenue: judgement, margin: judgement, capex: judgement }),
});
const calcSchema = z.object({
  modelType: z.enum(VALUATION_MODEL_TYPES),
  discountRate: z.object({
    basis: z.enum(["wacc", "cost_of_equity"]), riskFree: component, beta: component, equityRiskPremium: component, costOfDebt: component, taxRate: component, equityWeight: component,
    rationale: z.string().min(20).max(1500),
  }).refine(d => d.basis === "wacc" ? DISCOUNT_RATE_COMPONENTS.every(k => d[k].value != null) : (["riskFree", "beta", "equityRiskPremium"] as const).every(k => d[k].value != null), { message: "wacc needs a value for riskFree, beta, equityRiskPremium, costOfDebt, taxRate and equityWeight; cost_of_equity for riskFree, beta and equityRiskPremium (the others null with the reason as source)" }),
  shares: z.object({ baseFactId: z.string(), dilutionPercent: z.number().min(0).max(0.5), rationale: z.string().min(10).max(800) }),
  bridge: z.object({ nonOperatingAssets: z.number(), debtAndClaims: z.number(), nonOperatingEquityAdjustment: z.number(), notes: z.array(z.string().max(400)).min(1).max(10) }),
  scenarios: z.object({ bear: scenarioSchema, base: scenarioSchema, bull: scenarioSchema }),
  fairValueBasis: z.discriminatedUnion("status", [
    z.object({ status: z.literal("available"), kind: z.literal("normal_cases"), lower: scenarioSchema, upper: scenarioSchema, rationale: z.string().min(60).max(1500), evidenceIds: ids(12, 1) }),
    z.object({ status: z.literal("unavailable"), reason: z.string().min(20).max(1000), evidenceIds: ids(12) }),
  ]),
  /** Mid-year discounting (true) or year end (false). */
  midYear: z.boolean(),
  /** The forecast year the forward multiples are applied to (usually 3). */
  forwardYears: z.number().int().min(1).max(5),
  /**
   * The weight of each method, judged from the business and its outlook; non-negative, summing to 1, no bounds. A method
   * that cannot be applied still gets a weight (0) with the reason; the calculator says which methods applied.
   */
  methodWeights: z.object({ dcf: weightJudgement, ev_ebitda_forward: weightJudgement, pe_forward: weightJudgement }).refine(w => sumsToOne(VALUATION_METHODS.map(k => w[k].weight)), { message: `the three method weights must sum to 1 (tolerance ${WEIGHT_SUM_TOLERANCE})` }),
  /** The probability of each scenario, judged with evidence; the four sum to 1. management is 0 with the reason when the company has no cited target set. */
  scenarioProbabilities: z.object({ bear: probabilityJudgement, base: probabilityJudgement, management: managementProbability, bull: probabilityJudgement }).refine(p => sumsToOne(EXTENDED_SCENARIO_KEYS.map(k => p[k].probability)), { message: `the four scenario probabilities must sum to 1 (tolerance ${WEIGHT_SUM_TOLERANCE})` }),
  /** The explanation of the gap between the base path and management's cited targets (the figures are computed); null only when the company has no target set. */
  managementComparison: z.object({ explanation: z.string().min(40).max(1500), evidenceIds: ids(10, 1) }).nullable(),
  /** A sell-side consensus target read from a registered page (compared, never copied), or the reason none could be cited. */
  consensus: z.discriminatedUnion("status", [
    z.object({ status: z.literal("cited"), mean: z.number().positive(), low: z.number().nullable(), high: z.number().nullable(), count: z.number().int().nullable(), asOf: z.string().max(10).nullable(), evidenceId: z.string(), source: z.string().min(3).max(300) }),
    z.object({ status: z.literal("unavailable"), reason: z.string().min(20).max(600) }),
  ]),
});
type CalcArgs = z.infer<typeof calcSchema>;

/** Management's registered target evidence ids, the ones the management scenario has to cite. */
const managementEvidenceIds = (state: ValuationState) => [...state.evidence.values()].filter(e => e.documentId === `management:${state.input.ticker}`).map(e => e.evidenceId);

function runCalculation(state: ValuationState, args: CalcArgs): string {
  const errors: string[] = [];
  const facts = state.input.facts;
  const baseShares = facts.find(f => f.id === args.shares.baseFactId && f.unit === "shares");
  if (!baseShares) errors.push(`shares.baseFactId must be a share-count fact id (${facts.filter(f => f.unit === "shares").map(f => f.id).join(", ") || "none available"})`);
  for (const key of SCENARIO_KEYS) {
    const s = args.scenarios[key];
    if (s.drivers.modelType !== args.modelType) errors.push(`scenario ${key} uses ${s.drivers.modelType}, not ${args.modelType}`);
    errors.push(...checkIds(state, s.evidenceIds, `scenario ${key}`), ...(["revenue", "margin", "capex"] as const).flatMap(k => checkIds(state, s.assumptions[k].evidenceIds, `scenario ${key} ${k} assumption`)));
    if (s.drivers.modelType === "fcff") { try { horizonOf(s.drivers.path); } catch (error) { errors.push(`scenario ${key}: ${(error as Error).message}`); } }
  }
  const lengths = new Set(SCENARIO_KEYS.map(k => { const d = args.scenarios[k].drivers; return d.modelType === "fcff" ? d.path.revenueGrowth.length : 0; }));
  if (lengths.size > 1) errors.push("every scenario must use the same horizon");
  errors.push(...checkIds(state, args.fairValueBasis.evidenceIds, "fairValueBasis"));
  if (args.fairValueBasis.status === "available") for (const key of ["lower", "upper"] as const) {
    const normal = args.fairValueBasis[key];
    errors.push(...checkIds(state, normal.evidenceIds, `normal ${key}`), ...(["revenue", "margin", "capex"] as const).flatMap(k => checkIds(state, normal.assumptions[k].evidenceIds, `normal ${key} ${k}`)));
  }
  for (const key of VALUATION_METHODS) errors.push(...checkIds(state, args.methodWeights[key].evidenceIds, `methodWeights.${key}`));
  for (const key of EXTENDED_SCENARIO_KEYS) errors.push(...checkIds(state, args.scenarioProbabilities[key].evidenceIds, `scenarioProbabilities.${key}`));
  for (const key of DISCOUNT_RATE_COMPONENTS) errors.push(...checkIds(state, args.discountRate[key].evidenceIds, `discountRate.${key}`));
  if (args.consensus.status === "cited" && !state.evidence.has(args.consensus.evidenceId)) errors.push(`consensus cites ${args.consensus.evidenceId}, which is not registered evidence`);
  // The management scenario exists only for a company with a cited target set, and then it has to cite that evidence.
  const managementIds = managementEvidenceIds(state);
  const management = args.scenarioProbabilities.management;
  if (state.input.management) {
    if (!args.managementComparison) errors.push("managementComparison is required: this company has cited management targets; explain the gap between the base path and them");
    else errors.push(...checkIds(state, args.managementComparison.evidenceIds, "managementComparison"));
    if (!management.evidenceIds.some(id => managementIds.includes(id))) errors.push(`scenarioProbabilities.management must cite management's registered target evidence (${managementIds.join(", ") || "none registered"})`);
  } else {
    if (args.managementComparison) errors.push("managementComparison must be null: this company has no cited management target set");
    if (management.probability !== 0) errors.push("scenarioProbabilities.management must be 0 (rationale: no target set): this company has no cited management targets");
  }
  if (errors.length) return `Not accepted:\n  ${errors.join("\n  ")}`;
  // The discount rate from its sourced components; every one is required by the schema for the basis chosen.
  const d = args.discountRate;
  const baseline = discountRateBaseline({ riskFree: d.riskFree.value!, beta: d.beta.value!, equityRiskPremium: d.equityRiskPremium.value!, costOfDebt: d.costOfDebt.value, taxRate: d.taxRate.value, equityWeight: d.equityWeight.value }, d.basis);
  if (!baseline) return "Not accepted: the discount rate could not be computed from the components given.";
  const value = baseline.value;
  const gaps: ValuationGap[] = [];
  if (!d.equityRiskPremium.evidenceIds.length) gaps.push({ code: "discount_rate_unsourced", message: `The equity risk premium ${pct(d.equityRiskPremium.value!)} cites no registered evidence (stated source: ${d.equityRiskPremium.source}).`, evidenceIds: [] });
  const sources = Object.fromEntries(DISCOUNT_RATE_COMPONENTS.map(k => [k, { source: d[k].source, evidenceIds: d[k].evidenceIds }])) as DiscountRateSources;
  const discountRate: DiscountRate = { value, basis: d.basis, components: { riskFree: d.riskFree.value, beta: d.beta.value, equityRiskPremium: d.equityRiskPremium.value, costOfEquity: baseline.costOfEquity, costOfDebt: d.costOfDebt.value, taxRate: d.taxRate.value, equityWeight: d.equityWeight.value }, rationale: d.rationale, sourceRefs: DISCOUNT_RATE_COMPONENTS.map(k => `${k}: ${d[k].source}`), sources };
  const consensus: ConsensusTarget | null = args.consensus.status === "cited" ? { mean: args.consensus.mean, low: args.consensus.low, high: args.consensus.high, count: args.consensus.count, asOf: args.consensus.asOf, evidenceId: args.consensus.evidenceId } : null;
  const consensusNote: ConsensusNote = args.consensus.status === "cited" ? { status: "cited", source: args.consensus.source, reason: null } : { status: "unavailable", source: null, reason: args.consensus.reason };
  const request: CalcRequest = {
    modelType: args.modelType, currency: state.input.currency, discountRate, shares: { base: baseShares!.value, dilutionReserve: baseShares!.value * args.shares.dilutionPercent, basis: `${baseShares!.id}; dilution ${(args.shares.dilutionPercent * 100).toFixed(2)}% of base; ${args.shares.rationale}` },
    bridge: args.bridge, price: state.quote?.usable ? state.quote.price : null, midYear: args.midYear,
    fairValueBasis: args.fairValueBasis,
    // The scenarios' probabilities are the judged ones; the calculator writes them onto each scenario from the four-way set.
    scenarios: Object.fromEntries(SCENARIO_KEYS.map(k => [k, { ...args.scenarios[k], probability: null } satisfies ScenarioAssumptions])) as Record<"bear" | "base" | "bull", ScenarioAssumptions>,
    context: calcContext(state, args, consensus, consensusNote),
  };
  let result: ValuationModelResult;
  try { result = calculateValuation(request); }
  catch (error) {
    if (error instanceof ValuationCalcError) return `The calculator rejected the inputs (${error.code}): ${error.message}. Revise and call calculate_valuation again.`;
    throw error;
  }
  // A failed gate is a modelling error, not an opinion: the calculation is not recorded until the path is revised.
  const failed = (result.gates ?? []).filter(g => g.status === "fail");
  if (failed.length) return `Not accepted (gates):\n  ${failed.map(g => `${g.key}: ${g.detail}`).join("\n  ")}\nRevise (longer horizon, build capex that ends, a normalized terminal margin, a lower terminal growth, inputs equal to the facts) and call calculate_valuation again.`;
  // Each assumption against the company's own history: outside it needs the scenario to say why this time is different.
  const placements: string[] = [];
  if (args.modelType === "fcff") {
    for (const key of SCENARIO_KEYS) {
      const path = args.scenarios[key].drivers;
      if (path.modelType !== "fcff") continue;
      const avg = (list: number[]) => list.reduce((a, b) => a + b, 0) / list.length;
      for (const [factor, value] of [["revenueGrowth", avg(path.path.revenueGrowth)], ["operatingMargin", avg(path.path.operatingMargin)]] as const) {
        const distribution = state.input.distributions.find(x => x.factor === factor);
        if (!distribution) continue;
        const rank = percentileRank(distribution, value);
        placements.push(`${key} ${factor} ${pct(value)} sits at the ${Math.round(rank * 100)}th percentile of ${distribution.periods.length} years (${pct(distribution.min)}–${pct(distribution.max)})`);
        if (outsideHistory(distribution, value)) gaps.push({ code: "assumption_out_of_history_range", field: `${key}.${factor}`, message: `${key} ${factor} ${pct(value)} is outside the company's history (${pct(distribution.min)} to ${pct(distribution.max)}); the narrative must say why this time differs.`, evidenceIds: args.scenarios[key].evidenceIds });
      }
    }
  }
  const terminalShare = result.scenarios.base.result.terminalShare;
  gaps.push(...gateGaps(result.gates ?? []));
  if (result.fairValueRange?.status === "available") for (const key of ["lower", "upper"] as const) gaps.push(...gateGaps(result.fairValueRange[key].gates).map(g => ({ ...g, field: `normal.${key}.${g.field}` })));
  state.calc = { request, result };
  state.modelGaps = gaps;
  state.insufficient = null;
  const r = result.range;
  const line = (k: "bear" | "base" | "bull") => { const s = result.scenarios[k]; return `${k}: DCF ${s.result.perShare.toFixed(2)}, weighted ${s.valuation ? s.valuation.perShare.toFixed(2) : "n/a"} per share, p=${pct(args.scenarioProbabilities[k].probability)}` + (s.result.terminalShare != null ? ` (terminal ${pct(s.result.terminalShare)})` : ""); };
  const ms = result.managementScenario ?? null;
  const ceilings = dimensionCeilings({ marginOfSafety: r.marginOfSafety, downsideCoverage: r.downsideCoverage, bearProbability: args.scenarioProbabilities.bear.probability, terminalShare, hasIndependentConsensus: !!consensus, impliedGap: result.implied?.gap ?? null, impliedGapThreshold: impliedThreshold(state), goingConcernUnresolved: goingConcernOf(state) === "unresolved" });
  const methods = (result.methods ?? []).map(m => `${m.method} (weight ${pct(m.weight)}): ${m.base != null ? `${m.low!.toFixed(2)} / ${m.base.toFixed(2)} / ${m.high!.toFixed(2)}` : `not applied — ${m.notes[0] ?? "n/a"}`}`);
  const flagged = (result.gates ?? []).filter(g => g.status !== "pass");
  return [
    `Calculated (${result.modelType}, ${result.horizonYears} years, r = ${pct(value)} ${d.basis} from components; economic shares ${money(result.shares.economic)}).`,
    result.fairValueRange?.status === "available" ? `Normal fair-value range: ${result.fairValueRange.low.toFixed(2)} – ${result.fairValueRange.base.toFixed(2)} – ${result.fairValueRange.high.toFixed(2)} per share; independent normal operating paths, not stress endpoints or a price target. ${result.fairValueRange.rationale}` : `Normal fair-value range unavailable: ${result.fairValueRange?.status === "unavailable" ? result.fairValueRange.reason : "not assessed"}.`,
    SCENARIO_KEYS.map(line).join("\n"),
    ms ? `management (cited targets, computed by code): DCF ${ms.result.perShare.toFixed(2)}, weighted ${ms.valuation ? ms.valuation.perShare.toFixed(2) : "n/a"} per share, p=${pct(management.probability)}${ms.result.terminalShare != null ? ` (terminal ${pct(ms.result.terminalShare)})` : ""}; ${ms.anchors.filter(a => a.metric === "revenue").map(a => `FY${a.fiscalYear} revenue ${money(a.target)} in year ${a.year}`).join(", ")}` : "management scenario: none (no cited total-revenue target inside the horizon)",
    `range (method-weighted): ${r.low.toFixed(2)} – ${r.base.toFixed(2)} – ${r.high.toFixed(2)}; expected (probability-weighted over bear/base/management/bull): ${r.expected != null ? r.expected.toFixed(2) : "n/a"}; price ${r.price ?? "n/a"}; margin of safety on the base ${r.marginOfSafety != null ? pct(r.marginOfSafety) : "n/a"}; downside coverage ${r.downsideCoverage != null ? pct(r.downsideCoverage) : "n/a"}`,
    `methods on the base path (p25 / median / p75 of peers ${result.peers?.peers.join(", ") || "none"}): ${methods.join("; ")}${result.triangulation ? `; football field ${result.triangulation.low.toFixed(2)}–${result.triangulation.high.toFixed(2)}, base ${result.triangulation.base.toFixed(2)}` : ""}`,
    result.managementComparison ? `management comparison: ${result.managementComparison.rows.map(row => `year ${row.year} (FY${row.fiscalYear}) base ${money(row.base)} vs target ${money(row.target)} (${row.gap >= 0 ? "+" : ""}${(row.gap * 100).toFixed(0)}%)`).join("; ")}` : "",
    result.implied ? `market-implied constant revenue growth: ${pct(result.implied.implied)} vs base average ${pct(result.implied.baseAverage)} (gap ${pct(result.implied.gap)}${result.implied.converged ? "" : ", not converged"})` : "",
    `gates: ${(result.gates ?? []).length - flagged.length} pass${flagged.length ? `; ${flagged.map(g => `${g.key} ${g.status}: ${g.detail}`).join("; ")}` : ""}`,
    `sensitivities (base DCF): ${result.sensitivities.slice(0, 4).map(s => `${s.factor} ${s.step} → ${s.changePercent >= 0 ? "+" : ""}${s.changePercent.toFixed(1)}%`).join("; ")}`,
    placements.length ? `history: ${placements.join("; ")}` : "",
    `ceilings now in force: ${Object.entries(ceilings).map(([k, v]) => `${k} ≤ ${v}`).join(", ") || "none"}`,
    "Submit valuationSafety with submit_dimension, then finish_assumptions; or revise and calculate again.",
  ].filter(Boolean).join("\n");
}

/** What the calculator may compare the model against: facts, the RPO floor over the chosen horizon, peers, history, the trailing figures and the judgements. */
function calcContext(state: ValuationState, args: CalcArgs, consensus: ConsensusTarget | null, consensusNote: ConsensusNote): CalcContext {
  const fact = (id: string) => state.input.facts.find(f => f.id === id)?.value ?? null;
  const base = args.scenarios.base.drivers;
  const years = base.modelType === "fcff" ? base.path.revenueGrowth.length : MIN_FORECAST_YEARS;
  const rpo = state.input.rpo;
  const anchor = rpo && base.modelType === "fcff" ? anchorOf({ asOf: rpo.asOf, total: Number(rpo.total), buckets: rpo.buckets.map(b => ({ start: b.start, months: b.months, share: b.share == null ? null : Number(b.share) })) }, years, base.revenue0) : null;
  return {
    facts: state.input.facts.map(f => ({ id: f.id, value: f.value, unit: f.unit })), riskFree: state.riskFree?.value ?? null, anchor, peers: state.peerMultiples, consensus, consensusNote, multipleHistory: state.multipleHistory,
    trailing: { ebitda: fact("ebitda_ttm"), da: fact("da_ttm"), interestExpense: fact("interest_expense_ttm") }, forwardYears: args.forwardYears, methodWeights: args.methodWeights, lifecycle: state.input.lifecycle,
    management: state.input.management, periodEnd: state.input.financialPeriodEnd, scenarioProbabilities: args.scenarioProbabilities,
    managementComparison: args.managementComparison ? { rationale: args.managementComparison.explanation, evidenceIds: args.managementComparison.evidenceIds } : null,
  };
}

const GATE_GAP: Partial<Record<string, ValuationGap["code"]>> = { terminal_share: "tv_share_high", terminal_growth: "terminal_growth_high", cited_inputs: "cited_input_mismatch", rpo_floor: "rpo_floor_breached", implied_multiple_vs_history: "implied_multiple_outside_history", method_dispersion: "method_dispersion", consensus_divergence: "consensus_divergence", consensus_unavailable: "unverified_consensus", non_negative_scenarios: "negative_scenario", management_targets: "management_target_gap", method_unavailable: "method_unavailable", method_zero_weight: "method_zero_weight" };
/** Flagged gates as gaps the report carries; a passing gate leaves nothing behind. */
export function gateGaps(gates: SanityGate[]): ValuationGap[] {
  return gates.flatMap(g => g.status === "pass" || !GATE_GAP[g.key] ? [] : [{ code: GATE_GAP[g.key]!, field: g.key, message: g.detail, evidenceIds: [] }]);
}

/** The interquartile range of revenue growth, as the spec's threshold for a quantified expectations gap. */
export function impliedThreshold(state: ValuationState): number | null {
  const d = state.input.distributions.find(x => x.factor === "revenueGrowth");
  return d ? Math.max(d.p75 - d.p25, 0.01) : null;
}

export function valuationTools(env: AnalysisEnv): AnyTool<ValuationState>[] {
  const db = env.DB!;
  const search = researchSearchConfigured(env) ? researchSearch(env) : null;
  return [
    tool({ name: "list_snapshot_sources", description: "The only original documents available at this historical cutoff. Read them with read_snapshot_source; find offsets with find_snapshot_passages.", parameters: z.object({}), concurrencySafe: true,
      execute: (_args, ctx) => (ctx.state.frozenSources ?? []).map(s => `${s.sourceId} | ${s.title} | published ${s.publishedAt} | ${s.text.length} characters`).join("\n"), observe: (_a, v) => v }),
    tool({ name: "find_snapshot_passages", description: "Find original text in the frozen documents; returns offsets for read_snapshot_source.", parameters: z.object({ terms: z.array(z.string().min(2).max(80)).min(1).max(6) }), concurrencySafe: true,
      execute: ({ terms }, ctx) => {
        if (ctx.state.used.finds >= RESEARCH_BUDGET.finds) throw new Error("No finds left; read the frozen sources.");
        ctx.state.used.finds++;
        return (ctx.state.frozenSources ?? []).flatMap(s => terms.flatMap(term => {
          const offset = s.text.toLowerCase().indexOf(term.toLowerCase());
          return offset < 0 ? [] : [`${s.sourceId} offset ${Math.max(0, offset - 200)}: ${s.text.slice(Math.max(0, offset - 100), offset + 300)}`];
        })).slice(0, 12).join("\n") || "No matching passage in the frozen sources.";
      }, observe: (_a, v) => v }),
    tool({ name: "read_snapshot_source", description: "Read original text from one frozen source and register evidence. Only evidence actually read may support a judgement.", parameters: z.object({ sourceId: z.string(), offset: z.number().int().min(0), length: z.number().int().min(100).max(READ_CHARS) }),
      execute: async ({ sourceId, offset, length }, ctx) => {
        if (ctx.state.used.reads >= RESEARCH_BUDGET.reads) throw new Error("No original-text reads left.");
        const source = ctx.state.frozenSources?.find(s => s.sourceId === sourceId);
        if (!source || offset >= source.text.length) throw new Error("Unknown frozen source or offset.");
        ctx.state.used.reads++;
        const text = source.text.slice(offset, offset + length);
        const id = await registerEvidence(ctx.state, { documentId: source.sourceId, passageId: `${source.sourceId}:${offset}`, title: source.title, form: source.form, filedAt: source.publishedAt, url: source.url, path: ["Frozen original", `offset ${offset}`], text, table: null }, source.kind, source.publishedAt);
        return `[${id}] ${source.title}\n${text}`;
      }, observe: (_a, v) => v }),
    tool({ name: "read_financials", description: "The validated financial facts (ids, values, periods). Pass ids to read some, none to read all.", parameters: z.object({ ids: z.array(z.string()).max(40).optional() }), concurrencySafe: true,
      execute: ({ ids }, ctx) => { const facts = ctx.state.input.facts.filter(f => !ids?.length || ids.includes(f.id)); return facts.length ? facts.map(factLine).join("\n") : "No such facts."; }, observe: (_a, v) => v }),
    tool({ name: "list_filings", description: "The filings this run may read, newest first.", parameters: z.object({}), concurrencySafe: true,
      execute: (_a, ctx) => ctx.state.input.documents.map(d => `${d.form} filed ${d.filedAt} (report ${d.reportDate}) · documentId ${d.documentId}${d.docType !== "primary" ? ` · ${d.docType}` : ""}`).join("\n") || "No filings are available to read.", observe: (_a, v) => v }),
    tool({ name: "find_filing_sections", description: "Find sections of the readable filings by question, keywords or canonical part (business, risk_factors, mdna, note, press_release...).", parameters: z.object({ question: z.string().max(300).optional(), keywords: z.string().max(200).optional(), canonical: z.string().max(40).optional() }), concurrencySafe: true,
      execute: async (args, ctx) => {
        if (ctx.state.used.finds >= RESEARCH_BUDGET.finds) throw new Error("no finds left; read what you found");
        ctx.state.used.finds++;
        const allowed = new Set(ctx.state.input.documents.map(d => d.documentId));
        const found = await ctx.stage("find", () => libraryFindAcross(env, { tickers: [ctx.state.input.ticker], question: args.question, keywords: args.keywords, canonical: args.canonical as never, limit: 12 }));
        const rows = found.found.filter(s => allowed.has(s.documentId)).slice(0, 8);
        return rows.map(s => `${s.form} ${s.filedAt} · documentId ${s.documentId} · sectionId ${s.sectionId} · ${s.path.join(" › ")}${s.gist ? ` · ${s.gist.slice(0, 160)}` : ""}`).join("\n") || "No sections found in the readable filings; try other keywords or list_filings.";
      }, observe: (_a, v) => v }),
    tool({ name: "read_filing_section", description: "Read a section of a readable filing. Each passage becomes evidence [e…] a score or scenario may cite.", parameters: z.object({ documentId: z.string().max(80), sectionId: z.string().max(80).optional(), focus: z.array(z.string().max(60)).max(8).optional() }),
      execute: async (args, ctx) => {
        if (ctx.state.used.reads >= RESEARCH_BUDGET.reads) throw new Error("no filing reads left; score with the evidence you have");
        if (!ctx.state.input.documents.some(d => d.documentId === args.documentId)) throw new Error("that documentId is not among this run's readable filings (list_filings)");
        ctx.state.used.reads++;
        const read = await ctx.stage("read", async () => {
          const document = await readLibraryDocument(db, args.documentId);
          if (!document || document.ticker !== ctx.state.input.ticker) return null;
          const read = await libraryRead(db, { documentId: args.documentId, sectionId: args.sectionId, focus: args.focus, maxChars: READ_CHARS });
          const full = await libraryPassages(db, read.passages.map(p => p.passageId));
          return { passages: read.passages.map(p => { const row = full.find(f => f.passageId === p.passageId); return { passageId: p.passageId, documentId: args.documentId, title: `${document.ticker} ${document.form} ${document.reportDate}`, form: document.form, filedAt: document.filedAt, url: document.documentUrl, path: p.path.split(" › "), text: p.text,
            table: row?.table ? { unit: row.table.unit, columns: row.table.columns, rows: row.table.rows.map(r => ({ label: r.label, cells: r.cells.map(c => ({ text: c.text, value: c.value })) })) } : null } satisfies FindingPassage; }), omitted: read.omitted };
        });
        if (!read) throw new Error("the filing could not be read");
        const out: string[] = [];
        for (const p of read.passages) out.push(`[${await registerEvidence(ctx.state, p, "sec", null)}] ${p.path.join(" › ")}\n${p.table ? renderTable(p.table, args.focus ?? []) : p.text.slice(0, PASSAGE_CHARS)}`);
        return out.join("\n\n") + (read.omitted ? `\n(${read.omitted} passages omitted; narrow with focus)` : "");
      }, observe: (_a, v) => v }),
    tool({ name: "read_guidance", description: "Management guidance as extracted from the company's releases and calls.", parameters: z.object({}), concurrencySafe: true,
      execute: (_a, ctx) => { const g = ctx.state.input.guidance; return g?.items.length ? g.items.slice(0, 30).map(i => `${i.id} · ${i.label} · ${i.horizon}${i.fiscalYear ? ` FY${i.fiscalYear}` : ""}${i.fiscalQuarter ? ` Q${i.fiscalQuarter}` : ""} · ${i.basis} · ${i.low ?? "?"}–${i.high ?? "?"} ${i.unit ?? ""} · ${i.text.slice(0, 200)}`).join("\n") : "No extracted guidance."; }, observe: (_a, v) => v }),
    tool({ name: "read_transcript", description: "Read an earnings call around focus terms. The excerpt becomes evidence.", parameters: z.object({ transcriptId: z.string().max(80), focus: z.array(z.string().max(60)).min(1).max(8) }),
      execute: async (args, ctx) => {
        if (ctx.state.used.transcripts >= RESEARCH_BUDGET.transcripts) throw new Error("no transcript reads left");
        const meta = ctx.state.input.transcripts.find(t => t.id === args.transcriptId);
        if (!meta) throw new Error("that transcriptId is not among this run's calls");
        ctx.state.used.transcripts++;
        const text = await ctx.stage("transcript", async () => {
          const rows = await readyTranscripts(db, ctx.state.input.ticker, "1900-01-01");
          const row = rows.find(r => r.id === args.transcriptId);
          if (!row) return null;
          const lower = row.content.toLowerCase(), terms = args.focus.map(f => f.toLowerCase());
          const spots = terms.flatMap(t => { const i = lower.indexOf(t); return i >= 0 ? [i] : []; }).sort((a, b) => a - b).slice(0, 4);
          const pieces = (spots.length ? spots : [0]).map(i => row.content.slice(Math.max(0, i - 400), i + 1100));
          return pieces.join("\n…\n").slice(0, READ_CHARS);
        });
        if (!text) throw new Error("the call could not be read");
        const id = await registerEvidence(ctx.state, { passageId: `transcript:${meta.id}`, documentId: `transcript:${meta.id}`, title: meta.title, form: "transcript", filedAt: meta.filedAt, url: meta.sourceUrl, path: ["earnings call", `FY${meta.fiscalYear} Q${meta.fiscalQuarter}`], text, table: null }, "sec", meta.filedAt);
        return `[${id}] ${meta.title}\n${text}`;
      }, observe: (_a, v) => v }),
    tool({ name: "search_evidence", description: "Search the web for one specific gap (a guidance change, a launch date, an official statistic). Hits h<n> can be read with read_web_evidence.", parameters: z.object({ gap: z.string().max(200), query: z.string().min(3).max(300), domains: z.array(z.string().max(80)).max(4).optional() }),
      execute: async ({ query, domains }, ctx) => {
        if (!search) throw new Error("web search is not configured; use the filings");
        if (ctx.state.used.searches >= RESEARCH_BUDGET.searches) throw new Error("no searches left");
        ctx.state.used.searches++;
        const endDate = ctx.state.researchAsOf.slice(0, 10), startDate = `${Number(endDate.slice(0, 4)) - 1}${endDate.slice(4)}`;
        const found = await ctx.stage("search", () => search.search({ query, maxResults: 5, depth: "advanced", topic: "general", startDate, endDate, ...(domains?.length ? { includeDomains: domains } : { excludeDomains: EXCLUDED_HOSTS }) }, { scope: `spontra:valuation:${ctx.state.input.ticker}`, maxAgeMs: 6 * 60 * 60_000 }).then(r => r.data.results).catch(() => [] as SearchHit[]));
        for (const h of found) if (!ctx.state.hits.some(x => x.url === h.url)) ctx.state.hits.push(h);
        return found.map(h => `[h${ctx.state.hits.findIndex(x => x.url === h.url) + 1}] ${h.title.slice(0, 160)} (${hostOf(h.url)} · ${h.publishedAt?.slice(0, 10) ?? "undated"})\n${untrusted(hostOf(h.url), h.snippet.replace(/\s+/g, " ").slice(0, 240))}`).join("\n") || `Search "${query}" returned nothing; a snippet is never evidence, only a read page is.`;
      }, observe: (_a, v) => v }),
    tool({ name: "read_web_evidence", description: "Read one page from this run's search hits by hit id (h2). The excerpt becomes evidence.", parameters: z.object({ hit: z.string().regex(/^h\d{1,2}$/), focus: z.array(z.string().max(60)).max(8).optional() }),
      execute: async ({ hit, focus }, ctx) => {
        if (!search) throw new Error("web reading is not configured");
        if (ctx.state.used.webReads >= RESEARCH_BUDGET.webReads) throw new Error("no web reads left");
        const target = ctx.state.hits[Number(hit.slice(1)) - 1];
        if (!target) throw new Error("read_web_evidence needs a hit id from this run's searches");
        ctx.state.used.webReads++;
        const read = await ctx.stage("web", () => readWebPage(env, ctx.state.input.ticker, target, (focus ?? []).map(f => f.toLowerCase()), ctx.state.now, url => search.fetchContent({ url, depth: "advanced" }, { scope: `spontra:valuation:${ctx.state.input.ticker}`, maxAgeMs: PAGE_CACHE_MS }).then(r => ({ text: r.data.text }))));
        if (!read) throw new Error(`${hostOf(target.url)} could not be read (unreadable_source)`);
        const id = await registerEvidence(ctx.state, read.passage, "web", read.record.publishedAt);
        return `[${id}] ${read.record.title} (${hostOf(target.url)} · ${read.record.publishedAt ?? "undated"})\n${untrusted(hostOf(target.url), read.passage.text.slice(0, 3000))}`;
      }, observe: (_a, v) => v }),
    tool({ name: "submit_dimension", description: "Record one dimension's score (0–10 in 0.5 steps, or null with a gap), confidence, rationale and evidence ids. For financialResilience, include goingConcern: unresolved for current substantial doubt not alleviated by completed mitigation, resolved only when disclosure explicitly establishes alleviation, unknown when evidence is insufficient. Explain the classification and quote registered evidence verbatim; also cite those ids in the dimension. Unresolved risk caps the score at 7.5.", parameters: dimensionSchema,
      execute: (value, ctx) => submitDimension(ctx.state, value, ctx.state.researchDone ? ["valuationSafety"] : ["businessQuality", "growthExecution", "financialResilience", "mispricingCatalysts"]), observe: (_a, v) => v }),
    tool({ name: "finish_research", description: "End the research phase once businessQuality, growthExecution, financialResilience and mispricingCatalysts are each submitted.", parameters: z.object({}),
      execute: (_a, ctx) => {
        const missing = (["businessQuality", "growthExecution", "financialResilience", "mispricingCatalysts"] as const).filter(k => !ctx.state.dimensions.has(k));
        if (missing.length) throw new Error(`submit ${missing.join(", ")} first (score null with a gap is allowed)`);
        ctx.state.researchDone = true; return "Research recorded.";
      }, observe: (_a, v) => v }),
    tool({ name: "calculate_valuation", description: `Run the calculator: one model, three coherent scenarios sharing one discount rate built from sourced components, a ${MIN_FORECAST_YEARS}–${MAX_FORECAST_YEARS} year path (fcff uses either salesToCapital with optional buildCapex, or capitalPlan with explicit capex, depreciation and workingCapitalChange arrays of the same length; never both. With capitalPlan, net reinvestment is capex minus depreciation plus workingCapitalChange; EBITDA uses that year's depreciation. terminalOperatingMargin is optional), the judged method weights (sum 1) and scenario probabilities for bear/base/management/bull (sum 1), the management-target comparison and the consensus (or why none). Every field is required; a missing one is a schema error. Returns each scenario's DCF and method-weighted value, the management scenario, the expected value, the cross-check, gates, the market-implied path and gaps; a failed gate is not recorded.`, parameters: calcSchema, strict: false, timeoutMs: 20_000,
      execute: (args, ctx) => runCalculation(ctx.state, args), observe: (_a, v) => v }),
    tool({ name: "declare_model_insufficient", description: "State that no model can be computed from the registered facts and say which inputs are missing.", parameters: z.object({ reason: z.string().min(20).max(600), missingFactIds: z.array(z.string().max(60)).min(1).max(10) }),
      execute: ({ reason, missingFactIds }, ctx) => { ctx.state.insufficient = reason; ctx.state.modelGaps = [{ code: "missing_inputs", message: reason, evidenceIds: [], field: missingFactIds.join(",") || undefined }]; ctx.state.calc = null; return "Recorded as insufficient; submit valuationSafety as null with the gap, then finish_assumptions."; }, observe: (_a, v) => v }),
    tool({ name: "submit_next_quarter_forecast", description: "Historical evaluation only: record independently researched next-quarter GAAP revenue/operating income/capex/CFO forecasts, or explicitly say the materials cannot support them. Do not divide an annual forecast by four. The period is fixed by the financial base, and no outcomes are available.", parameters: z.discriminatedUnion("status", [
      z.object({ status: z.literal("unavailable"), reason: z.string().min(20).max(800) }),
      z.object({ status: z.literal("available"), forecasts: z.array(z.object({ metric: z.enum(["revenue", "operating_income", "capex", "cfo"]), value: z.number().finite(), rationale: z.string().min(40).max(1200), evidenceIds: ids(10, 1) })).min(1).max(4) }),
    ]), execute: (args, ctx) => {
      if (!ctx.state.frozenSources) throw new Error("This tool belongs only to a frozen historical evaluation.");
      if (args.status === "unavailable") { ctx.state.nearTermForecast = args; return "The next-quarter forecast is explicitly unavailable."; }
      if (new Set(args.forecasts.map(f => f.metric)).size !== args.forecasts.length) throw new Error("Each forecast metric must be unique.");
      const errors = args.forecasts.flatMap(f => checkIds(ctx.state, f.evidenceIds, `forecast ${f.metric}`));
      if (errors.length) return `Not accepted: ${errors.join("; ")}`;
      const end = new Date(ctx.state.input.financialPeriodEnd + "T00:00:00Z");
      const periodStart = new Date(end.getTime() + 86_400_000).toISOString().slice(0, 10);
      const periodEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 4, 0)).toISOString().slice(0, 10);
      ctx.state.nearTermForecast = { status: "available", forecasts: args.forecasts.map(f => ({ ...f, periodStart, periodEnd, unit: "USD", basis: "gaap" })) };
      return `Next-quarter forecasts recorded for ${periodStart} to ${periodEnd}.`;
    }, observe: (_a, v) => v }),
    tool({ name: "finish_assumptions", description: "End the assumptions phase: a calculation (or a declared insufficiency) and the valuationSafety dimension are recorded.", parameters: z.object({}),
      execute: (_a, ctx) => {
        if (!ctx.state.calc && !ctx.state.insufficient) throw new Error("call calculate_valuation or declare_model_insufficient first");
        if (!ctx.state.dimensions.has("valuationSafety")) throw new Error("submit valuationSafety first");
        if (ctx.state.frozenSources && !ctx.state.nearTermForecast) throw new Error("submit_next_quarter_forecast first, or explicitly declare its unavailability");
        ctx.state.assumptionsDone = true; return "Assumptions recorded.";
      }, observe: (_a, v) => v }),
    tool({ name: "compose_valuation", description: "The written report: every figure must be one the calculator or a fact produced; cite evidence ids like [e1a2b3c4d5]. Every section is required: at least one catalyst, one counter-evidence item and one next check; model notes name each method's value and weight with the reason, each scenario's probability with the reason, the management scenario and the consensus (or why none). Keep each section within its limit: summary 1800, thesis 4000, expectations gap 3000 and model notes 3000 characters; list items 700 characters, at most 8 each.", parameters: z.object({
        summary: z.string().min(60).max(1800), thesis: z.string().min(80).max(4000), expectationsGap: z.string().min(40).max(3000), catalysts: z.array(z.string().max(700)).min(1).max(8), counterEvidence: z.array(z.string().max(700)).min(1).max(8), nextChecks: z.array(z.string().max(700)).min(1).max(8), modelNotes: z.string().min(120).max(3000),
        coreLogicFailed: z.boolean(), decisiveCounterEvidence: z.boolean(),
      }),
      execute: (args, ctx) => {
        const cited = [...`${args.summary} ${args.thesis} ${args.expectationsGap} ${args.catalysts.join(" ")} ${args.counterEvidence.join(" ")}`.matchAll(CITATION)].map(m => m[0]);
        const unknown = cited.filter(id => !ctx.state.evidence.has(id));
        if (unknown.length) return `Not accepted: unknown evidence ids ${[...new Set(unknown)].join(", ")}`;
        if (!cited.length) return "Not accepted: cite at least one registered evidence id, e.g. [e1a2b3c4d5].";
        ctx.state.composed = { sections: { summary: args.summary, thesis: args.thesis, expectationsGap: args.expectationsGap, catalysts: args.catalysts, counterEvidence: args.counterEvidence, nextChecks: args.nextChecks, modelNotes: args.modelNotes }, coreLogicFailed: args.coreLogicFailed, decisiveCounterEvidence: args.decisiveCounterEvidence };
        return "Composed. Call finish_valuation to publish.";
      }, observe: (_a, v) => v }),
    tool({ name: "finish_valuation", description: "Publish the composed report.", parameters: z.object({}),
      execute: (_a, ctx) => { if (!ctx.state.composed) throw new Error("compose_valuation first"); return "Published."; }, observe: (_a, v) => v }),
  ];
}

/** Management's cited targets as evidence the model may cite: one passage per source, listing the targets it supports. */
export async function registerManagementEvidence(state: ValuationState): Promise<string[]> {
  const set = state.input.management;
  if (!set) return [];
  const amount = (t: ManagementTarget) => t.unit === "ratio" ? pct(t.value) : t.unit === "per_share" ? t.value.toFixed(2) : money(t.value);
  const ids: string[] = [];
  for (const source of set.sources) {
    const targets = set.targets.filter(t => t.sourceIds.includes(source.id));
    if (!targets.length) continue;
    const text = `Management targets (${source.date}): ${targets.map(t => `${t.metric === "segment_revenue" ? `${t.segment} revenue` : t.metric.replace("_", " ")} FY${t.fiscalYear} ${t.kind === "floor" ? "at least " : t.kind === "ceiling" ? "at most " : ""}${amount(t)}${t.basis === "non_gaap" ? " (non-GAAP)" : ""}${t.kind === "derived" ? " (derived)" : ""}${t.note ? ` — ${t.note}` : ""}`).join("; ")}.`;
    ids.push(await registerEvidence(state, { passageId: `management:${source.id}`, documentId: `management:${state.input.ticker}`, title: source.title, form: "management", filedAt: source.date, url: source.url, path: ["management targets", source.date], text, table: null }, "web", source.date));
  }
  return ids;
}

export const RESEARCH_TOOLS = ["read_financials", "list_filings", "find_filing_sections", "read_filing_section", "read_guidance", "read_transcript", "search_evidence", "read_web_evidence", "submit_dimension", "finish_research"];
export const ASSUMPTION_TOOLS = ["read_financials", "read_guidance", "calculate_valuation", "declare_model_insufficient", "submit_dimension", "finish_assumptions"];
export const COMPOSE_TOOLS = ["compose_valuation", "finish_valuation"];

export const excerptOf = (e: ValuationEvidence) => e.excerpt.replace(/\s+/g, " ").slice(0, EXCERPT_CHARS);
