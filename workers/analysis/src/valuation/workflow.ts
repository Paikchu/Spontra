import type Anthropic from "@anthropic-ai/sdk";
import { modelFor, reasoningFor } from "../ai-config.ts";
import { runAgentLoop, sequential, type LoopHost, type Recipe, type TurnRecord } from "../agent-loop.ts";
import { AiRunStore, quietly } from "../ai-runs/store.ts";
import { sha256 } from "../sha256.ts";
import { requireDb } from "../core.ts";
import { featureTickersFor } from "../financial-data/company-policy.ts";
import { SecModelOutputError } from "../model-stream.ts";
import { callWorkerSecModel, callWorkerToolModel, type AnalysisEnv } from "../operations.ts";
import type { AgentMessage, AgentReply } from "../tool-loop.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { DIMENSION_WEIGHTS, VALUATION_DIMENSIONS, type ValuationAttempt, type ValuationDimension, type ValuationDimensionKey, type ValuationEvidence, type ValuationGap, type ValuationPublication } from "../../../../shared/analysis-contract/valuation.ts";
import { CALCULATOR_VERSION, calculateValuation, dimensionCeilings, multipleHistoryOf, overallConfidence, peerMultiplesOf, verdictOf, weightedScore, type CalcRequest } from "../../../../shared/analysis-runtime/valuation/calculator.ts";
import { priorRequest as priorOf } from "../../../../shared/analysis-runtime/valuation/prior.ts";
import { readValuationPublication } from "../../../../shared/analysis-runtime/valuation/read.ts";
import { buildValuationInput, type ValuationInput } from "./input.ts";
import { fetchBeta, fetchPeerQuotes, fetchReferenceQuote, fetchRiskFreeRate, fetchWeeklyCloses } from "./market.ts";
import { ValuationStore } from "./store.ts";
import { ASSUMPTION_TOOLS, CITATION, COMPOSE_TOOLS, RESEARCH_BUDGET, RESEARCH_TOOLS, excerptOf, factLine, impliedThreshold, valuationTools, type RedTeam, type ValuationState } from "./tools.ts";

/** Changing the prompts, the tools, the calculator or the publication contract reassesses every switched-on company once. */
export const VALUATION_VERSION = "valuation.v4";
export type ValuationWorkflowParams = { ticker: string; fingerprint: string };
const BUDGET = { research: { turns: 16, wallMs: 40 * 60_000 }, assume: { turns: 8, wallMs: 20 * 60_000 }, compose: { turns: 6, wallMs: 12 * 60_000 } };
const MODEL_BUDGET_MS = 5 * 60_000;

export function valuationTickersFor(env: Parameters<typeof featureTickersFor>[0]): string[] {
  return featureTickersFor(env, "valuation");
}

/** What a run would write from: the material pack's fingerprint under this method version, so a method change reassesses too. */
export const runFingerprint = (inputFingerprint: string) => sha256(JSON.stringify({ method: VALUATION_VERSION, calculator: CALCULATOR_VERSION, input: inputFingerprint }));

/** The state a run would write from now; null while the company has no complete statement. */
export async function valuationFingerprint(env: AnalysisEnv, ticker: string): Promise<string | null> {
  const input = await buildValuationInput(env, ticker, new Date().toISOString());
  return input ? runFingerprint(input.fingerprint) : null;
}

const pct = (v: number | null | undefined) => v == null ? "n/a" : `${(v * 100).toFixed(1)}%`;
const SCORING = `Score each dimension 0–10 in 0.5 steps against these anchors (2 / 4 / 6 / 8 / 10):
- businessQuality: customer value or model visibly impaired / product replaceable, weak pricing power / model works, customer value stable, edge ordinary / retention, switching costs or other edge shown across periods / edge verified across sources and cycles, every material counter-argument answered (rare).
- growthExecution: core demand and per-share economics deteriorating, plans failing / growth weak or bought by M&A, price or accounting / core growth and plans broadly delivered, cash conversion explainable / organic growth, profit, cash and operating metrics agree / delivery across periods with improving unit economics, sources verifiable (never from one high comparison alone).
- financialResilience: going-concern, refinancing or capital-structure risk proven / debt, refinancing or investment pressure, thin buffer / cash, debt and investment broadly matched, risks bounded / buffer survives stress, dilution and commitments transparent / cross-cycle strength, allocation and claims fully verified (never from net cash alone).
- mispricingCatalysts: permanent damage confirmed, thesis refuted / only a drawdown, a low multiple or a narrative / a plausible variant view with a trackable catalyst, little evidence of what the market prices / a verifiable gap between expectations (or the price-implied path) and the base case, measurable catalyst with a window / gap, degree unpriced and path all supported by independent evidence (an announced event is not "unpriced").
- valuationSafety (assumptions phase): no support under reasonable scenarios / base value lacks a cushion, depends on optimistic assumptions / price below a supported base value but stress scenarios still hurt / clear discount, key assumptions verifiable, support survives stress / several methods and stress tests agree (rare).
Confidence: high = every key fact first-hand, comparable across periods, contradictions explained; medium = facts grounded but forward assumptions or market pricing uncertain; low = an important source, basis or coverage gap is open.
Do not give 5 for uncertainty: say what is known, what is not, and score null with a gap when the material is missing.`;

