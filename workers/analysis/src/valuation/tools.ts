import { z } from "zod";
import type { FindingPassage } from "../../../../shared/analysis-contract/findings.ts";
import { SCENARIO_KEYS, VALUATION_DIMENSIONS, VALUATION_MODEL_TYPES, type Confidence, type DiscountRate, type ScenarioAssumptions, type ValuationDimension, type ValuationDimensionKey, type ValuationEvidence, type ValuationGap, type ValuationModelResult, type ValuationSections } from "../../../../shared/analysis-contract/valuation.ts";
import { calculateValuation, dimensionCeilings, discountRateBaseline, outsideHistory, percentileRank, ValuationCalcError, type CalcRequest } from "../../../../shared/analysis-runtime/valuation/calculator.ts";
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
const READ_CHARS = 6_000, EXCERPT_CHARS = 700;

export type RedTeam = { weakestAssumptions: Array<{ factor: string; why: string; evidenceIds: string[] }>; decisiveCounterEvidence: boolean; counterEvidenceIds: string[] };
export type ValuationState = {
  input: ValuationInput;
  researchAsOf: string;
  now: string;
  quote: ReferenceQuote | null;
  riskFree: RiskFreeRate | null;
  beta: BetaEstimate | null;
  evidence: Map<string, ValuationEvidence>;
  hits: SearchHit[];
  used: { finds: number; reads: number; searches: number; webReads: number; transcripts: number };
  dimensions: Map<ValuationDimensionKey, ValuationDimension>;
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
    state.evidence.set(evidenceId, { evidenceId, kind, title: passage.title.slice(0, 300), url: passage.url, documentId: kind === "sec" ? passage.documentId : null, passageId: kind === "sec" ? passage.passageId : null, form: passage.form,
      publishedAt: kind === "sec" ? passage.filedAt : publishedAt, fetchedAt: state.now, excerpt: passage.table ? renderTable(passage.table, []).slice(0, 1500) : passage.text.slice(0, 1500), contentSha256, path: passage.path.join(" › ") });
  }
  return evidenceId;
}

const knownId = (state: ValuationState, id: string) => state.evidence.has(id) || state.input.facts.some(f => f.id === id) || state.input.diagnostics.some(d => d.key === id);
/** Evidence ids as prose cites them: in brackets, in parentheses or bare. */
export const CITATION = /\be[0-9a-f]{10}\b/g;
const checkIds = (state: ValuationState, ids: string[], what: string): string[] => ids.filter(id => !knownId(state, id)).map(id => `${what} cites ${id}, which is neither registered evidence, a fact id nor a diagnostic key`);

const dimensionSchema = z.object({
  key: z.enum(VALUATION_DIMENSIONS), score: z.number().nullable(), confidence: z.enum(["high", "medium", "low"]),
  rationale: z.string().min(80).max(2000), supportingEvidenceIds: z.array(z.string()).max(12), counterEvidenceIds: z.array(z.string()).max(12),
  gaps: z.array(z.string().max(300)).max(6), nextCheck: z.string().min(10).max(400),
});

function submitDimension(state: ValuationState, value: z.infer<typeof dimensionSchema>, allowed: ValuationDimensionKey[]): string {
  const errors: string[] = [];
  if (!allowed.includes(value.key)) errors.push(`${value.key} is not scored in this phase`);
  if (value.score != null && (value.score < 0 || value.score > 10 || Math.abs(value.score * 2 - Math.round(value.score * 2)) > 1e-9)) errors.push("score must be 0–10 in steps of 0.5, or null");
  errors.push(...checkIds(state, value.supportingEvidenceIds, "supportingEvidenceIds"), ...checkIds(state, value.counterEvidenceIds, "counterEvidenceIds"));
  if (value.score != null && !value.supportingEvidenceIds.some(id => state.evidence.has(id) && state.evidence.get(id)!.kind === "sec")) errors.push("a scored dimension needs at least one registered filing passage among its supporting evidence");
  if (value.score == null && !value.gaps.length) errors.push("an unscored dimension must name the gap that prevents a score");
  if (errors.length) return `Not accepted:\n  ${errors.join("\n  ")}`;
  state.dimensions.set(value.key, value);
  return `${value.key} recorded: score ${value.score ?? "null"}, confidence ${value.confidence}.`;
}

