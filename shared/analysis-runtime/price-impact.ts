import { z } from "zod";
import type { ImpactCalculation, PriceImpact, PriceImpactScenario } from "../analysis-contract/price-impact.ts";
import type { ReferenceQuote, ValuationPublication } from "../analysis-contract/valuation.ts";

const number = z.number().finite();
const nonnegative = number.nonnegative();
const maybe = nonnegative.nullable();
const currency = z.string().regex(/^[A-Z]{3}$/);
/** Known zero is accepted; undisclosed values remain null and stop only the dependent calculation. */
export const impactCalculationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interest"), currency, debts: z.array(z.object({ principal: maybe, rateType: z.enum(["fixed", "floating", "refinancing"]), rateChange: number, repricingYears: number.min(0).max(30).nullable() })).min(1) }),
  z.object({ kind: z.literal("equity_financing"), currency, equityValue: number.nullable(), shares: maybe, proceeds: maybe, issuePrice: maybe, fees: maybe, cashDeployed: maybe, acquiredAssetValue: maybe }),
  z.object({ kind: z.literal("cash_gap"), currency, cash: maybe, restrictedCash: maybe, cashInflows: maybe, committedFinancing: maybe, cashOutflows: maybe }),
  z.object({ kind: z.literal("depreciation"), currency, depreciableBasis: maybe, beforeYears: number.positive().nullable(), afterYears: number.positive().nullable() }),
  z.object({ kind: z.literal("contract_reclassification"), currency, reclassifiedAmount: maybe, verifiedRefund: maybe }),
  z.object({ kind: z.literal("revenue_exposure"), currency, revenue: maybe, exposedShare: number.min(0).max(1).nullable(), priceChange: number.min(-1), periodFraction: number.min(0).max(1), exposureBasis: z.enum(["verified_contract", "assumed_sensitivity", "unknown"]) }),
  z.object({ kind: z.literal("capacity_economics"), currency, revenue: maybe, periodYears: number.positive(), capacityMw: number.positive().nullable(), capacityBasis: z.enum(["period_average", "period_end", "unknown"]), gpuPerMw: number.positive().nullable(), utilization: number.positive().max(1).nullable(), comparableGpuMix: z.boolean() }),
  z.object({ kind: z.literal("period_ratio"), currency, numerator: number.nullable(), denominator: number.nullable(), numeratorStart: z.iso.date(), numeratorEnd: z.iso.date(), denominatorStart: z.iso.date(), denominatorEnd: z.iso.date(), numeratorDirection: z.enum(["historical", "forward"]), denominatorDirection: z.enum(["historical", "forward"]) }),
  z.object({ kind: z.literal("price_comparison"), currency, beforeValue: number.nullable(), afterValue: number.nullable(), referencePrice: maybe, latestPrice: maybe }),
]);
export type ImpactCalculationInput = z.infer<typeof impactCalculationSchema>;

/** Saved v1 calculations used prose for this distinction. Keep those results conservative when resumed. */
export function isSensitivityCalculation(result: ImpactCalculation | null | undefined): boolean {
  return !!result && (result.quantificationBasis === "sensitivity_only" || result.limitations.some(note => /^(?:Accounting )?Sensitivity only\b/i.test(note)));
}

