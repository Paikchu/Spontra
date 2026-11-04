import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
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
import { EXTENDED_SCENARIO_KEYS, VALUATION_DIMENSIONS, VALUATION_METHODS, type ValuationAttempt, type ValuationDimension, type ValuationEvidence, type ValuationGap, type ValuationModelResult, type ValuationPublication } from "../../../../shared/analysis-contract/valuation.ts";
import { CALCULATOR_VERSION, calculateValuation, dimensionCeilings, multipleHistoryOf, overallConfidence, peerMultiplesOf, verdictOf, weightedScore, type CalcRequest } from "../../../../shared/analysis-runtime/valuation/calculator.ts";
import { horizonFor, priorRequest as priorOf } from "../../../../shared/analysis-runtime/valuation/prior.ts";
import { managementCapexShape, managementFactsOf } from "../../../../shared/analysis-runtime/valuation/management.ts";
import { readValuationPublication } from "../../../../shared/analysis-runtime/valuation/read.ts";
import { buildValuationInput, type ValuationInput } from "./input.ts";
import { fetchBeta, fetchPeerQuotes, fetchReferenceQuote, fetchRiskFreeRate, fetchWeeklyCloses } from "./market.ts";
import { ValuationStore } from "./store.ts";
import { ASSUMPTION_TOOLS, CITATION, COMPOSE_TOOLS, RESEARCH_BUDGET, RESEARCH_TOOLS, VALUATION_CASE_TOOLS, excerptOf, factLine, goingConcernOf, impliedThreshold, registerManagementEvidence, valuationTools, type RedTeam, type ValuationState, type FrozenResearchSource, type ValuationCaseKey } from "./tools.ts";

/** Changing the prompts, the tools, the calculator or the publication contract reassesses every switched-on company once. */
export const VALUATION_VERSION = "valuation.v10";
export type ValuationWorkflowParams = { ticker: string; fingerprint: string };
const BUDGET = { research: { turns: 24, wallMs: 40 * 60_000 }, researchFinalize: { turns: 8, wallMs: 12 * 60_000 }, configure: { turns: 4, wallMs: 10 * 60_000 }, valuationCase: { turns: 4, wallMs: 10 * 60_000 }, assume: { turns: 12, wallMs: 20 * 60_000 }, compose: { turns: 6, wallMs: 12 * 60_000 } };
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

export const RESEARCH_SYSTEM = `You research one listed company for a valuation assessment. Everything you conclude must rest on evidence you read in this run: filing passages (a filing analysis's quoted passages included), call excerpts or the business breakdown's anchoring pages, registered with an id like [e1a2b3c4d5], or the validated facts listed by id. A finding or an analysis's conclusion is not evidence; only a registered passage is. Assumptions are never disclosures.
Work the four research dimensions: businessQuality, growthExecution, financialResilience, mispricingCatalysts. Build on the analysis already done below you: read_findings for what the financial review concluded, read_business_tree for the businesses and the researched pages anchoring them, read_filing_analyses and read_filing_analysis for each filing's analysis and the passages it quoted. Read a filing section yourself (find_filing_sections, read_filing_section) only for a disclosure none of them carries: the debt and commitments notes, share counts, leases. Read guidance and the calls. Treat counter-evidence first. There is no web search here; a gap the layers below do not cover is recorded as a gap.
The diagnostics listed in the opening message were computed by code from the facts; each dimension's rationale must answer the ones that bear on it (ROIC, accruals, cash conversion, dilution, leverage, coverage) by name.
When submitting financialResilience, assess goingConcern from the current disclosures: unresolved means substantial doubt remains; resolved requires explicit evidence that completed mitigation alleviates it; unknown means the evidence does not establish either. Quote the registered passage and explain the assessment in the dimension rationale. Planned refinancing alone does not resolve risk; a generic risk-factor mention or a missing document alone does not establish it. Reconcile older warnings with newer disclosures. An unresolved assessment limits financialResilience to 7.5.
${SCORING}
The web (web_search, then read_web_evidence) is only for what the layers below do not carry: a market event after the newest filing, an untracked peer's own disclosure, industry context; the findings, business breakdown and filing analyses come first, and a snippet is never evidence. Call submit_dimension for each of the four, then finish_research. Budget: ${RESEARCH_BUDGET.reads} filing reads, ${RESEARCH_BUDGET.finds} finds, ${RESEARCH_BUDGET.transcripts} call reads, ${RESEARCH_BUDGET.searches} searches, ${RESEARCH_BUDGET.webReads} web reads. Keep tool arguments small; never ask for a whole filing.`;

const FINALIZE_RESEARCH_SYSTEM = `Finish the recorded research conclusions using only the validated financial facts and evidence excerpts already registered in this run. Evidence collection is closed: no new sources, network reads or later information are available. Complete the missing businessQuality, growthExecution, financialResilience and mispricingCatalysts dimensions, then call finish_research. Retain the already accepted dimensions unless a registered passage requires a correction. A missing basis requires a null score and a concrete gap; do not invent evidence or assign a default score to finish.
Use read_valuation_evidence to reread exact passages before quoting them. financialResilience requires goingConcern: unresolved for current substantial doubt not alleviated by completed mitigation, resolved only with explicit evidence of completed mitigation, unknown when the available evidence does not establish either. Cite its evidence IDs in the dimension, copy quotes verbatim and keep the goingConcern rationale within 800 characters. Unresolved risk caps financialResilience at 7.5. Answer the supplied financial diagnostics in the relevant rationales.
${SCORING}`;

function openingResearchFinalization(state: ValuationState): string {
  const keys = VALUATION_DIMENSIONS.filter(key => key !== "valuationSafety");
  return [
    `Company ${state.input.ticker}; information cutoff ${state.researchAsOf}. Evidence collection reached its budget; only recording conclusions remains.`,
    `Missing dimensions: ${keys.filter(key => !state.dimensions.has(key)).join(", ") || "none; finish_research is still required"}.`,
    `Accepted dimensions: ${JSON.stringify([...state.dimensions.values()])}`,
    `Recorded going-concern assessment: ${JSON.stringify(state.goingConcern ?? null)}`,
    `Financial diagnostics: ${JSON.stringify(state.input.diagnostics)}`,
    `Registered evidence directory (read_valuation_evidence returns full excerpts):\n${[...state.evidence.values()].map(e => `[${e.evidenceId}] ${e.title}: ${excerptOf(e)}`).join("\n")}`,
    "Submit the missing dimensions, explicitly recording null and the evidence gap where necessary, then finish_research. Do not set valuationSafety in this phase.",
  ].join("\n\n");
}