export const RESEARCH_SYSTEM = `You research one listed company for a valuation assessment. Everything you conclude must rest on evidence you read in this run: filing passages, call excerpts or web pages registered with an id like [e1a2b3c4d5], or the validated facts listed by id. Search snippets are not evidence; only a read page is. Assumptions are never disclosures.
Work the four research dimensions: businessQuality, growthExecution, financialResilience, mispricingCatalysts. Read the business and risk-factor sections, the MD&A, the debt and commitments notes, the newest results release, and guidance. Treat counter-evidence first. Use the web only for a named gap (a guidance change, a launch date, an official statistic), at most ${RESEARCH_BUDGET.searches} searches and ${RESEARCH_BUDGET.webReads} page reads; the filings come first.
The diagnostics listed in the opening message were computed by code from the facts; each dimension's rationale must answer the ones that bear on it (ROIC, accruals, cash conversion, dilution, leverage, coverage) by name.
${SCORING}
Call submit_dimension for each of the four, then finish_research. Budget: ${RESEARCH_BUDGET.reads} filing reads, ${RESEARCH_BUDGET.finds} finds, ${RESEARCH_BUDGET.transcripts} call reads. Keep tool arguments small; never ask for a whole filing.`;

export const ASSUME_SYSTEM = `You set the valuation model's assumptions for one listed company and run the calculator; every figure comes from calculate_valuation. One discount rate for all three scenarios, from sourced components (risk-free, beta, equity risk premium with its source; cost of debt, tax rate, equity weight for WACC). Risk goes into the scenarios' cash flows, not into separate rates.
Model: asset-holding entity asset_nav, REIT affo, bank or insurer residual_income, any other operating company fcff with a driver path (revenue growth, operating margin including stock compensation, tax rate, sales-to-capital) over 5–10 years and a value-driver terminal (terminal growth at most 3% and below the risk-free rate; terminal ROIC at or above the discount rate unless you say why). Never choose a model for a higher value.
Build phase (capex far above depreciation, cash flow negative): use 7–10 years, put the capital spent ahead of revenue in buildCapex (it must end within the horizon), keep sales-to-capital for the reinvestment revenue growth needs, and give terminalOperatingMargin when the last year still carries build costs. Revenue must not fall under the contracted RPO floor the prior shows. Copy revenue0, shares and the bridge from the facts (debt + leases + preferred + minority as claims); the calculator checks them and rejects a mismatch.
Three scenarios: one coherent story each with narrative, triggers, invalidation and evidence ids; a faster bull case reinvests at least as much; margins above history need a reason. Probabilities only when justified (sum 1), else null for all. Dilution reserve: a treasury-stock estimate if the equity note was read, else 0 with the reason. If you read a sell-side consensus target, pass it as consensus with its evidence id; it is compared, never copied.
After the calculation read the cross-check, the gates and the market-implied growth; a failed gate means revise. Then submit valuationSafety (${SCORING.split("\n")[5]!.replace("- valuationSafety (assumptions phase): ", "anchors: ")}) and finish_assumptions. If the facts cannot support any model, declare_model_insufficient.`;

export const COMPOSE_SYSTEM = `You write the valuation report from the recorded research, the calculated model, its cross-check and gates, and the counter-evidence review. Use only figures from the facts or the calculation, exactly as given; cite evidence ids in brackets. Separate public facts, management guidance and research assumptions. The model notes name each method's value and every flagged gate; a base more than 50% from the consensus or the price needs a quantified expectations gap. Say plainly when the market-implied path already matches the base case. Next checks name the observable that would confirm or break each key assumption. Set coreLogicFailed only when the evidence shows the long-term thesis has failed; decisiveCounterEvidence when a counter-argument remains unanswered. Call compose_valuation, then finish_valuation.`;

const NUDGE = "Reply with a tool call; prose alone is not recorded.";

