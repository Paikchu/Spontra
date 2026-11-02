import { z } from "zod";
import { FACT_BASES, PERIOD_TYPES, type ValuationFact } from "../../analysis-contract/valuation.ts";
import { calculateValuation, peerMultiplesOf, type CalcRequest } from "./calculator.ts";

const finite = z.number().finite();
const nullable = finite.nullable();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.iso.datetime({ offset: true });
const strings = z.array(z.string());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const fact = z.object({ id: z.string(), label: z.string(), value: finite, unit: z.string(), currency: z.string().nullable(), periodType: z.enum(PERIOD_TYPES), periodStart: date.nullable(), periodEnd: date.nullable(), basis: z.enum(FACT_BASES), formula: z.string().nullable(), sourceRefs: strings.min(1), rationale: z.string().nullable() }) satisfies z.ZodType<ValuationFact>;
const source = z.object({ id: z.string(), kind: z.string(), accession: z.string().optional(), url: z.url(), availableAt: instant, path: z.string(), sha256: hash });
const bar = z.object({ date, closeAt: instant, close: finite.positive(), dividend: finite.nonnegative(), adjustedClose: nullable.optional() });
const managementSource = z.object({ id: z.string(), title: z.string(), url: z.url(), date });
const management = z.object({
  ticker: z.string(), fiscalYearEndMonth: z.number().int().min(1).max(12), asOf: date, sources: z.array(managementSource),
  targets: z.array(z.object({ metric: z.enum(["revenue", "segment_revenue", "operating_margin", "eps", "capex", "fcf", "rpo"]), segment: z.string().optional(), fiscalYear: z.number().int(), value: finite, unit: z.enum(["currency", "ratio", "per_share"]), basis: z.enum(["gaap", "non_gaap"]), kind: z.enum(["target", "floor", "ceiling", "derived"]), sourceIds: strings.min(1), note: z.string().optional() })),
});
const peer = z.object({ ticker: z.string(), periodEnd: date, price: nullable, shares: nullable, ebitda: nullable, coreEarnings: nullable, netDebt: nullable, sourceRefs: strings.min(1), earningsBasis: z.string(), facts: z.array(fact) });

export const historyInputSchema = z.object({
  schemaVersion: z.literal("valuation-history-input.v1"), ticker: z.string(), currency: z.literal("USD"), cutoff: instant, financialPeriodEnd: date, cutoffPolicy: z.string(),
  sources: z.array(source).min(1), facts: z.array(fact).min(1), management: management.nullable(),
  market: z.object({
    quote: z.object({ price: finite.positive(), priceDate: date, sourceId: z.string() }),
    riskFree: z.object({ value: finite, date, sourceId: z.string() }),
    beta: z.object({ value: finite, from: date, to: date, observations: z.number().int(), sourceIds: strings }).nullable(),
    series: z.array(z.object({ symbol: z.string(), sourceId: z.string(), bars: z.array(bar).min(1) })),
  }),
  peers: z.array(peer), researchMaterials: z.array(z.object({ sourceId: z.string(), title: z.string(), text: z.string() })), missing: strings, limitations: strings,
});
export type HistoryInput = z.infer<typeof historyInputSchema>;