/** Deterministic scenario arithmetic, not a prediction, valuation method or source verification. */
export function calculateImpact(input: ImpactCalculationInput): ImpactCalculation {
  const p = impactCalculationSchema.parse(input);
  const quantificationBasis = p.kind === "depreciation" || p.kind === "revenue_exposure" && p.exposureBasis === "assumed_sensitivity" ? "sensitivity_only" : "sourced_inputs";
  const output: ImpactCalculation = { calculatorVersion: "impact.calc.v1", status: "calculated", quantificationBasis, currency: p.currency, values: {}, formulas: {}, missingInputs: [], limitations: [] };
  const missing = (fields: string[]) => { output.missingInputs.push(...fields); output.status = "unavailable"; return output; };
  const put = (name: string, value: number, formula: string) => { if (!Number.isFinite(value)) throw new Error(`Nonfinite ${name}`); output.values[name] = value; output.formulas[name] = formula; };
  if (p.kind === "interest") {
    const absent = p.debts.flatMap((d, i) => d.rateType === "fixed" ? [] : [...(d.principal == null ? [`debts.${i}.principal`] : []), ...(d.repricingYears == null ? [`debts.${i}.repricingYears`] : [])]);
    if (absent.length) return missing(absent);
    put("pretaxInterestChange", p.debts.reduce((sum, d) => sum + (d.rateType === "fixed" ? 0 : d.principal! * d.rateChange * d.repricingYears!), 0), "Σ(repricing principal × rate change × actual repricing years); fixed-rate existing coupons unchanged");
    output.limitations.push("Rate change is an assumption unless supported by a reset/refinancing contract. No EPS or share-price effect without tax, shares and a valuation model.");
  } else if (p.kind === "equity_financing") {
    const absent = ["equityValue", "shares", "proceeds", "issuePrice", "fees", "cashDeployed", "acquiredAssetValue"].filter(k => p[k as keyof typeof p] == null);
    if (absent.length) return missing(absent);
    if (!p.shares || !p.issuePrice) return missing([!p.shares ? "positive shares" : "positive issuePrice"]);
    if (p.fees! > p.proceeds!) throw new Error("Fees exceed financing proceeds");
    const newShares = p.proceeds! / p.issuePrice!;
    put("newShares", newShares, "gross proceeds / issue price");
    put("postFinancingShares", p.shares + newShares, "existing shares + new shares");
    const value = p.equityValue! + p.proceeds! - p.fees! - p.cashDeployed! + p.acquiredAssetValue!;
    put("postFinancingEquityValue", value, "equity value + proceeds − fees − deployed cash + acquired asset value");
    put("postFinancingPerShare", value / (p.shares + newShares), "post-financing equity value / post-financing shares");
    output.limitations.push("Asset value must exclude cash already counted and use the same valuation date. Deployment is not automatically value destruction.");
  } else if (p.kind === "cash_gap") {
    const absent = ["cash", "restrictedCash", "cashInflows", "committedFinancing", "cashOutflows"].filter(k => p[k as keyof typeof p] == null);
    if (absent.length) return missing(absent);
    if (p.restrictedCash! > p.cash!) throw new Error("Restricted cash exceeds total cash");
    put("availableCash", p.cash! - p.restrictedCash!, "cash − restricted cash");
    put("fundingGap", Math.max(0, p.cashOutflows! - (p.cash! - p.restrictedCash!) - p.cashInflows! - p.committedFinancing!), "max(0, outflows − available cash − inflows − committed financing)");
    output.limitations.push("Inputs must share one payment window; aggregate cash coverage does not prove intraperiod liquidity.");
  } else if (p.kind === "depreciation") {
    const absent = ["depreciableBasis", "beforeYears", "afterYears"].filter(k => p[k as keyof typeof p] == null);
    if (absent.length) return missing(absent);
    put("annualDepreciationChange", p.depreciableBasis! / p.afterYears! - p.depreciableBasis! / p.beforeYears!, "depreciable basis / new accounting life − depreciable basis / old accounting life");
    output.limitations.push("Accounting sensitivity only. No cash replacement timing or capital expenditure is inferred from depreciation life.");
  } else if (p.kind === "contract_reclassification") {
    if (p.verifiedRefund == null) return missing(["verified refund obligation and timing; reclassification alone does not establish a cash outflow, lost revenue or cancelled RPO"]);
    put("verifiedCashOutflow", p.verifiedRefund, "verified refund only; no deduction from reclassified balance");
    output.limitations.push("Revenue, RPO and financing effects require their own contract and performance evidence.");
  } else if (p.kind === "revenue_exposure") {
    const absent = [...(p.revenue == null ? ["revenue"] : []), ...(p.exposedShare == null ? ["exposedShare"] : []), ...(p.exposureBasis === "unknown" ? ["contract exposure basis"] : [])];
    if (absent.length) return missing(absent);
    put("revenueChange", p.revenue! * p.exposedShare! * p.priceChange * p.periodFraction, "revenue × exposed share × price change × period fraction");
    output.limitations.push(p.exposureBasis === "assumed_sensitivity" ? "Sensitivity only; exposure is an assumption, not an event forecast." : "Only the evidenced repricing exposure is applied. Spot prices do not reprice all long-term revenue.");
  } else if (p.kind === "capacity_economics") {
    const absent = [...(p.revenue == null ? ["revenue"] : []), ...(p.capacityMw == null ? ["capacityMw"] : []), ...(p.capacityBasis !== "period_average" ? ["period-average active capacity with comparable MW definition"] : [])];
    if (absent.length) return missing(absent);
    put("annualRevenuePerMw", p.revenue! / p.periodYears / p.capacityMw!, "period revenue / years / period-average active MW");
    if (p.gpuPerMw == null || p.utilization == null || !p.comparableGpuMix) output.missingInputs.push("comparable GPU mix, GPU/MW and utilization for implied GPU-hour price");
    else put("impliedGpuHourPrice", output.values.annualRevenuePerMw! / (p.gpuPerMw * p.utilization * 8760), "annual revenue per MW / (GPU per MW × utilization × 8760)");
    output.limitations.push("Capacity and revenue must cover the same operating assets and period; contract value is not recognized revenue.");
  } else if (p.kind === "period_ratio") {
    if (p.numeratorStart !== p.denominatorStart || p.numeratorEnd !== p.denominatorEnd || p.numeratorDirection !== p.denominatorDirection) return missing(["comparable numerator and denominator windows; forward RPO is not historical revenue coverage"]);
    if (p.numerator == null || p.denominator == null || p.denominator === 0) return missing(["known numerator and nonzero denominator"]);
    if (p.numeratorStart > p.numeratorEnd) return missing(["ordered observation window"]);
    put("ratio", p.numerator / p.denominator, "numerator / denominator, identical observation window");
    output.limitations.push("Matching dates do not establish matching accounting or contract definitions; those require source review.");
  } else {
    if (p.afterValue == null) return missing(["afterValue"]);
    if (p.beforeValue != null) {
      put("eventValueChange", p.afterValue - p.beforeValue, "after value − before value");
      if (p.beforeValue > 0) put("eventValueChangeFraction", p.afterValue / p.beforeValue - 1, "after value / before value − 1");
      else output.missingInputs.push("positive beforeValue for event percentage");
    } else output.missingInputs.push("matched before-event model");
    if (p.referencePrice != null && p.referencePrice > 0) {
      put("gapToReference", p.afterValue / p.referencePrice - 1, "after model value / frozen reference price − 1");
      if (p.latestPrice != null) put("marketChangeFraction", p.latestPrice / p.referencePrice - 1, "latest market price / frozen reference price − 1");
    } else output.missingInputs.push("positive frozen referencePrice");
  }
  return output;
}