export function openingResearch(state: ValuationState): string {
  const { input } = state;
  const dist = input.distributions.map(d => `${d.factor}: min ${pct(d.min)} · p25 ${pct(d.p25)} · median ${pct(d.median)} · p75 ${pct(d.p75)} · max ${pct(d.max)} (${d.periods.length} years, latest ${d.periods.at(-1)?.periodEnd})`).join("\n");
  const diag = input.diagnostics.map(m => `${m.key}: ${m.value == null ? `n/a${m.note ? ` (${m.note})` : ""}` : m.unit === "percent" ? pct(m.value) : m.unit === "x" ? `${m.value.toFixed(2)}x` : m.unit === "years" ? `${m.value.toFixed(1)} years` : m.value.toFixed(2)} — ${m.label}`).join("\n");
  return [
    `Company: ${input.companyName} (${input.ticker}${input.cik ? `, CIK ${input.cik}` : ""}). Statements in ${input.currency}; newest complete quarter ${input.financialPeriodEnd}; income model ${input.incomeModel}. Research date ${state.researchAsOf.slice(0, 10)}.`,
    state.quote ? `Reference close ${state.quote.price} ${state.quote.currency} on ${state.quote.priceDate}${state.quote.usable ? "" : ` (not usable: ${state.quote.limitations.join("; ")})`}.` : "No reference quote.",
    `Facts (id | label | value | period | basis):\n${input.facts.map(factLine).join("\n")}`,
    input.missing.length ? `Missing required facts: ${input.missing.join(", ")}.` : "",
    `Company history by factor:\n${dist || "none"}`,
    `Diagnostics computed from the facts:\n${diag}`,
    `Readable filings: ${input.documents.length} (list_filings). Calls: ${input.transcripts.length ? input.transcripts.map(t => `${t.id} (${t.title}, FY${t.fiscalYear} Q${t.fiscalQuarter})`).join("; ") : "none"}. Guidance items: ${input.guidance?.items.length ?? 0} (read_guidance).`,
    "Start with find_filing_sections or list_filings.",
  ].filter(Boolean).join("\n\n");
}

/** The facts the models read, one line each; the research opening already carried the rest. */
const MODEL_FACTS = ["revenue_ttm", "operating_income_ttm", "net_income_ttm", "cfo_ttm", "capex_ttm", "da_ttm", "sbc_ttm", "interest_expense_ttm", "ebitda_ttm", "cash", "investments", "debt", "leases", "preferred_stock", "minority_interest", "equity", "net_debt", "invested_capital", "shares_diluted_weighted", "shares_outstanding", "operating_margin_ttm", "effective_tax_rate_ttm", "fcf_ttm", "rpo_total", "rpo_next_12m_share"];

export function openingAssume(state: ValuationState, prior: CalcRequest | null): string {
  const { input } = state;
  const dims = [...state.dimensions.values()].map(d => `${d.key}: ${d.score ?? "null"} (${d.confidence}) — ${d.rationale.slice(0, 300)}`).join("\n");
  const evidence = [...state.evidence.values()].slice(0, 24).map(e => `[${e.evidenceId}] ${e.title} › ${e.path ?? ""}: ${excerptOf(e).slice(0, 120)}`).join("\n");
  const rates = [
    state.riskFree ? `Risk-free (${state.riskFree.label}, ${state.riskFree.date}): ${pct(state.riskFree.value)}` : "Risk-free rate: none sourced for this currency; give one with a source or treat the rate as an assumption.",
    state.beta ? `Beta: ${state.beta.beta.toFixed(2)} from ${state.beta.observations} weekly returns ${state.beta.from} to ${state.beta.to} against ${state.beta.index}` : "Beta: not estimated (insufficient price history); use a sector beta and say where it comes from.",
  ].join("\n");
  const facts = input.facts.filter(f => MODEL_FACTS.includes(f.id)).map(factLine).join("\n");
  const dist = input.distributions.filter(d => ["revenueGrowth", "operatingMargin", "capexToRevenue", "fcfMargin"].includes(d.factor)).map(d => `${d.factor}: p25 ${pct(d.p25)} · median ${pct(d.median)} · p75 ${pct(d.p75)} (${d.periods.length} years)`).join("\n");
  const anchor = prior?.context?.anchor;
  const peers = state.peerMultiples ? `Peers (${input.peerBasis}: ${state.peerMultiples.peers.join(", ")}) trailing EV/EBITDA p25/median/p75 ${state.peerMultiples.evToEbitda ? `${state.peerMultiples.evToEbitda.p25.toFixed(1)}/${state.peerMultiples.evToEbitda.median.toFixed(1)}/${state.peerMultiples.evToEbitda.p75.toFixed(1)}` : "n/a"}; core P/E ${state.peerMultiples.peRatio ? `${state.peerMultiples.peRatio.p25.toFixed(1)}/${state.peerMultiples.peRatio.median.toFixed(1)}/${state.peerMultiples.peRatio.p75.toFixed(1)}` : "n/a"}.` : "Peers: no multiples available; the DCF stands alone.";
  const priorText = prior ? `Prior (${input.lifecycle} life cycle, ${prior.scenarios.base.drivers.modelType === "fcff" ? prior.scenarios.base.drivers.path.revenueGrowth.length : 5} years; revise, do not copy): ${JSON.stringify({ discountRate: Number(prior.discountRate.value.toFixed(4)), shares: prior.shares.base, bridge: { nonOperatingAssets: prior.bridge.nonOperatingAssets, debtAndClaims: prior.bridge.debtAndClaims }, base: prior.scenarios.base.drivers })}${anchor ? `\nRPO floor (contracted revenue by year, ${anchor.asOf}): ${anchor.floor.map(f => (f / 1e9).toFixed(1)).join(", ")}B = ${anchor.floorToRevenue0.map(v => pct(v)).join(", ")} of trailing revenue.${anchor.notes.length ? ` ${anchor.notes.join("; ")}` : ""}` : ""}` : "No prior could be computed from history.";
  return [
    `Company: ${input.companyName} (${input.ticker}); statements in ${input.currency} to ${input.financialPeriodEnd}; ${input.lifecycle} life cycle. ${state.quote ? `Reference close ${state.quote.price} ${state.quote.currency} on ${state.quote.priceDate}${state.quote.usable ? "" : " (not usable)"}.` : "No reference quote."}`,
    `Model facts (id | label | value | period | basis):\n${facts}`, `History:\n${dist || "none"}`, rates, peers, `Recorded dimensions:\n${dims}`, `Registered evidence:\n${evidence || "none"}`, priorText, "Call calculate_valuation.",
  ].join("\n\n");
}