/** A historical input is a closed evidence set. Source publication time, not download time, determines eligibility. */
export function readHistoryInput(value: unknown): HistoryInput {
  const input = historyInputSchema.parse(value);
  const cutoff = Date.parse(input.cutoff), cutoffDate = input.cutoff.slice(0, 10);
  const ids = new Set(input.sources.map(s => s.id));
  if (ids.size !== input.sources.length) throw new Error("Duplicate historical source id");
  const requireSource = (id: string) => { if (!ids.has(id)) throw new Error(`Unresolved historical source: ${id}`); };
  for (const s of input.sources) if (Date.parse(s.availableAt) > cutoff) throw new Error(`Future source: ${s.id}`);
  const checkFact = (f: ValuationFact) => {
    if (f.periodEnd && f.periodEnd > cutoffDate) throw new Error(`Future fact period: ${f.id}`);
    if (f.periodStart && f.periodEnd && f.periodStart > f.periodEnd) throw new Error(`Reversed fact period: ${f.id}`);
    f.sourceRefs.forEach(requireSource);
  };
  input.facts.forEach(checkFact);
  if (new Set(input.facts.map(f => f.id)).size !== input.facts.length) throw new Error("Duplicate historical fact id");
  for (const p of input.peers) { p.sourceRefs.forEach(requireSource); p.facts.forEach(checkFact); if (p.periodEnd > cutoffDate) throw new Error(`Future peer period: ${p.ticker}`); }
  if (input.financialPeriodEnd > cutoffDate) throw new Error("Future financial period");
  for (const s of input.market.series) {
    requireSource(s.sourceId);
    let previous = "";
    for (const b of s.bars) {
      if (Date.parse(b.closeAt) > cutoff || b.date > cutoffDate) throw new Error(`Future market bar: ${s.symbol} ${b.date}`);
      if (b.date <= previous) throw new Error(`Market bars must be unique and chronological: ${s.symbol}`);
      previous = b.date;
    }
  }
  requireSource(input.market.quote.sourceId); requireSource(input.market.riskFree.sourceId);
  input.market.beta?.sourceIds.forEach(requireSource);
  if (input.market.quote.priceDate > cutoffDate || input.market.riskFree.date > cutoffDate || (input.market.beta && input.market.beta.to > cutoffDate)) throw new Error("Future market input");
  const close = input.market.series.find(s => s.symbol === input.ticker)?.bars.find(b => b.date === input.market.quote.priceDate);
  if (!close || close.close !== input.market.quote.price) throw new Error("Reference price does not match the frozen daily bar");
  for (const m of input.researchMaterials) requireSource(m.sourceId);
  if (input.management) {
    const m = input.management;
    if (m.ticker !== input.ticker || m.asOf > cutoffDate) throw new Error("Future or mismatched management targets");
    const managementIds = new Set(m.sources.map(s => s.id));
    for (const s of m.sources) { requireSource(s.id); if (s.date > cutoffDate) throw new Error(`Future management source: ${s.id}`); }
    for (const t of m.targets) for (const id of t.sourceIds) if (!managementIds.has(id)) throw new Error(`Unresolved management source: ${id}`);
  }
  return input;
}