/** One shock cannot be applied twice to one variable/window via macro and industry paths. */
export function validateImpactChannels(channels: Array<{ shockId: string; financialVariable: string; period: string; exposureId: string; sourceIds: string[] }>): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const c of channels) {
    const key = JSON.stringify([c.shockId, c.financialVariable, c.period, c.exposureId]);
    if (!c.shockId || !c.exposureId || !c.sourceIds.length) errors.push("An impact channel needs an identified shock, exposure and original sources");
    if (seen.has(key)) errors.push(`Duplicate shock channel: ${key}`);
    seen.add(key);
  }
  return errors;
}

/** Invalid cases are never dropped and remaining probabilities never renormalized. */
export function scenarioWeightedValue(cases: Array<{ perShare: number | null; probability: number | null; valid: boolean; evidenceIds: string[] }>): number | null {
  if (!cases.length || cases.some(c => !c.valid || c.perShare == null || !Number.isFinite(c.perShare) || c.probability == null || !Number.isFinite(c.probability) || c.probability < 0 || !c.evidenceIds.length)) return null;
  if (Math.abs(cases.reduce((s, c) => s + c.probability!, 0) - 1) > 1e-6) return null;
  return cases.reduce((s, c) => s + c.perShare! * c.probability!, 0);
}

const usableQuote = (q: ReferenceQuote | null, code: string): q is ReferenceQuote => !!q && q.usable && Number.isFinite(q.price) && q.price > 0 && q.currency === code && /^\d{4}-\d{2}-\d{2}$/.test(q.priceDate) && Number.isFinite(Date.parse(q.priceDate));
/** Reuses published model values, evidence and dates. No model call, fresh calculation or event attribution on a page read. */
export function priceImpactOf(report: ValuationPublication, options: { latestQuote?: ReferenceQuote | null; outdated?: boolean; dependencyStatus?: "valid" | "review_required" | "unavailable" } = {}): PriceImpact {
  const model = report.model;
  const reference = usableQuote(report.quote, report.currency) && report.quote.priceDate <= report.researchAsOf.slice(0, 10) ? report.quote : null;
  const latest = usableQuote(options.latestQuote ?? null, report.currency) && options.latestQuote!.priceDate >= (reference?.priceDate ?? "") ? options.latestQuote! : null;
  const missing = report.gaps.map(g => g.field ? `${g.field}: ${g.message}` : g.message);
  if (options.dependencyStatus && options.dependencyStatus !== "valid") missing.push("adopted public research needs review; dependent quantitative results are suspended");
  if (!reference) missing.push("usable same-currency frozen report quote");
  if (!model) missing.push("validated valuation model");
  if (!model?.shares.economic || model.shares.economic <= 0) missing.push("positive economic share count");
  const identity = {
    schemaVersion: "price-impact.v1" as const, resultId: `price-impact:${report.versionId}`, ticker: report.ticker, reportVersionId: report.versionId,
    financialPeriodEnd: report.financialPeriodEnd, valuationAsOf: report.researchAsOf, generatedAt: report.generatedAt, inputFingerprint: report.baseInputFingerprint,
    calculatorVersion: report.calculatorVersion, currency: report.currency, modelType: model?.modelType ?? null,
    referenceQuote: reference, latestQuote: latest,
    marketChange: reference && latest ? { absolute: latest.price - reference.price, fraction: latest.price / reference.price - 1, fromDate: reference.priceDate, toDate: latest.priceDate } : null,
    eventChange: null,
    eventMissingInputs: ["matched before/after event models with controlled assumptions and attribution evidence"],
    freshnessStatus: options.dependencyStatus && options.dependencyStatus !== "valid" ? "review_required" as const : options.outdated ? "updating" as const : report.reportStatus === "ready" ? "valid" as const : "unavailable" as const,
    missingInputs: missing, counterEvidence: report.sections.counterEvidence, nextChecks: report.sections.nextChecks, evidenceIds: report.evidence.map(e => e.evidenceId),
  };
  const probabilities = model?.scenarioProbabilities ? Object.values(model.scenarioProbabilities).map(p => p.probability) : model ? Object.values(model.scenarios).map(s => s.probability) : [];
  const specifiedProbabilities = probabilities.filter((p): p is number => p != null);
  const invalidProbabilities = specifiedProbabilities.length > 0 && (specifiedProbabilities.length !== probabilities.length || specifiedProbabilities.some(p => !Number.isFinite(p) || p < 0) || Math.abs(specifiedProbabilities.reduce((sum, p) => sum + p, 0) - 1) > 1e-6);
  if (invalidProbabilities) missing.push("valid scenario probabilities summing to one; failed cases cannot be renormalized");
  const invalid = !!options.dependencyStatus && options.dependencyStatus !== "valid" || invalidProbabilities || !Number.isFinite(Date.parse(report.researchAsOf)) || !Number.isFinite(Date.parse(report.generatedAt)) || report.reportStatus !== "ready" || !model || model.currency !== report.currency || !Number.isFinite(model.shares.economic) || model.shares.economic <= 0 || model.verification?.ok === false || model.gates?.some(g => g.status === "fail") || report.gaps.some(g => ["identity_mismatch", "conflicting_sources", "calculation_rejected", "review_incomplete", "unresolved_counter_evidence"].includes(g.code));
  if (invalid || options.outdated) return { ...identity, quantificationStatus: "unavailable", scenarios: [], sensitivities: [], shares: model?.shares.economic ?? null, horizonMonths: model?.forward?.months ?? null };
  const known = new Set([...report.evidence.map(e => e.evidenceId), ...report.facts.map(f => f.id), ...report.diagnostics.map(d => d.key)]);
  const scenarios: PriceImpactScenario[] = [];
  for (const key of ["bear", "base", "bull"] as const) {
    const s = model.scenarios[key];
    const perShare = s.valuation?.perShare ?? s.result.perShare;
    if (!Number.isFinite(perShare) || !s.evidenceIds.length || s.evidenceIds.some(id => !known.has(id))) return { ...identity, freshnessStatus: "review_required", missingInputs: [...missing, `validated ${key} scenario and registered evidence`], quantificationStatus: "unavailable", scenarios: [], sensitivities: [], shares: model.shares.economic, horizonMonths: model.forward?.months ?? null };
    scenarios.push({ key, perShare, gapToReference: reference ? perShare / reference.price - 1 : null, narrative: s.narrative, triggers: s.triggers, invalidation: s.invalidation, evidenceIds: s.evidenceIds });
  }
  return { ...identity, quantificationStatus: "quantified", scenarios, sensitivities: model.sensitivities, shares: model.shares.economic, horizonMonths: model.forward?.months ?? null };
}