export function openingCompose(state: ValuationState): string {
  const calc = state.calc?.result;
  // Rationales are cut to their first 800 characters: the composer cites evidence ids, not the research prose.
  const dims = [...state.dimensions.values()].map(d => `${d.key}: ${d.score ?? "null"} (${d.confidence})\n  ${d.rationale.slice(0, 800)}\n  supporting ${d.supportingEvidenceIds.join(", ") || "none"}; counter ${d.counterEvidenceIds.join(", ") || "none"}; gaps ${d.gaps.join(" | ") || "none"}; next check ${d.nextCheck.slice(0, 200)}`).join("\n");
  const model = calc ? [
    `Model ${calc.modelType}, r ${pct(calc.discountRate.value)} (${calc.discountRate.basis}), economic shares ${calc.shares.economic.toExponential(3)}.`,
    ...(["bear", "base", "bull"] as const).map(k => `${k}: ${calc.scenarios[k].result.perShare.toFixed(2)} per share; p=${calc.scenarios[k].probability ?? "n/a"}; ${calc.scenarios[k].narrative}`),
    `Range ${calc.range.low.toFixed(2)}–${calc.range.high.toFixed(2)}, base ${calc.range.base.toFixed(2)}, expected ${calc.range.expected?.toFixed(2) ?? "n/a"}, price ${calc.range.price ?? "n/a"}, margin of safety ${pct(calc.range.marginOfSafety)}, downside coverage ${pct(calc.range.downsideCoverage)}, expected upside ${pct(calc.range.expectedUpside)}.`,
    calc.implied ? `Market-implied constant revenue growth ${pct(calc.implied.implied)} vs base average ${pct(calc.implied.baseAverage)} (gap ${pct(calc.implied.gap)}).` : "",
    calc.methods?.length ? `Methods: ${calc.methods.map(m => `${m.label} ${m.base != null ? `${m.low!.toFixed(2)} / ${m.base.toFixed(2)} / ${m.high!.toFixed(2)} (weight ${(m.weight * 100).toFixed(0)}%)` : "not applied"}`).join("; ")}${calc.triangulation ? `; weighted ${calc.triangulation.low.toFixed(2)}–${calc.triangulation.high.toFixed(2)}, base ${calc.triangulation.base.toFixed(2)}` : ""}.` : "",
    calc.gates?.length ? `Gates: ${calc.gates.map(g => `${g.key} ${g.status}${g.status === "pass" ? "" : ` (${g.detail})`}`).join("; ")}.` : "",
    `Sensitivities: ${calc.sensitivities.slice(0, 5).map(s => `${s.factor} ${s.step} ${s.changePercent >= 0 ? "+" : ""}${s.changePercent.toFixed(1)}%`).join("; ")}.`,
    `Limitations: ${calc.limitations.join(" ")}`,
  ].filter(Boolean).join("\n") : `No model: ${state.insufficient ?? "not computed"}.`;
  const red = state.redTeam ? `Counter-evidence review:\n${state.redTeam.weakestAssumptions.map(w => `- ${w.factor}: ${w.why} (${w.evidenceIds.join(", ") || "no evidence"})`).join("\n")}\ndecisive counter-evidence: ${state.redTeam.decisiveCounterEvidence}` : "";
  const evidence = [...state.evidence.values()].map(e => `[${e.evidenceId}] ${e.title}${e.path ? ` › ${e.path}` : ""}`).join("\n");
  const gaps = [...state.modelGaps, ...[...state.dimensions.values()].flatMap(d => d.gaps.map(g => ({ code: "missing_inputs", message: `${d.key}: ${g}` })))].map(g => `${g.code}: ${g.message}`).join("\n");
  return [`Company: ${state.input.companyName} (${state.input.ticker}), research date ${state.researchAsOf.slice(0, 10)}, statements to ${state.input.financialPeriodEnd}.`, `Dimensions:\n${dims}`, model, red, `Evidence ids:\n${evidence}`, gaps ? `Gaps:\n${gaps}` : "", "Call compose_valuation."].filter(Boolean).join("\n\n");
}