const judgement = z.object({ rationale: z.string(), evidenceIds: strings });
const path = z.object({ revenueGrowth: z.array(finite), operatingMargin: z.array(finite), taxRate: z.array(finite), salesToCapital: z.array(finite), normalization: z.array(finite).optional(), buildCapex: z.array(finite).optional() });
const fcff = z.object({ modelType: z.literal("fcff"), revenue0: finite, path, terminalGrowth: finite, terminalRoic: finite, terminalOperatingMargin: finite.optional() });
const scenario = z.object({ narrative: z.string(), probability: nullable, triggers: strings, invalidation: strings, evidenceIds: strings, drivers: fcff, assumptions: z.object({ revenue: judgement, margin: judgement, capex: judgement }).optional() });
const quartiles = z.object({ p25: finite, median: finite, p75: finite, count: finite });
const weighted = z.union([finite, judgement.extend({ weight: finite })]);
const probability = judgement.extend({ probability: finite });
const context = z.looseObject({
  facts: z.array(z.object({ id: z.string(), value: finite, unit: z.string() })).optional(), riskFree: nullable.optional(),
  anchor: z.object({ source: z.literal("rpo"), asOf: date, total: finite, floor: z.array(finite), floorToRevenue0: z.array(finite), notes: strings }).nullable().optional(),
  peers: z.object({ peers: strings, asOf: date, evToEbitda: quartiles.nullable(), peRatio: quartiles.nullable(), notes: strings }).nullable().optional(),
  consensus: z.object({ mean: finite, low: nullable, high: nullable, count: nullable, asOf: date.nullable(), evidenceId: z.string().nullable() }).nullable().optional(),
  trailing: z.object({ ebitda: nullable, da: nullable, interestExpense: nullable }).optional(), forwardYears: finite.optional(),
  methodWeights: z.object({ dcf: weighted.optional(), ev_ebitda_forward: weighted.optional(), pe_forward: weighted.optional() }).nullable().optional(), lifecycle: z.enum(["build", "growth", "mature"]).nullable().optional(),
  management: management.nullable().optional(), periodEnd: date.nullable().optional(),
  scenarioProbabilities: z.object({ bear: probability, base: probability, management: probability, bull: probability }).nullable().optional(), managementComparison: judgement.nullable().optional(),
  consensusNote: z.object({ status: z.enum(["cited", "unavailable"]), source: z.string().nullable(), reason: z.string().nullable() }).nullable().optional(),
});
/** This harness deliberately accepts the FCFF family used for the operating-company replay, not every valuation model. */
const requestSchema = z.object({
  modelType: z.literal("fcff"), currency: z.string(),
  discountRate: z.object({ value: finite, basis: z.enum(["wacc", "cost_of_equity"]), components: z.object({ riskFree: nullable, beta: nullable, equityRiskPremium: nullable, costOfEquity: nullable, costOfDebt: nullable, taxRate: nullable, equityWeight: nullable }), rationale: z.string(), sourceRefs: strings }),
  shares: z.object({ base: finite, dilutionReserve: finite, basis: z.string() }), bridge: z.object({ nonOperatingAssets: finite, debtAndClaims: finite, nonOperatingEquityAdjustment: finite, notes: strings }),
  scenarios: z.object({ bear: scenario, base: scenario, bull: scenario }), price: nullable, midYear: z.boolean().optional(), context: context.optional(),
}) satisfies z.ZodType<CalcRequest>;
const operatingForecast = z.object({ metric: z.string(), periodStart: date, periodEnd: date, value: finite, unit: z.string(), basis: z.string() });
export const historyAssumptionsSchema = z.object({
  schemaVersion: z.literal("valuation-history-assumptions.v1"), kind: z.literal("agent_reconstruction"), ticker: z.string(), cutoff: instant, inputSha256: hash,
  producedAt: instant, model: z.string().min(1), promptSha256: hash, transcriptPath: z.string().min(1), shareBasisFactId: z.string(), request: requestSchema,
  operatingForecasts: z.array(operatingForecast),
});
export type HistoryAssumptions = z.infer<typeof historyAssumptionsSchema>;

/** Values supplied by the Agent cannot replace the frozen market, peer, management or reported-fact context. */
export function historyRequest(input: HistoryInput, artifact: HistoryAssumptions, inputSha256: string): CalcRequest {
  if (artifact.ticker !== input.ticker || artifact.cutoff !== input.cutoff || artifact.inputSha256 !== inputSha256) throw new Error("Agent assumptions do not belong to this frozen input");
  if (input.missing.length) throw new Error(`Historical input incomplete: ${input.missing.join(", ")}`);
  const request = artifact.request;
  if (request.currency !== input.currency) throw new Error("Valuation currency does not match historical input");
  const shares = input.facts.find(f => f.id === artifact.shareBasisFactId && f.unit === "shares");
  if (!shares || request.shares.base !== shares.value) throw new Error("Share base does not match the selected historical fact");
  const allowed = new Set([...input.sources.map(s => s.id), ...input.facts.map(f => f.id)]);
  const cited = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === "evidenceIds" || key === "sourceRefs") && Array.isArray(child)) for (const id of child) if (typeof id !== "string" || !allowed.has(id)) throw new Error(`Unresolved Agent citation: ${String(id)}`);
      if (key === "evidenceId" && child != null && (typeof child !== "string" || !allowed.has(child))) throw new Error(`Unresolved Agent citation: ${String(child)}`);
      cited(child);
    }
  };
  cited(request);
  const value = (id: string) => input.facts.find(f => f.id === id)?.value ?? null;
  if (request.context?.consensus && (!request.context.consensus.asOf || request.context.consensus.asOf > input.cutoff.slice(0, 10) || !request.context.consensus.evidenceId)) throw new Error("Historical consensus needs an eligible dated source");
  if (request.context?.anchor && (request.context.anchor.asOf > input.cutoff.slice(0, 10) || request.context.anchor.total !== value("rpo_total"))) throw new Error("Revenue anchor does not match the historical RPO");
  const peerMultiples = peerMultiplesOf(input.peers, input.cutoff.slice(0, 10), "curated");
  return { ...request, price: input.market.quote.price, context: {
    ...request.context, facts: input.facts.map(f => ({ id: f.id, value: f.value, unit: f.unit })), riskFree: input.market.riskFree.value,
    peers: peerMultiples, management: input.management, periodEnd: input.financialPeriodEnd,
    trailing: { ebitda: value("ebitda_ttm"), da: value("da_ttm"), interestExpense: value("interest_expense_ttm") },
  } };
}