const driverPath = z.object({ revenueGrowth: z.array(z.number()).length(5), operatingMargin: z.array(z.number()).length(5), taxRate: z.array(z.number()).length(5), salesToCapital: z.array(z.number()).length(5), normalization: z.array(z.number()).length(5).optional() });
const drivers = z.discriminatedUnion("modelType", [
  z.object({ modelType: z.literal("fcff"), revenue0: z.number(), path: driverPath, terminalGrowth: z.number(), terminalRoic: z.number() }),
  z.object({ modelType: z.literal("fcfe"), cfo: z.number(), capex: z.number(), sbc: z.number(), normalization: z.number(), netBorrowing: z.number(), growth: z.array(z.number()).length(5), terminalGrowth: z.number() }),
  z.object({ modelType: z.literal("revenue_fcfe"), revenue0: z.number(), growth: z.array(z.number()).length(5), afterSbcEquityCashMargin: z.array(z.number()).length(5), terminalGrowth: z.number() }),
  z.object({ modelType: z.literal("residual_income"), bookEquity0: z.number(), roe: z.array(z.number()).length(5), payout: z.array(z.number()).length(5), terminalRoe: z.number(), terminalGrowth: z.number() }),
  z.object({ modelType: z.literal("earnings_multiple"), epsLow: z.number(), epsHigh: z.number(), weight: z.number(), multiple: z.number(), horizonYears: z.number() }),
  z.object({ modelType: z.literal("reported_earnings_multiple"), commonEarnings: z.number(), earningsScale: z.number(), multiple: z.number(), horizonYears: z.number() }),
  z.object({ modelType: z.literal("proforma_earnings_multiple"), commonEarnings: z.number(), earningsScale: z.number(), multiple: z.number(), horizonYears: z.number() }),
  z.object({ modelType: z.literal("asset_nav"), assets: z.array(z.object({ units: z.number(), price: z.number(), costBasis: z.number(), taxRate: z.number() })).min(1), otherNetAssets: z.number(), debtClaims: z.number(), preferredClaims: z.number(), operatingReserve: z.number() }),
  z.object({ modelType: z.literal("affo_multiple"), affoLow: z.number(), affoHigh: z.number(), weight: z.number(), recurringCostPerShare: z.number(), multiple: z.number(), horizonYears: z.number() }),
  z.object({ modelType: z.literal("affo_dcf"), annualAffo: z.number(), recurringCost: z.number(), growth: z.array(z.number()).length(5), terminalGrowth: z.number() }),
]);
const scenarioSchema = z.object({ narrative: z.string().min(20).max(1500), probability: z.number().nullable(), triggers: z.array(z.string().max(400)).max(6), invalidation: z.array(z.string().max(400)).max(6), evidenceIds: z.array(z.string()).max(12), drivers });
const calcSchema = z.object({
  modelType: z.enum(VALUATION_MODEL_TYPES),
  discountRate: z.object({ basis: z.enum(["wacc", "cost_of_equity"]), equityRiskPremium: z.number().nullable(), riskFree: z.number().nullable(), beta: z.number().nullable(), costOfDebt: z.number().nullable(), taxRate: z.number().nullable(), equityWeight: z.number().nullable(), value: z.number().nullable(), rationale: z.string().min(20).max(1500), sourceRefs: z.array(z.string()).max(8) }),
  shares: z.object({ baseFactId: z.string(), dilutionPercent: z.number().min(0).max(0.5), rationale: z.string().min(10).max(800) }),
  bridge: z.object({ nonOperatingAssets: z.number(), debtAndClaims: z.number(), nonOperatingEquityAdjustment: z.number(), notes: z.array(z.string().max(400)).max(10) }),
  scenarios: z.object({ bear: scenarioSchema, base: scenarioSchema, bull: scenarioSchema }),
});
type CalcArgs = z.infer<typeof calcSchema>;