export const ASSUME_SYSTEM = `You set the valuation model's assumptions for one listed company. Submit common parameters with configure_valuation, then submit each complete operating path through its own set_*_case tool. calculate_prepared_valuation takes no arguments and computes the assembled model using fixed code. Every required field still needs a value and its rationale; nothing is defaulted or copied into a missing case. Submit only the part requested in this stage, with concise one- or two-sentence rationales; do not try to emit all five paths in a single reply or mentally calculate their values. One discount rate for all scenarios, each component (risk-free, beta, equity risk premium; cost of debt, tax rate, equity weight for WACC) with its value, its named source and evidence or fact ids. Risk goes into the scenarios' cash flows, not into separate rates.
All money and share-count inputs use full base units, never billions or millions: copy the exact values shown by read_financials (for example 64076000000 USD, not 64.076). Rates are decimals. Use read_valuation_evidence to reread registered e... excerpts; read_financials accepts fact ids only.
Use the same capital-cost components across all scenarios. The fixed calculator discounts FCFF and enterprise-value references at WACC, and a forward P/E equity-price reference at the cost of equity derived from those same components; these value different capital claims. Do not invent a separate rate for a more optimistic scenario.
Model: asset-holding entity asset_nav, REIT affo, bank or insurer residual_income, any other operating company fcff with a driver path (revenue growth, operating margin including stock compensation, tax rate, sales-to-capital) over 5–10 years and a value-driver terminal (terminal growth at most 3% and below the risk-free rate; terminal ROIC at or above the discount rate unless you say why). Never choose a model for a higher value.
Build phase (capex far above depreciation, cash flow negative): use 7–10 years and prefer explicit capitalPlan arrays so construction, depreciation and working-capital needs need not coincide with revenue growth. In explicit mode omit salesToCapital/buildCapex: FCFF is NOPAT + depreciation − capex − workingCapitalChange; maintenance capex does not vanish in the final year. If only an implicit plan is supported, use salesToCapital with buildCapex for investments ahead of revenue (that extra build must end within the horizon). Explain the transition into terminal growth/ROIC and give terminalOperatingMargin only with a normalization basis. Compare the base path with the disclosed RPO schedule and explain departures; a schedule is not guaranteed cash, and a stress case may include delayed or cancelled conversion. Never lift a forecast solely to match an anchor. Copy revenue0, shares and the bridge from the facts (debt + finance leases + preferred + minority as claims under operating_expense treatment); the calculator checks them and rejects a mismatch.
Three researched scenarios (bear, base, bull): one coherent story each with narrative, triggers, invalidation, evidence ids and, under assumptions, why the revenue, margin and capex paths run as they do, each with evidence; a faster bull case reinvests at least as much; margins above history need a reason.
Normal fair-value bounds: fairValueBasis is required in configure_valuation. When the evidence supports a normal operating range, give {status: "available", kind: "normal_cases", rationale, evidenceIds}; submit the full lower and upper paths separately with set_lower_case and set_upper_case. Lower and upper are complete independently researched operating paths with the same fields as a scenario, and the existing base is their central case. Explain what ordinary demand, execution, margin and capital-spending uncertainty sets each bound. They share the base model, horizon, discount rate, bridge, shares and method weights; do not include probabilities. Do not rename bear/bull, copy their endpoints, take a fixed percentage around the base or price, or use management's plan or a 12-month analyst target as an automatic bound. Price is compared only after the values are calculated. If the evidence cannot establish normal bounds, use {status: "unavailable", reason, evidenceIds} and name the missing basis. A positive-weight method must apply on all normal paths; revise shared weights with evidence or declare the normal range unavailable.
Methods and weights. The calculator values each scenario three ways and weighs them as you judge: dcf discounts the company's own projected cash flows and is sensitive to the terminal value and to build capex; ev_ebitda_forward and pe_forward apply the peers' trailing multiples to the path's year-N EBITDA and core EPS, so they carry how the market prices comparable growth and returns after the forecast and check the terminal value. Judge methodWeights from the business, its life-cycle stage, a capex or build phase, backlog and RPO, the margin path and the industry outlook, with a rationale citing evidence for each; the three must sum to 1; there are no bounds and no default, and a method you leave at 0 while it is usable is flagged for its rationale. A method the calculator cannot apply (no peers, EBITDA or EPS not positive, an equity-level model) still needs a weight (0) with the reason.
Scenario probabilities. Give scenarioProbabilities for bear, base, management and bull, each with a rationale and evidence, summing to 1. When the opening lists management targets, the calculator builds the management scenario from them by code (the cited revenue, margin, capex and cash-flow targets on your rate, shares, bridge, horizon, tax and sales-to-capital) and its probability must cite those target evidence ids: judge from delivery to date, backlog cover and the capital needed how likely management's own plan is. Without a target set, management is 0 with the rationale "no target set". The expected value is the probability-weighted value over the four; the central case stays your researched base.
Management comparison: when targets exist, managementComparison explains the gap between your base path and them (the figures are computed; a discount to management is normal, the explanation says why); otherwise null. Consensus: a sell-side consensus target you read on a registered page goes in as consensus {status: "cited", …, source}; otherwise {status: "unavailable", reason} says why none could be cited. It is compared and flagged, never copied. Dilution reserve: a treasury-stock estimate if the equity note was read, else 0 with the reason. midYear and forwardYears (the year the multiples apply to, usually 3) are yours to set.
After calculate_prepared_valuation read each scenario's DCF and weighted value, the expected value, the cross-check, the gates and the market-implied growth; a failed gate means revise only the affected part and calculate again. Any accepted change invalidates the previous calculation, valuationSafety and next-quarter forecast, so confirm them again after the final calculation. Then submit valuationSafety (${SCORING.split("\n")[5]!.replace("- valuationSafety (assumptions phase): ", "anchors: ")}) and finish_assumptions. If the facts cannot support any model, declare_model_insufficient.`;