export const historyOutcomeSchema = z.object({
  schemaVersion: z.literal("valuation-history-outcome.v1"), ticker: z.string(), cutoff: instant, inputSha256: hash, evaluationAsOf: instant,
  market: z.array(bar), benchmark: z.array(bar), actuals: z.array(operatingForecast.extend({ availableAt: instant, sourceId: z.string() })),
});
export type HistoryOutcome = z.infer<typeof historyOutcomeSchema>;

/** Evaluate only identical metric periods/bases; partial annual observations never stand in for a full-year forecast. */
export function evaluateHistory(input: HistoryInput, artifact: HistoryAssumptions, outcome: HistoryOutcome, inputSha256: string) {
  if (outcome.ticker !== input.ticker || outcome.cutoff !== input.cutoff || outcome.inputSha256 !== inputSha256) throw new Error("Outcome does not belong to this frozen input");
  const asOf = Date.parse(outcome.evaluationAsOf);
  const operating = artifact.operatingForecasts.map(forecast => {
    const actual = outcome.actuals.filter(a => a.metric === forecast.metric && a.periodStart === forecast.periodStart && a.periodEnd === forecast.periodEnd && a.unit === forecast.unit && a.basis === forecast.basis && Date.parse(a.availableAt) <= asOf).sort((a, b) => a.availableAt.localeCompare(b.availableAt))[0];
    return actual ? { ...forecast, status: "observed", actual: actual.value, error: forecast.value - actual.value, absolutePercentError: actual.value > 0 ? Math.abs(forecast.value / actual.value - 1) : null, sourceId: actual.sourceId } : { ...forecast, status: "pending", reason: "No disclosed actual for the same period and basis at the evaluation cutoff" };
  });
  const market = [1, 3, 6, 12].map(months => {
    const target = new Date(input.cutoff); target.setUTCMonth(target.getUTCMonth() + months);
    const targetDate = target.toISOString().slice(0, 10);
    if (target.getTime() > asOf) return { months, targetDate, status: "pending" };
    const stock = outcome.market.filter(b => b.date <= targetDate && Date.parse(b.closeAt) <= asOf).at(-1);
    if (!stock) return { months, targetDate, status: "pending" };
    const dividends = outcome.market.filter(b => b.date <= stock.date && Date.parse(b.closeAt) > Date.parse(input.cutoff)).reduce((n, b) => n + b.dividend, 0);
    const benchmarkStart = outcome.benchmark.find(b => b.date === input.market.quote.priceDate);
    const benchmarkEnd = outcome.benchmark.filter(b => b.date <= stock.date).at(-1);
    const benchmarkDividends = outcome.benchmark.filter(b => b.date > input.market.quote.priceDate && b.date <= stock.date).reduce((n, b) => n + b.dividend, 0);
    const totalReturn = (stock.close + dividends) / input.market.quote.price - 1;
    const benchmarkReturn = benchmarkStart && benchmarkEnd ? (benchmarkEnd.close + benchmarkDividends) / benchmarkStart.close - 1 : null;
    return { months, targetDate, status: "observed", priceDate: stock.date, price: stock.close, dividends, totalReturn, benchmarkReturn, excessReturn: benchmarkReturn == null ? null : totalReturn - benchmarkReturn };
  });
  return { operating, market, limitations: ["Four reconstructed quarters do not establish accuracy or calibrate probabilities.", "Returns include cash dividends without reinvestment; these are research comparisons, not simulated fills.", "An intrinsic-value estimate is not a 12-month price target."] };
}

export function replayHistory(input: HistoryInput, artifact: HistoryAssumptions, inputSha256: string) {
  const request = historyRequest(input, artifact, inputSha256);
  return { request, result: calculateValuation(request) };
}