function runCalculation(state: ValuationState, args: CalcArgs): string {
  const errors: string[] = [];
  const facts = state.input.facts;
  const baseShares = facts.find(f => f.id === args.shares.baseFactId && f.unit === "shares");
  if (!baseShares) errors.push(`shares.baseFactId must be a share-count fact id (${facts.filter(f => f.unit === "shares").map(f => f.id).join(", ") || "none available"})`);
  for (const key of SCENARIO_KEYS) {
    const s = args.scenarios[key];
    if (s.drivers.modelType !== args.modelType) errors.push(`scenario ${key} uses ${s.drivers.modelType}, not ${args.modelType}`);
    errors.push(...checkIds(state, s.evidenceIds, `scenario ${key}`));
  }
  if (errors.length) return `Not accepted:\n  ${errors.join("\n  ")}`;
  // The discount rate: computed from sourced components when they are all given, else the stated value as an assumption.
  const d = args.discountRate;
  const rf = d.riskFree ?? state.riskFree?.value ?? null, beta = d.beta ?? state.beta?.beta ?? null;
  const baseline = rf != null && beta != null && d.equityRiskPremium != null ? discountRateBaseline({ riskFree: rf, beta, equityRiskPremium: d.equityRiskPremium, costOfDebt: d.costOfDebt, taxRate: d.taxRate, equityWeight: d.equityWeight }, d.basis) : null;
  const value = baseline?.value ?? d.value;
  if (value == null) return "Not accepted: give either every component of the discount rate (riskFree, beta, equityRiskPremium, and for wacc costOfDebt, taxRate, equityWeight) or an explicit value with its rationale.";
  const gaps: ValuationGap[] = [];
  if (!baseline) gaps.push({ code: "discount_rate_unsourced", message: `The discount rate ${pct(value)} is a stated assumption, not computed from sourced components.`, evidenceIds: [] });
  if (d.equityRiskPremium != null && !d.sourceRefs.length) gaps.push({ code: "discount_rate_unsourced", message: "The equity risk premium cites no source.", evidenceIds: [] });
  const discountRate: DiscountRate = { value, basis: d.basis, components: { riskFree: rf, beta, equityRiskPremium: d.equityRiskPremium, costOfEquity: baseline?.costOfEquity ?? (d.basis === "cost_of_equity" ? value : null), costOfDebt: d.costOfDebt, taxRate: d.taxRate, equityWeight: d.equityWeight }, rationale: d.rationale, sourceRefs: d.sourceRefs };
  const request: CalcRequest = {
    modelType: args.modelType, currency: state.input.currency, discountRate, shares: { base: baseShares!.value, dilutionReserve: baseShares!.value * args.shares.dilutionPercent, basis: `${baseShares!.id}; dilution ${(args.shares.dilutionPercent * 100).toFixed(2)}% of base; ${args.shares.rationale}` },
    bridge: args.bridge, price: state.quote?.usable ? state.quote.price : null,
    scenarios: Object.fromEntries(SCENARIO_KEYS.map(k => [k, args.scenarios[k] as ScenarioAssumptions])) as Record<"bear" | "base" | "bull", ScenarioAssumptions>,
  };
  let result: ValuationModelResult;
  try { result = calculateValuation(request); }
  catch (error) {
    if (error instanceof ValuationCalcError) return `The calculator rejected the inputs (${error.code}): ${error.message}. Revise and call calculate_valuation again.`;
    throw error;
  }
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
  if (terminalShare != null && terminalShare > 0.8) gaps.push({ code: "tv_share_high", message: `Terminal value is ${pct(terminalShare)} of the base operating value.`, evidenceIds: [] });
  state.calc = { request, result };
  state.modelGaps = gaps;
  state.insufficient = null;
  const r = result.range;
  const line = (k: "bear" | "base" | "bull") => `${k}: ${r[k === "bear" ? "low" : k === "bull" ? "high" : "base"].toFixed(2)} per share` + (result.scenarios[k].result.terminalShare != null ? ` (terminal ${pct(result.scenarios[k].result.terminalShare!)})` : "");
  const ceilings = dimensionCeilings({ marginOfSafety: r.marginOfSafety, downsideCoverage: r.downsideCoverage, bearProbability: args.scenarios.bear.probability, terminalShare, hasIndependentConsensus: false, impliedGap: result.implied?.gap ?? null, impliedGapThreshold: impliedThreshold(state), goingConcernUnresolved: false });
  return [
    `Calculated (${result.modelType}, r = ${pct(value)} ${d.basis}${baseline ? ", from components" : ", stated"}; economic shares ${money(result.shares.economic)}).`,
    SCENARIO_KEYS.map(line).join("\n"),
    `expected: ${r.expected != null ? r.expected.toFixed(2) : "n/a (no probabilities)"}; price ${r.price ?? "n/a"}; margin of safety ${r.marginOfSafety != null ? pct(r.marginOfSafety) : "n/a"}; downside coverage ${r.downsideCoverage != null ? pct(r.downsideCoverage) : "n/a"}; expected upside ${r.expectedUpside != null ? pct(r.expectedUpside) : "n/a"}`,
    result.implied ? `market-implied constant revenue growth: ${pct(result.implied.implied)} vs base average ${pct(result.implied.baseAverage)} (gap ${pct(result.implied.gap)}${result.implied.converged ? "" : ", not converged"})` : "",
    `sensitivities: ${result.sensitivities.map(s => `${s.factor} ${s.step} → ${s.changePercent >= 0 ? "+" : ""}${s.changePercent.toFixed(1)}%`).join("; ")}`,
    placements.length ? `history: ${placements.join("; ")}` : "",
    gaps.length ? `gaps recorded: ${gaps.map(g => g.code).join(", ")}` : "",
    `ceilings now in force: ${Object.entries(ceilings).map(([k, v]) => `${k} ≤ ${v}`).join(", ") || "none"}`,
    "Submit valuationSafety with submit_dimension, then finish_assumptions; or revise and calculate again.",
  ].filter(Boolean).join("\n");
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
        for (const p of read.passages) out.push(`[${await registerEvidence(ctx.state, p, "sec", null)}] ${p.path.join(" › ")}\n${p.table ? renderTable(p.table, args.focus ?? []) : p.text.slice(0, 2400)}`);
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
    tool({ name: "submit_dimension", description: "Record one dimension's score (0–10 in 0.5 steps, or null with a gap), confidence, rationale and the evidence ids it rests on.", parameters: dimensionSchema,
      execute: (value, ctx) => submitDimension(ctx.state, value, ctx.state.researchDone ? ["valuationSafety"] : ["businessQuality", "growthExecution", "financialResilience", "mispricingCatalysts"]), observe: (_a, v) => v }),
    tool({ name: "finish_research", description: "End the research phase once businessQuality, growthExecution, financialResilience and mispricingCatalysts are each submitted.", parameters: z.object({}),
      execute: (_a, ctx) => {
        const missing = (["businessQuality", "growthExecution", "financialResilience", "mispricingCatalysts"] as const).filter(k => !ctx.state.dimensions.has(k));
        if (missing.length) throw new Error(`submit ${missing.join(", ")} first (score null with a gap is allowed)`);
        ctx.state.researchDone = true; return "Research recorded.";
      }, observe: (_a, v) => v }),
    tool({ name: "calculate_valuation", description: "Run the calculator on one model with three coherent scenarios sharing one discount rate; returns values, range, sensitivities, the market-implied path and any gaps.", parameters: calcSchema, strict: false, timeoutMs: 20_000,
      execute: (args, ctx) => runCalculation(ctx.state, args), observe: (_a, v) => v }),
    tool({ name: "declare_model_insufficient", description: "State that no model can be computed from the registered facts and say which inputs are missing.", parameters: z.object({ reason: z.string().min(20).max(600), missingFactIds: z.array(z.string().max(60)).max(10) }),
      execute: ({ reason, missingFactIds }, ctx) => { ctx.state.insufficient = reason; ctx.state.modelGaps = [{ code: "missing_inputs", message: reason, evidenceIds: [], field: missingFactIds.join(",") || undefined }]; ctx.state.calc = null; return "Recorded as insufficient; submit valuationSafety as null with the gap, then finish_assumptions."; }, observe: (_a, v) => v }),
    tool({ name: "finish_assumptions", description: "End the assumptions phase: a calculation (or a declared insufficiency) and the valuationSafety dimension are recorded.", parameters: z.object({}),
      execute: (_a, ctx) => {
        if (!ctx.state.calc && !ctx.state.insufficient) throw new Error("call calculate_valuation or declare_model_insufficient first");
        if (!ctx.state.dimensions.has("valuationSafety")) throw new Error("submit valuationSafety first");
        ctx.state.assumptionsDone = true; return "Assumptions recorded.";
      }, observe: (_a, v) => v }),
    tool({ name: "compose_valuation", description: "The written report: every figure must be one the calculator or a fact produced; cite evidence ids like [e1a2b3c4d5]. Keep each section within its limit: summary 1800, thesis 4000, expectations gap 3000 and model notes 3000 characters; list items 700 characters, at most 8 each.", parameters: z.object({
        summary: z.string().min(60).max(1800), thesis: z.string().min(80).max(4000), expectationsGap: z.string().min(40).max(3000), catalysts: z.array(z.string().max(700)).max(8), counterEvidence: z.array(z.string().max(700)).max(8), nextChecks: z.array(z.string().max(700)).min(1).max(8), modelNotes: z.string().max(3000),
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

export const RESEARCH_TOOLS = ["read_financials", "list_filings", "find_filing_sections", "read_filing_section", "read_guidance", "read_transcript", "search_evidence", "read_web_evidence", "submit_dimension", "finish_research"];
export const ASSUMPTION_TOOLS = ["read_financials", "read_guidance", "calculate_valuation", "declare_model_insufficient", "submit_dimension", "finish_assumptions"];
export const COMPOSE_TOOLS = ["compose_valuation", "finish_valuation"];

export const confidenceOf = (value: string): Confidence => value === "high" || value === "medium" ? value : "low";
export const excerptOf = (e: ValuationEvidence) => e.excerpt.replace(/\s+/g, " ").slice(0, EXCERPT_CHARS);