export const COMPOSE_SYSTEM = `You write the valuation report from the recorded research, the calculated model, its cross-check and gates, and the counter-evidence review. Use only figures from the facts or the calculation, exactly as given; negative modelled equity is a shortfall after senior claims, not a tradable negative share price, and a non-positive normal band cannot support a price-position conclusion; cite evidence ids in brackets. Separate public facts, management guidance and research assumptions. Lead with the normal fair-value range and the reference close's position below, within or above it, with the quote date and the assumptions defining the bounds. This is a current-value estimate, not a 12-month price target, a confidence interval or a judgement derived from the research score. If fairValueRange is unavailable, say the price position cannot be established and name the gap; never substitute the bear/bull range or the football field. The base remains the central case; bear/bull stress outcomes, the probability-weighted expected value and management's plan are separate context. The model notes name each method's value and weight with the reason it was weighted so, each scenario's probability with its reason, the management scenario (when present) with the base's discount to management's targets and the explanation, the consensus or why none could be cited, and every flagged gate; a base more than 50% from the consensus or the price needs a quantified expectations gap. Say plainly when the market-implied path already matches the base case. Next checks name the observable that would confirm or break each key assumption. Set coreLogicFailed only when the evidence shows the long-term thesis has failed; decisiveCounterEvidence when a counter-argument remains unanswered. Call compose_valuation, then finish_valuation.`;

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
    state.frozenSources ? `Frozen original documents: ${state.frozenSources.length}; use list_snapshot_sources to choose the documents and read_snapshot_source to register evidence.` : `Readable filings: ${input.documents.length} (list_filings). Calls: ${input.transcripts.length ? input.transcripts.map(t => `${t.id} (${t.title}, FY${t.fiscalYear} Q${t.fiscalQuarter})`).join("; ") : "none"}. Guidance items: ${input.guidance?.items.length ?? 0} (read_guidance).`,
    managementText(state),
    state.frozenSources ? "Start with list_snapshot_sources or find_snapshot_passages." : "Start with find_filing_sections or list_filings.",
  ].filter(Boolean).join("\n\n");
}

/** The facts the models read, one line each; the research opening already carried the rest. */
const MODEL_FACTS = ["revenue_ttm", "operating_income_ttm", "net_income_ttm", "cfo_ttm", "capex_ttm", "da_ttm", "sbc_ttm", "interest_expense_ttm", "ebitda_ttm", "cash", "investments", "debt", "leases", "finance_leases", "operating_leases", "other_senior_claims", "finance_lease_debt_overlap", "preferred_stock", "minority_interest", "equity", "net_debt", "invested_capital", "shares_diluted_weighted", "shares_outstanding", "operating_margin_ttm", "effective_tax_rate_ttm", "fcf_ttm", "rpo_total", "rpo_next_12m_share"];

/** Management's cited targets with the evidence ids that carry them, one line per target; empty without a target set. */
export function managementText(state: ValuationState): string {
  const set = state.input.management;
  if (!set) return state.input.managementNotes?.length ? `Management targets: none used (${state.input.managementNotes.join("; ")}).` : "";
  const ids = [...state.evidence.values()].filter(e => e.documentId === `management:${state.input.ticker}`).map(e => `${e.evidenceId} (${e.publishedAt})`);
  const amount = (t: typeof set.targets[number]) => t.unit === "ratio" ? pct(t.value) : t.unit === "per_share" ? t.value.toFixed(2) : `${(t.value / 1e9).toFixed(1)}B`;
  const lines = set.targets.map(t => `FY${t.fiscalYear} ${t.metric === "segment_revenue" ? `${t.segment} revenue` : t.metric.replace("_", " ")} ${t.kind === "floor" ? "≥ " : t.kind === "ceiling" ? "≤ " : ""}${amount(t)}${t.basis === "non_gaap" ? " non-GAAP" : ""}${t.kind === "derived" ? " (derived)" : ""}`);
  return `Management targets (cited, fiscal year ends month ${set.fiscalYearEndMonth}, as of ${set.asOf}; evidence ${ids.join(", ") || "registered at the start of the run"}):\n${lines.join("\n")}`;
}

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
  const peers = state.peerMultiples ? `Peers (${input.peerBasis}: ${state.peerMultiples.peers.map(p => `${p}${state.peerMultiples!.weights?.[p] != null && input.peerBasis === "unit" ? ` ${(state.peerMultiples!.weights[p]! * 100).toFixed(0)}%` : ""}`).join(", ")}) trailing EV/EBITDA p25/median/p75 ${state.peerMultiples.evToEbitda ? `${state.peerMultiples.evToEbitda.p25.toFixed(1)}/${state.peerMultiples.evToEbitda.median.toFixed(1)}/${state.peerMultiples.evToEbitda.p75.toFixed(1)}` : "n/a"}; core P/E ${state.peerMultiples.peRatio ? `${state.peerMultiples.peRatio.p25.toFixed(1)}/${state.peerMultiples.peRatio.median.toFixed(1)}/${state.peerMultiples.peRatio.p75.toFixed(1)}` : "n/a"}.` : "Peers: no multiples available; the DCF stands alone.";
  const priorText = prior ? `Prior (${input.lifecycle} life cycle, ${prior.scenarios.base.drivers.modelType === "fcff" ? prior.scenarios.base.drivers.path.revenueGrowth.length : 5} years; revise, do not copy): ${JSON.stringify({ discountRate: Number(prior.discountRate.value.toFixed(4)), shares: prior.shares.base, bridge: { nonOperatingAssets: prior.bridge.nonOperatingAssets, debtAndClaims: prior.bridge.debtAndClaims }, base: prior.scenarios.base.drivers })}${anchor ? `\nRPO floor (contracted revenue by year, ${anchor.asOf}): ${anchor.floor.map(f => (f / 1e9).toFixed(1)).join(", ")}B = ${anchor.floorToRevenue0.map(v => pct(v)).join(", ")} of trailing revenue.${anchor.notes.length ? ` ${anchor.notes.join("; ")}` : ""}` : ""}` : "No prior could be computed from history.";
  const methodsAvailable = state.peerMultiples ? `Methods available: dcf; ev_ebitda_forward ${state.peerMultiples.evToEbitda ? "yes" : "no (no peer EV/EBITDA)"}; pe_forward ${state.peerMultiples.peRatio ? (input.facts.some(f => f.id === "interest_expense_ttm") ? "yes" : "no (trailing interest expense unknown)") : "no (no peer P/E)"}. Weigh them as you judge (sum 1); an unavailable one gets 0 with the reason.` : "Methods available: dcf only (no peer multiples); ev_ebitda_forward and pe_forward get weight 0 with the reason.";
  const managementNote = input.management ? "Management scenario: computed by code from the targets above; give scenarioProbabilities.management with a rationale citing the management evidence ids, and managementComparison explaining the gap of your base path to the targets." : "Management scenario: none (no cited target set); scenarioProbabilities.management is 0 with the rationale \"no target set\" and managementComparison is null.";
  return [
    `Company: ${input.companyName} (${input.ticker}); statements in ${input.currency} to ${input.financialPeriodEnd}; ${input.lifecycle} life cycle. ${state.quote ? `Reference close ${state.quote.price} ${state.quote.currency} on ${state.quote.priceDate}${state.quote.usable ? "" : " (not usable)"}.` : "No reference quote."}`,
    `Model facts (id | label | value | period | basis):\n${facts}`, `History:\n${dist || "none"}`, rates, peers, methodsAvailable, managementText(state), managementNote, `Recorded dimensions:\n${dims}`, `Registered evidence:\n${evidence || "none"}`, priorText,
  ].filter(Boolean).join("\n\n");
}