/** A first pass from the company's own history, RPO and capex cycle, with no model involved (shared/analysis-runtime/valuation/prior.ts). */
export function priorRequest(state: ValuationState): CalcRequest | null {
  const { input } = state;
  const rpo = input.rpo ? { asOf: input.rpo.asOf, total: Number(input.rpo.total), buckets: input.rpo.buckets.map(b => ({ start: b.start, months: b.months, share: b.share == null ? null : Number(b.share) })) } : null;
  const prior = priorOf({ currency: input.currency, facts: input.facts.map(f => ({ id: f.id, value: f.value, unit: f.unit })), distributions: input.distributions, diagnostics: input.diagnostics, rpo, riskFree: state.riskFree?.value ?? null, beta: state.beta?.beta ?? null, price: state.quote?.usable ? state.quote.price : null });
  if (!prior) return null;
  const fact = (id: string) => input.facts.find(f => f.id === id)?.value ?? null;
  return { ...prior, context: { ...prior.context, peers: state.peerMultiples, multipleHistory: state.multipleHistory, trailing: { ebitda: fact("ebitda_ttm"), da: fact("da_ttm"), interestExpense: fact("interest_expense_ttm") } } };
}

type Loop = { recipeId: string; system: string; allow: string[]; budget: { turns: number; wallMs: number }; settled: (s: ValuationState) => boolean; tool: "valuation-research" | "valuation" };

async function runLoop(env: AnalysisEnv, step: WorkflowStepLike, state: ValuationState, loop: Loop, opening: string, generation: number, fetcher: typeof fetch, turns: TurnRecord[], runId?: string): Promise<"finished" | "budget" | "failed" | "cancelled"> {
  const tools = valuationTools(env);
  const recipe: Recipe<string, ValuationState, ValuationState> = {
    id: loop.recipeId, budget: loop.budget, system: () => loop.system, open: () => state, tools: () => tools, policy: { allow: loop.allow }, settled: loop.settled, settle: s => s, nudge: NUDGE,
  };
  const modelVersion = modelFor(env, loop.tool), reasoning = reasoningFor(env, loop.tool);
  const act = (stage: string, system: string, toolSchemas: unknown[], messages: AgentMessage[]): Promise<AgentReply> => step.do(`${stage}-act`, async () => {
    try { return await callWorkerToolModel(env, fetcher, stage, { system, tools: toolSchemas as Anthropic.Beta.BetaTool[], messages: messages as Anthropic.Beta.BetaMessageParam[] }, modelVersion, MODEL_BUDGET_MS, { reasoning, ticker: state.input.ticker, runId, kind: loop.tool }); }
    catch (error) { if (error instanceof SecModelOutputError) return { error: `${error.code}: ${error.message}`.slice(0, 300) }; throw error; }
  });
  const store = new ValuationStore(requireDb(env));
  const host: LoopHost<ValuationState> = {
    // Switched off or re-requested while the run was working: the loop ends before its next model call.
    reserve: async () => { const ok = await stillEligible(env, state.input.ticker, store, generation); if (!ok) state.cancelled = true; return ok; },
    record: turn => { turns.push(turn); }, execute: (_t, calls, run) => sequential(calls, run),
    stage: (name, work) => step.do(name, work), signal: new AbortController().signal, now: () => Date.now(),
  };
  const outcome = await runAgentLoop(recipe, "", state, [{ role: "user", content: opening }], act, host);
  if (state.cancelled) return "cancelled";
  return outcome.reason === "interrupted" ? "failed" : outcome.reason;
}

