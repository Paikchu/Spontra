import { z } from "zod";
import type { ValuationPublication } from "../../analysis-contract/valuation.ts";
import type { ValuationAdjustment, ValuationAdjustmentInput } from "../../analysis-contract/valuation-adjustment.ts";
import { CALCULATOR_VERSION, scenarioValue } from "./calculator.ts";
import { priceImpactOf } from "../price-impact.ts";

export const valuationAdjustmentInput = z.object({ ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/), baseVersionId: z.string().regex(/^[0-9a-f]{8,64}$/), factor: z.enum(["revenueGrowth", "operatingMargin", "discountRate"]), delta: z.number().finite().min(-0.1).max(0.1).refine(v => v !== 0, "Choose a nonzero change") });
/** Uses the same scenario evaluator as production. Rejects old models whose baseline cannot be reproduced. */
export function calculateValuationAdjustment(report: ValuationPublication, raw: ValuationAdjustmentInput): Omit<ValuationAdjustment, "id" | "createdAt"> {
  const input = valuationAdjustmentInput.parse(raw);
  if (report.ticker !== input.ticker || report.versionId !== input.baseVersionId) throw new Error("Research identity mismatch");
  const model = report.model;
  if (priceImpactOf(report).quantificationStatus !== "quantified" || !model || model.modelType !== "fcff" || model.discountRate.basis !== "wacc") throw new Error("A reviewed, valid FCFF model is required");
  const horizonMonths = model.forward?.months ?? 0;
  const r = model.discountRate.value;
  const beforeRoll = (1 + r) ** (horizonMonths / 12);
  const afterRate = input.factor === "discountRate" ? r + input.delta : r;
  const afterRoll = (1 + afterRate) ** (horizonMonths / 12);
  if (!(afterRate > 0)) throw new Error("Discount rate must remain positive");
  const cases = (["bear", "base", "bull"] as const).map(key => {
    const original = model.scenarios[key];
    if (original.drivers.modelType !== "fcff") throw new Error("Mixed model methods are unavailable");
    const before = scenarioValue(original.drivers, r, model.shares.economic, model.bridge, { midYear: model.midYear }).perShare * beforeRoll;
    const published = original.result.perShare;
    if (Math.abs(before - published) > Math.max(1e-6, Math.abs(published) * 1e-8)) throw new Error("Saved cash-flow baseline cannot be reproduced by this calculator; research must be reviewed before adjustment");
    const changed = structuredClone(original.drivers);
    if (input.factor === "revenueGrowth") changed.path.revenueGrowth = changed.path.revenueGrowth.map(v => v + input.delta);
    if (input.factor === "operatingMargin") changed.path.operatingMargin = changed.path.operatingMargin.map(v => v + input.delta);
    if (changed.path.revenueGrowth.some(v => v <= -1 || v > 10) || changed.path.operatingMargin.some(v => v < -1 || v > 1)) throw new Error("Adjusted operating path is outside valid bounds");
    const after = scenarioValue(changed, afterRate, model.shares.economic, model.bridge, { midYear: model.midYear }).perShare * afterRoll;
    if (![before, after].every(Number.isFinite)) throw new Error("Nonfinite sensitivity result");
    const quote = priceImpactOf(report).referenceQuote;
    return { key, before, after, absoluteChange: after - before, fractionChange: before > 0 ? after / before - 1 : null, gapToReference: quote?.usable && quote.currency === report.currency && quote.price > 0 ? after / quote.price - 1 : null };
  });
  return { schemaVersion: "valuation-adjustment.v1", kind: "hypothetical_sensitivity", ticker: report.ticker, baseVersionId: report.versionId, calculatorVersion: CALCULATOR_VERSION, researchAsOf: report.researchAsOf, financialPeriodEnd: report.financialPeriodEnd, currency: report.currency, referenceQuote: priceImpactOf(report).referenceQuote, input, method: "fcff_cash_flow_only", horizonMonths, shares: model.shares.economic, cases, evidenceIds: [...new Set(Object.values(model.scenarios).flatMap(s => s.evidenceIds))], limitations: ["Reader-selected sensitivity, not a new fact, an observed event or published investment research.", "Cash-flow method only. Peer multiples, method weights and scenario probabilities are not reconstructed or reweighted.", "Only the selected annual driver or discount rate changes. Other cash flows, shares, bridge and quotation date stay fixed.", "Discount-rate changes do not reset existing debt coupons; a financing cash-flow change requires a separate evidenced operating model."] };
}