/** The judgements behind the model, one line each, for the composer and (appended by code) the published model notes. */
export function judgementLines(calc: ValuationModelResult): string[] {
  const out: string[] = [];
  const fair = calc.fairValueRange;
  if (fair?.status === "unavailable") out.push(`Normal fair-value range unavailable: ${fair.reason}${fair.evidenceIds.length ? ` [${fair.evidenceIds.join("][")}]` : ""}.`);
  if (fair?.status === "available") {
    out.push(`Normal fair-value range ${fair.low.toFixed(2)}–${fair.high.toFixed(2)}, central ${fair.base.toFixed(2)}: ${fair.rationale} [${fair.evidenceIds.join("][")}]`);
    for (const key of ["lower", "upper"] as const) {
      const normal = fair[key];
      out.push(`Normal ${key}: ${normal.narrative} [${normal.evidenceIds.join("][")}] ${(["revenue", "margin", "capex"] as const).map(k => `${k}: ${normal.assumptions[k].rationale} [${normal.assumptions[k].evidenceIds.join("][")}]`).join(" ")}`);
    }
  }
  if (calc.methodWeights) out.push(`Method weights: ${VALUATION_METHODS.map(k => `${k} ${(calc.methodWeights![k].weight * 100).toFixed(0)}% — ${calc.methodWeights![k].rationale}${calc.methodWeights![k].evidenceIds.length ? ` [${calc.methodWeights![k].evidenceIds.join("][")}]` : ""}`).join(" ")}`);
  if (calc.scenarioProbabilities) out.push(`Scenario probabilities: ${EXTENDED_SCENARIO_KEYS.map(k => `${k} ${(calc.scenarioProbabilities![k].probability * 100).toFixed(0)}% — ${calc.scenarioProbabilities![k].rationale}${calc.scenarioProbabilities![k].evidenceIds.length ? ` [${calc.scenarioProbabilities![k].evidenceIds.join("][")}]` : ""}`).join(" ")}`);
  if (calc.managementComparison) out.push(`Management comparison: ${calc.managementComparison.rows.map(r => `year ${r.year} (FY${r.fiscalYear}) base ${(r.base / 1e9).toFixed(1)}B vs target ${(r.target / 1e9).toFixed(1)}B (${r.gap >= 0 ? "+" : ""}${(r.gap * 100).toFixed(0)}%)`).join("; ")}. ${calc.managementComparison.explanation}${calc.managementComparison.evidenceIds.length ? ` [${calc.managementComparison.evidenceIds.join("][")}]` : ""}`);
  if (calc.consensusNote) out.push(calc.consensusNote.status === "cited" ? `Consensus: ${calc.consensus ? `mean ${calc.consensus.mean.toFixed(2)}${calc.consensus.low != null && calc.consensus.high != null ? ` (range ${calc.consensus.low}–${calc.consensus.high})` : ""}${calc.consensus.count ? `, ${calc.consensus.count} analysts` : ""}` : ""} from ${calc.consensusNote.source ?? "the cited page"}.` : `Consensus unavailable: ${calc.consensusNote.reason ?? "no sell-side target was cited"}.`);
  if (calc.discountRate.sources) out.push(`Discount rate sources: ${Object.entries(calc.discountRate.sources).map(([k, v]) => `${k} ${v.source}${v.evidenceIds.length ? ` [${v.evidenceIds.join("][")}]` : ""}`).join("; ")}.`);
  return out;
}