async function stillEligible(env: AnalysisEnv, ticker: string, store: ValuationStore, generation: number): Promise<boolean> {
  const db = requireDb(env);
  const row = await db.prepare("SELECT generate FROM business_feature_settings WHERE ticker = ? AND feature = 'valuation'").bind(ticker).first<{ generate: number | null }>().catch(() => null);
  if (row && row.generate === 0) return false;
  const global = await db.prepare("SELECT generate FROM business_feature_settings WHERE ticker = '*' AND feature = 'valuation'").bind().first<{ generate: number | null }>().catch(() => null);
  if (global && global.generate === 0) return false;
  return (await store.current(ticker))?.request_generation === generation;
}

async function redTeam(env: AnalysisEnv, step: WorkflowStepLike, state: ValuationState, fetcher: typeof fetch, runId?: string): Promise<RedTeam | null> {
  const calc = state.calc;
  if (!calc) return null;
  const payload = {
    company: state.input.companyName, base: { narrative: calc.request.scenarios.base.narrative, drivers: calc.request.scenarios.base.drivers, perShare: calc.result.range.base, price: calc.result.range.price },
    implied: calc.result.implied, sensitivities: calc.result.sensitivities.slice(0, 4),
    dimensions: [...state.dimensions.values()].map(d => ({ key: d.key, score: d.score, rationale: d.rationale.slice(0, 500) })),
    evidence: [...state.evidence.values()].map(e => ({ id: e.evidenceId, title: e.title, excerpt: excerptOf(e).slice(0, 250) })),
  };
  const system = `You are the counter-evidence reviewer of a valuation. From the base case, the price-implied path and the registered evidence only, name the two assumptions most likely to be wrong and what in the evidence argues against them. Reply as JSON: {"weakestAssumptions":[{"factor":"...","why":"...","evidenceIds":["e..."]}],"decisiveCounterEvidence":false,"counterEvidenceIds":["e..."]}. decisiveCounterEvidence is true only when a registered passage contradicts the long-term thesis and nothing in the rationales answers it. Cite only ids from the evidence list.`;
  const reply = await step.do("valuation-redteam", async () => {
    try { return await callWorkerSecModel(env, fetcher, "valuation-redteam", system, payload, modelFor(env, "valuation"), MODEL_BUDGET_MS, true, { reasoning: reasoningFor(env, "valuation"), ticker: state.input.ticker, runId, kind: "valuation" }); }
    catch (error) { if (error instanceof SecModelOutputError) return null; throw error; }
  });
  if (!reply) return null;
  const known = (ids: unknown) => Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && state.evidence.has(id)) : [];
  const weakest = Array.isArray(reply.weakestAssumptions) ? reply.weakestAssumptions.slice(0, 3).flatMap(w => typeof w === "object" && w && typeof (w as Record<string, unknown>).factor === "string" ? [{ factor: String((w as Record<string, unknown>).factor).slice(0, 80), why: String((w as Record<string, unknown>).why ?? "").slice(0, 400), evidenceIds: known((w as Record<string, unknown>).evidenceIds) }] : []) : [];
  return { weakestAssumptions: weakest, decisiveCounterEvidence: reply.decisiveCounterEvidence === true && known(reply.counterEvidenceIds).length > 0, counterEvidenceIds: known(reply.counterEvidenceIds) };
}