export function openingCompose(state: ValuationState): string {
  const calc = state.calc?.result;
  // Rationales are cut to their first 800 characters: the composer cites evidence ids, not the research prose.
  const dims = [...state.dimensions.values()].map(d => `${d.key}: ${d.score ?? "null"} (${d.confidence})\n  ${d.rationale.slice(0, 800)}\n  supporting ${d.supportingEvidenceIds.join(", ") || "none"}; counter ${d.counterEvidenceIds.join(", ") || "none"}; gaps ${d.gaps.join(" | ") || "none"}; next check ${d.nextCheck.slice(0, 200)}`).join("\n");
  const model = calc ? [
    `Model ${calc.modelType}, r ${pct(calc.discountRate.value)} (${calc.discountRate.basis}), economic shares ${calc.shares.economic.toExponential(3)}.`,
    calc.fairValueRange?.status === "available" ? `Headline normal fair-value range ${calc.fairValueRange.low.toFixed(2)}–${calc.fairValueRange.high.toFixed(2)}, central ${calc.fairValueRange.base.toFixed(2)}. Reference close ${state.quote?.price ?? "unavailable"} on ${state.quote?.priceDate ?? "unknown"}.` : `Normal fair-value range unavailable: ${calc.fairValueRange?.status === "unavailable" ? calc.fairValueRange.reason : "not assessed"}.`,
    ...(["bear", "base", "bull"] as const).map(k => `${k}: DCF ${calc.scenarios[k].result.perShare.toFixed(2)}${calc.scenarios[k].valuation ? `, method-weighted ${calc.scenarios[k].valuation!.perShare.toFixed(2)}` : ""} per share; p=${calc.scenarios[k].probability ?? "n/a"}; ${calc.scenarios[k].narrative}${calc.scenarios[k].assumptions ? ` Revenue: ${calc.scenarios[k].assumptions!.revenue.rationale} Margin: ${calc.scenarios[k].assumptions!.margin.rationale} Capex: ${calc.scenarios[k].assumptions!.capex.rationale}` : ""}`),
    calc.managementScenario ? `management: DCF ${calc.managementScenario.result.perShare.toFixed(2)}${calc.managementScenario.valuation ? `, method-weighted ${calc.managementScenario.valuation.perShare.toFixed(2)}` : ""} per share; p=${calc.managementScenario.probability ?? "n/a"}; ${calc.managementScenario.narrative}` : "",
    `Stress/opportunity scenarios (method-weighted) ${calc.range.low.toFixed(2)}–${calc.range.high.toFixed(2)}, base ${calc.range.base.toFixed(2)}, expected over bear/base/management/bull ${calc.range.expected?.toFixed(2) ?? "n/a"}, price ${calc.range.price ?? "n/a"}, margin of safety on the base ${pct(calc.range.marginOfSafety)}, downside coverage ${pct(calc.range.downsideCoverage)}, expected upside ${pct(calc.range.expectedUpside)}.`,
    calc.implied ? `Market-implied constant revenue growth ${pct(calc.implied.implied)} vs base average ${pct(calc.implied.baseAverage)} (gap ${pct(calc.implied.gap)}).` : "",
    calc.methods?.length ? `Methods on the base path: ${calc.methods.map(m => `${m.label} ${m.base != null ? `${m.low!.toFixed(2)} / ${m.base.toFixed(2)} / ${m.high!.toFixed(2)} (weight ${(m.weight * 100).toFixed(0)}%)` : `not applied (${m.notes[0] ?? ""})`}`).join("; ")}${calc.triangulation ? `; football field ${calc.triangulation.low.toFixed(2)}–${calc.triangulation.high.toFixed(2)}, base ${calc.triangulation.base.toFixed(2)}` : ""}.` : "",
    ...judgementLines(calc),
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
  const fact = (id: string) => input.facts.find(f => f.id === id)?.value ?? null;
  const build = (capexShape: number[] | null): CalcRequest | null => {
    const prior = priorOf({ currency: input.currency, facts: input.facts.map(f => ({ id: f.id, value: f.value, unit: f.unit })), distributions: input.distributions, diagnostics: input.diagnostics, rpo, riskFree: state.riskFree?.value ?? null, beta: state.beta?.beta ?? null, price: state.quote?.usable ? state.quote.price : null, capexShape });
    return prior ? { ...prior, context: { ...prior.context, peers: state.peerMultiples, multipleHistory: state.multipleHistory, trailing: { ebitda: fact("ebitda_ttm"), da: fact("da_ttm"), interestExpense: fact("interest_expense_ttm") }, management: input.management, periodEnd: input.financialPeriodEnd } } : null;
  };
  // The cited capex plan times the prior's build capex (peak in any year) as long as the prior still passes every gate; the taper stands otherwise, and without a plan.
  const capexShape = input.management && fact("revenue_ttm") ? managementCapexShape(input.management, input.financialPeriodEnd, horizonFor(input.lifecycle), managementFactsOf(input.facts, fact("revenue_ttm")!)) : null;
  const shaped = capexShape ? build(capexShape) : null;
  if (shaped) { try { if (calculateValuation(shaped).gates?.every(g => g.status !== "fail")) return shaped; } catch { /* the taper follows */ } }
  return build(null);
}

type Loop = { recipeId: string; system: string; allow: string[]; budget: { turns: number; wallMs: number }; settled: (s: ValuationState) => boolean; tool: "valuation-research" | "valuation" };

async function runLoop(env: AnalysisEnv, step: WorkflowStepLike, state: ValuationState, loop: Loop, opening: string, generation: number | null, fetcher: typeof fetch, turns: TurnRecord[], runId?: string): Promise<"finished" | "budget" | "failed" | "cancelled"> {
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
  const host: LoopHost = {
    // Switched off or re-requested while the run was working: the loop ends before its next model call.
    reserve: async () => { const ok = generation === null || await stillEligible(env, state.input.ticker, store, generation); if (!ok) state.cancelled = true; return ok; },
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
    normal: calc.result.fairValueRange?.status === "available" ? { rationale: calc.result.fairValueRange.rationale, lower: { ...calc.result.fairValueRange.lower, gates: undefined, verification: undefined, result: undefined }, upper: { ...calc.result.fairValueRange.upper, gates: undefined, verification: undefined, result: undefined } } : null,
    implied: calc.result.implied, sensitivities: calc.result.sensitivities.slice(0, 4),
    dimensions: [...state.dimensions.values()].map(d => ({ key: d.key, score: d.score, rationale: d.rationale.slice(0, 500) })),
    evidence: [...state.evidence.values()].map(e => ({ id: e.evidenceId, title: e.title, excerpt: excerptOf(e).slice(0, 250) })),
  };
  const system = `You are the counter-evidence reviewer of a valuation. From the base case, the normal fair-value bounds (when supplied), the price-implied path and the registered evidence only, name the two assumptions most likely to be wrong and what in the evidence argues against them. Check that the normal bounds describe evidenced ordinary operations and are not renamed stress cases or an arbitrary percentage. Reply as JSON: {"weakestAssumptions":[{"factor":"...","why":"...","evidenceIds":["e..."]}],"decisiveCounterEvidence":false,"counterEvidenceIds":["e..."]}. decisiveCounterEvidence is true only when a registered passage contradicts the long-term thesis or the normal operating assumptions and nothing in the rationales answers it. Cite only ids from the evidence list.`;
  const reply = await step.do("valuation-redteam", async () => {
    try { return await callWorkerSecModel(env, fetcher, "valuation-redteam", system, payload, modelFor(env, "valuation"), MODEL_BUDGET_MS, { reasoning: reasoningFor(env, "valuation"), ticker: state.input.ticker, runId, kind: "valuation" }); }
    catch (error) { if (error instanceof SecModelOutputError) return null; throw error; }
  });
  if (!reply) return null;
  // The reply has one shape; anything else is no review (the report says so), never a half-read one.
  const parsed = RED_TEAM_SCHEMA.safeParse(reply);
  if (!parsed.success) return null;
  const known = (ids: string[]) => ids.filter(id => state.evidence.has(id));
  const weakest = parsed.data.weakestAssumptions.map(w => ({ factor: w.factor.slice(0, 80), why: w.why.slice(0, 400), evidenceIds: known(w.evidenceIds) }));
  return { weakestAssumptions: weakest, decisiveCounterEvidence: parsed.data.decisiveCounterEvidence && known(parsed.data.counterEvidenceIds).length > 0, counterEvidenceIds: known(parsed.data.counterEvidenceIds) };
}
/** The counter-evidence reviewer's reply: every field required; the two weakest assumptions each with a reason and evidence. */
export const RED_TEAM_SCHEMA = z.object({
  weakestAssumptions: z.array(z.object({ factor: z.string().min(1), why: z.string().min(1), evidenceIds: z.array(z.string()) })).min(1).max(3),
  decisiveCounterEvidence: z.boolean(),
  counterEvidenceIds: z.array(z.string()),
});

/** The publication from the run's state: ceilings applied, scores composed, the verdict decided, every figure the calculator's. */
export async function assemblePublication(state: ValuationState, now: string, methodVersion: string): Promise<{ publication: ValuationPublication; evidence: ValuationEvidence[] }> {
  const calc = state.calc?.result ?? null;
  const gaps: ValuationGap[] = [...state.modelGaps];
  if (!state.quote) gaps.push({ code: "missing_quote", message: "No reference close could be read, so no price comparison is made.", evidenceIds: [] });
  else if (!state.quote.usable) gaps.push({ code: "stale_quote", message: state.quote.limitations.join(" "), evidenceIds: [] });
  for (const id of state.input.missing) gaps.push({ code: "missing_inputs", field: id, message: `${id} could not be resolved from the validated statements.`, evidenceIds: [] });
  const ceilings = dimensionCeilings({ marginOfSafety: calc?.range.marginOfSafety ?? null, downsideCoverage: calc?.range.downsideCoverage ?? null, bearProbability: calc?.scenarios.bear.probability ?? null, terminalShare: calc?.scenarios.base.result.terminalShare ?? null,
    hasIndependentConsensus: !!calc?.consensus, impliedGap: calc?.implied?.converged ? calc.implied.gap : null, impliedGapThreshold: impliedThreshold(state), goingConcernUnresolved: goingConcernOf(state) === "unresolved" });
  const dimensions: ValuationDimension[] = VALUATION_DIMENSIONS.map(key => {
    const d = state.dimensions.get(key) ?? { key, score: null, confidence: "low" as const, rationale: "Not assessed: the research phase ended before this dimension was recorded.", supportingEvidenceIds: [], counterEvidenceIds: [], gaps: ["not assessed"], nextCheck: "Re-run the assessment." };
    const ceiling = ceilings[key];
    const score = d.score != null && ceiling != null && d.score > ceiling ? ceiling : d.score;
    const red = state.redTeam?.counterEvidenceIds.filter(id => !d.counterEvidenceIds.includes(id)) ?? [];
    return { ...d, score, counterEvidenceIds: key === "mispricingCatalysts" ? [...d.counterEvidenceIds, ...red] : d.counterEvidenceIds, gaps: score !== d.score ? [...d.gaps, `score capped at ${ceiling} by ${key === "financialResilience" ? "unresolved going-concern evidence" : "the calculated figures"}`] : d.gaps };
  });
  if (!calc && !dimensions.find(d => d.key === "valuationSafety")!.gaps.length) gaps.push({ code: "unsupported_model", message: state.insufficient ?? "No model was computed.", evidenceIds: [] });
  if (calc?.fairValueRange) {
    if (!state.redTeam) gaps.push({ code: "review_incomplete", message: "The counter-evidence review was not completed; the price assessment remains unavailable.", evidenceIds: [] });
    if (state.redTeam?.decisiveCounterEvidence || state.composed?.decisiveCounterEvidence) gaps.push({ code: "unresolved_counter_evidence", message: "Decisive counter-evidence remains unanswered; the normal valuation assumptions need review.", evidenceIds: [...new Set([...(state.redTeam?.counterEvidenceIds ?? []), ...[...(state.composed?.sections.counterEvidence.join(" ") ?? "").matchAll(CITATION)].map(m => m[0])])] });
  }
  const score = weightedScore(dimensions), confidence = overallConfidence(dimensions);
  const verdict = verdictOf({ dimensions, marginOfSafety: calc?.range.marginOfSafety ?? null, hasModel: !!calc && calc.range.price != null, decisiveCounterEvidence: !!state.composed?.decisiveCounterEvidence || !!state.redTeam?.decisiveCounterEvidence, coreLogicFailed: !!state.composed?.coreLogicFailed });
  // A report is complete only once it has been written: scored dimensions and a model without the case stay insufficient.
  if (!state.composed) gaps.push({ code: "research_budget_exhausted", message: "The research and written report did not complete within the available run; partial scores, calculations and evidence do not establish a current price assessment.", evidenceIds: [] });
  const reviewIncomplete = gaps.some(g => g.code === "review_incomplete" || g.code === "unresolved_counter_evidence");
  const reportStatus = score != null && calc && state.quote?.usable && state.composed && !reviewIncomplete ? "ready" : "insufficient";
  const composed = state.composed?.sections ?? { summary: "", thesis: "", expectationsGap: "", catalysts: [], counterEvidence: [], nextChecks: [], modelNotes: "" };
  // The judgements behind the model are published verbatim under the composer's notes, so the weights and probabilities are never only in the payload.
  const appendix = calc ? judgementLines(calc) : [];
  const sections = appendix.length ? { ...composed, modelNotes: `${composed.modelNotes}${composed.modelNotes ? "\n\n" : ""}JUDGEMENTS. ${appendix.join("\n")}` } : composed;
  const judgementIds = calc ? [...VALUATION_METHODS.flatMap(k => calc.methodWeights?.[k].evidenceIds ?? []), ...EXTENDED_SCENARIO_KEYS.flatMap(k => calc.scenarioProbabilities?.[k].evidenceIds ?? []), ...(calc.managementComparison?.evidenceIds ?? []), ...(calc.managementScenario?.evidenceIds ?? []),
    ...(["bear", "base", "bull"] as const).flatMap(k => calc.scenarios[k].assumptions ? [...calc.scenarios[k].assumptions!.revenue.evidenceIds, ...calc.scenarios[k].assumptions!.margin.evidenceIds, ...calc.scenarios[k].assumptions!.capex.evidenceIds] : []), ...Object.values(calc.discountRate.sources ?? {}).flatMap(s => s.evidenceIds), ...(calc.consensus?.evidenceId ? [calc.consensus.evidenceId] : [])] : [];
  const fair = calc?.fairValueRange;
  const fairIds = fair ? [...fair.evidenceIds, ...(fair.status === "available" ? [fair.lower, fair.upper].flatMap(c => [...c.evidenceIds, ...Object.values(c.assumptions).flatMap(a => a.evidenceIds)]) : [])] : [];
  const cited = new Set<string>([...dimensions.flatMap(d => [...d.supportingEvidenceIds, ...d.counterEvidenceIds]), ...(calc ? (["bear", "base", "bull"] as const).flatMap(k => calc.scenarios[k].evidenceIds) : []), ...judgementIds, ...fairIds, ...[...`${sections.summary} ${sections.thesis} ${sections.expectationsGap} ${sections.catalysts.join(" ")} ${sections.counterEvidence.join(" ")} ${sections.modelNotes}`.matchAll(CITATION)].map(m => m[0])]);
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

export async function researchValuation({ input, market, now, step, env, mode, generatedAt = now, fetcher = fetch, runId }: {
  input: ValuationInput; market: Pick<ValuationState, "quote" | "riskFree" | "beta" | "peerMultiples" | "multipleHistory">;
  now: string; generatedAt?: string; step: WorkflowStepLike; env: AnalysisEnv; fetcher?: typeof fetch; runId?: string;
  mode: { kind: "live"; generation: number } | { kind: "snapshot"; sources: FrozenResearchSource[] };
}) {
  const generation = mode.kind === "live" ? mode.generation : null;
  const state: ValuationState = { ...(mode.kind === "snapshot" ? { frozenSources: mode.sources } : {}), input, researchAsOf: now, now: generatedAt, quote: market.quote, riskFree: market.riskFree, beta: market.beta, peerMultiples: market.peerMultiples, multipleHistory: market.multipleHistory, evidence: new Map(), hits: [], used: { finds: 0, reads: 0, searches: 0, webReads: 0, transcripts: 0 },
    dimensions: new Map(), researchDone: false, calc: null, modelGaps: [], insufficient: null, assumptionsDone: false, redTeam: null, composed: null, cancelled: false };
  // Management's cited targets are evidence from the first turn: the research, the scenarios and the report may cite them.
  await registerManagementEvidence(state);
  const prior = await step.do("valuation-prior", async () => {
    const request = priorRequest(state);
    if (!request) return null;
    try { return { request, result: calculateValuation(request) }; } catch { return null; }
  });
  const turns: TurnRecord[] = [];
  const researchProgress = { collection: "not_run", finalization: "not_run" };
  const assumptionProgress: { configuration: string; cases: Partial<Record<ValuationCaseKey, string>>; calculation: string } = { configuration: "not_run", cases: {}, calculation: "not_run" };
  const finish = async (phases: { research: string; assumptions: string; composition: string }) => {
    const { publication, evidence } = await assemblePublication(state, generatedAt, VALUATION_VERSION);
    return { phases, researchProgress, assumptionProgress, publication, evidence, registeredEvidence: [...state.evidence.values()], turns, request: state.calc?.request ?? null,
      nearTermForecast: state.nearTermForecast ?? null,
      promptSha256: await sha256(JSON.stringify({ method: VALUATION_VERSION, prompts: [RESEARCH_SYSTEM, FINALIZE_RESEARCH_SYSTEM, ASSUME_SYSTEM, COMPOSE_SYSTEM], budget: BUDGET, mode: mode.kind })) };
  };
  let research = await runLoop(env, step, state, { recipeId: "valuation-research", system: RESEARCH_SYSTEM, allow: mode.kind === "snapshot" ? ["read_financials", "list_snapshot_sources", "find_snapshot_passages", "read_snapshot_source", "read_guidance", "submit_dimension", "finish_research"] : RESEARCH_TOOLS, budget: BUDGET.research, settled: s => s.researchDone, tool: "valuation-research" }, (mode.kind === "snapshot" ? `Historical reconstruction at ${now}. Use only frozen original text and facts provided here, never later outcomes or outside knowledge. The list_snapshot_sources/find_snapshot_passages/read_snapshot_source tools replace live filing and web readers.\n\n` : "") + openingResearch(state), generation, fetcher, turns, runId);
  researchProgress.collection = research;
  if (research === "budget") {
    research = await runLoop(env, step, state, { recipeId: "valuation-research-finalize", system: FINALIZE_RESEARCH_SYSTEM, allow: ["read_valuation_evidence", "read_financials", "submit_dimension", "finish_research"], budget: BUDGET.researchFinalize, settled: s => s.researchDone, tool: "valuation-research" }, openingResearchFinalization(state), generation, fetcher, turns, runId);
    researchProgress.finalization = research;
  }
  if (research === "cancelled") return null;
  if (research !== "finished") return finish({ research, assumptions: "not_run", composition: "not_run" });
  const readAssumptions = ["read_financials", "read_valuation_evidence", "read_guidance"];
  const opening = openingAssume(state, prior?.request ?? null);
  const configure = await runLoop(env, step, state, { recipeId: "valuation-configure", system: ASSUME_SYSTEM, allow: [...readAssumptions, "configure_valuation", "declare_model_insufficient"], budget: BUDGET.configure, settled: s => !!s.valuationDraft || !!s.insufficient, tool: "valuation" }, `${opening}\n\nThis stage submits only shared parameters with configure_valuation. Do not supply scenario paths yet. Establish the model, discount components, share/claims basis, weights, probabilities and normal-range rationale from the evidence.`, generation, fetcher, turns, runId);
  assumptionProgress.configuration = configure;
  if (configure === "cancelled") return null;
  if (configure !== "finished") return finish({ research, assumptions: configure, composition: "not_run" });
  if (!state.insufficient) {
    for (const key of ["base", "bear", "bull", "lower", "upper"] as const) {
      if ((key === "lower" || key === "upper") && state.valuationDraft?.common.fairValueBasis.status !== "available") {
        assumptionProgress.cases[key] = "not_required";
        continue;
      }
      const role = key === "lower" || key === "upper" ? `the normal ${key} operating bound, distinct from stress scenarios` : `the ${key} scenario`;
      const result = await runLoop(env, step, state, { recipeId: `valuation-case-${key}`, system: ASSUME_SYSTEM, allow: [...readAssumptions, VALUATION_CASE_TOOLS[key]], budget: BUDGET.valuationCase, settled: s => !!s.valuationDraft?.cases[key], tool: "valuation" }, `${opening}\n\nShared parameters: ${JSON.stringify(state.valuationDraft?.common)}\nPreviously submitted paths: ${JSON.stringify(state.valuationDraft?.cases)}\nThis stage supplies only ${role}. Call ${VALUATION_CASE_TOOLS[key]} with one complete path and its evidence. Follow the common model and the base horizon; do not restate other cases or calculate prices.`, generation, fetcher, turns, runId);
      assumptionProgress.cases[key] = result;
      if (result === "cancelled") return null;
      if (result !== "finished") return finish({ research, assumptions: result, composition: "not_run" });
    }
  }
  const assume = await runLoop(env, step, state, { recipeId: "valuation-assume", system: ASSUME_SYSTEM, allow: mode.kind === "snapshot" ? [...ASSUMPTION_TOOLS, "submit_next_quarter_forecast"] : ASSUMPTION_TOOLS, budget: BUDGET.assume, settled: s => s.assumptionsDone, tool: "valuation" }, `${opening}\n\nRecorded draft: ${JSON.stringify(state.valuationDraft ?? null)}\n${state.insufficient ? `The model is explicitly insufficient: ${state.insufficient}. Record valuationSafety as null with its gap.` : "All requested paths are recorded. Start with calculate_prepared_valuation({}); do not re-emit the whole model. If calculation identifies a problem, replace only that case or the shared parameters, then calculate again."}` + (mode.kind === "snapshot" ? "\nBefore finish_assumptions, submit_next_quarter_forecast from the same frozen evidence (not a mechanical annual/4 allocation), or explicitly say why it is unavailable." : ""), generation, fetcher, turns, runId);
  assumptionProgress.calculation = assume;
  if (assume === "cancelled") return null;
  if (assume !== "finished") return finish({ research, assumptions: assume, composition: "not_run" });
  state.redTeam = await redTeam(env, step, state, fetcher, runId);
  const compose = await runLoop(env, step, state, { recipeId: "valuation-compose", system: COMPOSE_SYSTEM, allow: COMPOSE_TOOLS, budget: BUDGET.compose, settled: s => !!s.composed, tool: "valuation" }, openingCompose(state), generation, fetcher, turns, runId);
  if (compose === "cancelled") return null;
  return finish({ research, assumptions: assume, composition: compose });
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
    const peerMultiples = peerMultiplesOf(input.peers.map(p => ({ ...p, price: peerQuotes[p.ticker]?.usable ? peerQuotes[p.ticker]!.price : null })), now.slice(0, 10), input.peerBasis);
    if (peerMultiples) peerMultiples.notes.push(...input.peerNotes);
    const shares = input.facts.find(f => f.id === "shares_outstanding")?.value ?? input.facts.find(f => f.id === "shares_diluted_weighted")?.value ?? null;
    const multipleHistory = closes && shares ? multipleHistoryOf(closes, shares, input.trailingQuarters) : null;
    return { quote, riskFree, beta, peerMultiples, multipleHistory };
  });
  const researched = await researchValuation({ input, market, now, step, env, mode: { kind: "live", generation }, fetcher, runId });
  if (!researched) return { status: "superseded" as const };
  const { publication, evidence, turns } = researched;
  if (!readValuationPublication(publication, params.ticker)) throw new Error("The valuation failed its public contract.");
  const published = await step.do("valuation-publish", async () => {
    // The input moved on while the run worked: this result is not for the current material; the next sweep runs again.
    const fresh = await buildValuationInput(env, params.ticker, now);
    if (!fresh || await runFingerprint(fresh.fingerprint) !== params.fingerprint) return { current: false, stored: false, reason: "input changed" };
    const outcome = await store.publish(params.ticker, publication, evidence, generation, params.fingerprint, publication.generatedAt);
    const completedAt = new Date().toISOString();
    const attempt: ValuationAttempt = { runId: runId ?? "", status: publication.reportStatus === "insufficient" ? "empty" : outcome.current ? "succeeded" : "superseded", stage: "publish", updatedAt: completedAt, reportStatus: publication.reportStatus, gaps: publication.gaps, errorCode: null };
    await store.noteAttempt(params.ticker, attempt, completedAt);
    if (outcome.current) await quietly(() => new AiRunStore(db).saveVersion("valuation", params.ticker, { ...publication, trace: turns.slice(-80) }, publication.generatedAt));
    return { ...outcome, reason: outcome.current ? "published" : publication.reportStatus === "insufficient" ? "research incomplete; previous report retained" : "generation moved on" };
  });
  if (!published.current) return { status: publication.reportStatus === "insufficient" ? "empty" as const : "superseded" as const, reason: published.reason };
  return { status: publication.reportStatus === "ready" ? "ready" as const : "empty" as const, reportStatus: publication.reportStatus, verdict: publication.verdict, score: publication.weightedScore, evidence: evidence.length, turns: turns.length, versionId: publication.versionId };
}