/** The publication from the run's state: ceilings applied, scores composed, the verdict decided, every figure the calculator's. */
export async function assemblePublication(state: ValuationState, now: string, methodVersion: string): Promise<{ publication: ValuationPublication; evidence: ValuationEvidence[] }> {
  const calc = state.calc?.result ?? null;
  const gaps: ValuationGap[] = [...state.modelGaps];
  if (!state.quote) gaps.push({ code: "missing_quote", message: "No reference close could be read, so no price comparison is made.", evidenceIds: [] });
  else if (!state.quote.usable) gaps.push({ code: "stale_quote", message: state.quote.limitations.join(" "), evidenceIds: [] });
  for (const id of state.input.missing) gaps.push({ code: "missing_inputs", field: id, message: `${id} could not be resolved from the validated statements.`, evidenceIds: [] });
  const ceilings = dimensionCeilings({ marginOfSafety: calc?.range.marginOfSafety ?? null, downsideCoverage: calc?.range.downsideCoverage ?? null, bearProbability: calc?.scenarios.bear.probability ?? null, terminalShare: calc?.scenarios.base.result.terminalShare ?? null,
    hasIndependentConsensus: !!calc?.consensus, impliedGap: calc?.implied?.converged ? calc.implied.gap : null, impliedGapThreshold: impliedThreshold(state), goingConcernUnresolved: false });
  const dimensions: ValuationDimension[] = VALUATION_DIMENSIONS.map(key => {
    const d = state.dimensions.get(key) ?? { key, score: null, confidence: "low" as const, rationale: "Not assessed: the research phase ended before this dimension was recorded.", supportingEvidenceIds: [], counterEvidenceIds: [], gaps: ["not assessed"], nextCheck: "Re-run the assessment." };
    const ceiling = ceilings[key];
    const score = d.score != null && ceiling != null && d.score > ceiling ? ceiling : d.score;
    const red = state.redTeam?.counterEvidenceIds.filter(id => !d.counterEvidenceIds.includes(id)) ?? [];
    return { ...d, score, counterEvidenceIds: key === "mispricingCatalysts" ? [...d.counterEvidenceIds, ...red] : d.counterEvidenceIds, gaps: score !== d.score ? [...d.gaps, `score capped at ${ceiling} by the calculated figures`] : d.gaps };
  });
  if (!calc && !dimensions.find(d => d.key === "valuationSafety")!.gaps.length) gaps.push({ code: "unsupported_model", message: state.insufficient ?? "No model was computed.", evidenceIds: [] });
  const score = weightedScore(dimensions), confidence = overallConfidence(dimensions);
  const verdict = verdictOf({ dimensions, marginOfSafety: calc?.range.marginOfSafety ?? null, hasModel: !!calc && calc.range.price != null, decisiveCounterEvidence: !!state.composed?.decisiveCounterEvidence || !!state.redTeam?.decisiveCounterEvidence, coreLogicFailed: !!state.composed?.coreLogicFailed });
  // A report is complete only once it has been written: scored dimensions and a model without the case stay insufficient.
  if (!state.composed) gaps.push({ code: "research_budget_exhausted", message: "The written report was not completed within the composition budget; the scores, model and evidence stand on their own.", evidenceIds: [] });
  const reportStatus = score != null && calc && state.quote?.usable && state.composed ? "ready" : "insufficient";
  const sections = state.composed?.sections ?? { summary: "", thesis: "", expectationsGap: "", catalysts: [], counterEvidence: [], nextChecks: [], modelNotes: "" };
  const cited = new Set<string>([...dimensions.flatMap(d => [...d.supportingEvidenceIds, ...d.counterEvidenceIds]), ...(calc ? (["bear", "base", "bull"] as const).flatMap(k => calc.scenarios[k].evidenceIds) : []), ...[...`${sections.summary} ${sections.thesis} ${sections.expectationsGap} ${sections.catalysts.join(" ")} ${sections.counterEvidence.join(" ")}`.matchAll(CITATION)].map(m => m[0])]);
  const evidence = [...state.evidence.values()].filter(e => cited.has(e.evidenceId)).sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  const evidenceSetHash = await sha256(JSON.stringify(evidence.map(e => [e.evidenceId, e.contentSha256])));
  const body: Omit<ValuationPublication, "versionId" | "generatedAt"> = {
    schemaVersion: "valuation.v1", ticker: state.input.ticker, cik: state.input.cik, companyName: state.input.companyName, currency: state.input.currency,
    researchAsOf: state.researchAsOf, financialPeriodEnd: state.input.financialPeriodEnd, methodVersion, calculatorVersion: CALCULATOR_VERSION,
    baseInputFingerprint: state.input.fingerprint, evidenceSetHash, reportStatus, verdict, weightedScore: score, confidence, dimensions, quote: state.quote, model: calc,
    facts: state.input.facts, diagnostics: state.input.diagnostics, distributions: state.input.distributions, sections, evidence, gaps,
  };
  const versionId = (await sha256(JSON.stringify(body))).slice(0, 32);
  return { publication: { ...body, generatedAt: now, versionId }, evidence };
}

export async function executeValuationWorkflow(params: ValuationWorkflowParams, step: WorkflowStepLike, env: AnalysisEnv, fetcher: typeof fetch = fetch, runId?: string) {
  if (!valuationTickersFor(env).includes(params.ticker) || env.VALUATION_ENABLED === "false") return { status: "superseded" as const };
  const db = requireDb(env);
  const store = new ValuationStore(db);
  const now = await step.do("valuation-time", async () => new Date().toISOString());
  const generation = await step.do("valuation-start", async () => {
    const g = await store.advance(params.ticker, now);
    await store.noteAttempt(params.ticker, { runId: runId ?? "", status: "running", stage: "input", updatedAt: now, reportStatus: null, gaps: [], errorCode: null }, now);
    return g;
  });
  const input = await step.do("valuation-input", () => buildValuationInput(env, params.ticker, now));
  if (!input || await runFingerprint(input.fingerprint) !== params.fingerprint) return { status: "superseded" as const };
  const market = await step.do("valuation-quote", async () => {
    const at = new Date(now);
    const [quote, riskFree, beta, closes, peerQuotes] = await Promise.all([fetchReferenceQuote(params.ticker, input.currency, fetcher, at), fetchRiskFreeRate(input.currency, fetcher, at), fetchBeta(params.ticker, input.currency, fetcher, at),
      fetchWeeklyCloses(params.ticker, fetcher, at), fetchPeerQuotes(input.peers.map(p => p.ticker), input.currency, fetcher, at)]);
    // The peers' multiples at their closes and the company's own two-year EV/EBITDA range, both frozen with the quote.
    const peerMultiples = peerMultiplesOf(input.peers.map(p => ({ ...p, price: peerQuotes[p.ticker]?.usable ? peerQuotes[p.ticker]!.price : null })), now.slice(0, 10));
    const shares = input.facts.find(f => f.id === "shares_outstanding")?.value ?? input.facts.find(f => f.id === "shares_diluted_weighted")?.value ?? null;
    const multipleHistory = closes && shares ? multipleHistoryOf(closes, shares, input.trailingQuarters) : null;
    return { quote, riskFree, beta, peerMultiples, multipleHistory };
  });
  const state: ValuationState = { input, researchAsOf: now, now, quote: market.quote, riskFree: market.riskFree, beta: market.beta, peerMultiples: market.peerMultiples, multipleHistory: market.multipleHistory, evidence: new Map(), hits: [], used: { finds: 0, reads: 0, searches: 0, webReads: 0, transcripts: 0 },
    dimensions: new Map(), researchDone: false, calc: null, modelGaps: [], insufficient: null, assumptionsDone: false, redTeam: null, composed: null, cancelled: false };
  const prior = await step.do("valuation-prior", async () => {
    const request = priorRequest(state);
    if (!request) return null;
    try { return { request, result: calculateValuation(request) }; } catch { return null; }
  });
  const turns: TurnRecord[] = [];
  const research = await runLoop(env, step, state, { recipeId: "valuation-research", system: RESEARCH_SYSTEM, allow: RESEARCH_TOOLS, budget: BUDGET.research, settled: s => s.researchDone, tool: "valuation-research" }, openingResearch(state), generation, fetcher, turns, runId);
  if (research === "cancelled") return { status: "superseded" as const };
  if (research === "failed") throw new Error("The research loop produced no usable replies.");
  const assume = await runLoop(env, step, state, { recipeId: "valuation-assume", system: ASSUME_SYSTEM, allow: ASSUMPTION_TOOLS, budget: BUDGET.assume, settled: s => s.assumptionsDone, tool: "valuation" }, openingAssume(state, prior?.request ?? null), generation, fetcher, turns, runId);
  if (assume === "cancelled") return { status: "superseded" as const };
  state.redTeam = await redTeam(env, step, state, fetcher, runId);
  const compose = await runLoop(env, step, state, { recipeId: "valuation-compose", system: COMPOSE_SYSTEM, allow: COMPOSE_TOOLS, budget: BUDGET.compose, settled: s => !!s.composed, tool: "valuation" }, openingCompose(state), generation, fetcher, turns, runId);
  if (compose === "cancelled") return { status: "superseded" as const };
  const { publication, evidence } = await assemblePublication(state, now, VALUATION_VERSION);
  if (!readValuationPublication(publication, params.ticker)) throw new Error("The valuation failed its public contract.");
  const published = await step.do("valuation-publish", async () => {
    // The input moved on while the run worked: this result is not for the current material; the next sweep runs again.
    const fresh = await buildValuationInput(env, params.ticker, now);
    if (!fresh || await runFingerprint(fresh.fingerprint) !== params.fingerprint) return { current: false, stored: false, reason: "input changed" };
    const outcome = await store.publish(params.ticker, publication, evidence, generation, params.fingerprint, publication.generatedAt);
    const attempt: ValuationAttempt = { runId: runId ?? "", status: outcome.current ? "succeeded" : "superseded", stage: "publish", updatedAt: publication.generatedAt, reportStatus: publication.reportStatus, gaps: publication.gaps, errorCode: null };
    await store.noteAttempt(params.ticker, attempt, publication.generatedAt);
    if (outcome.current) await quietly(() => new AiRunStore(db).saveVersion("valuation", params.ticker, { ...publication, trace: turns.slice(-80) }, publication.generatedAt));
    return { ...outcome, reason: outcome.current ? "published" : "generation moved on" };
  });
  if (!published.current) return { status: "superseded" as const, reason: published.reason };
  return { status: publication.reportStatus === "ready" ? "ready" as const : "empty" as const, reportStatus: publication.reportStatus, verdict: publication.verdict, score: publication.weightedScore, evidence: evidence.length, turns: turns.length, versionId: publication.versionId };
}
