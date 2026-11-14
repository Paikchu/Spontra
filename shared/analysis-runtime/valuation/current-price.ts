import type { ScenarioValuation, ValuationModelResult } from "../../analysis-contract/valuation.ts";
import { impliedGrowth, valuationRange } from "./calculator.ts";

function methodsAtHorizon<T extends { valuation?: ScenarioValuation }>(entry: T, factor: number): T {
  if (!entry.valuation) return entry;
  const { methods } = entry.valuation;
  const scale = (value: number | null) => value == null ? null : value * factor;
  return { ...entry, valuation: { ...entry.valuation, methods: { dcf: scale(methods.dcf), ev_ebitda_forward: scale(methods.ev_ebitda_forward), pe_forward: scale(methods.pe_forward) } } };
}

/** v10 rolled each scenario's total forward but left its method contributions at present value. */
function methodsOfPublishedModel(model: ValuationModelResult): ValuationModelResult {
  if (model.calculatorVersion !== "valuation.calc.v10" || !model.forward) return model;
  const factor = model.forward.factor, fair = model.fairValueRange;
  return {
    ...model,
    scenarios: { bear: methodsAtHorizon(model.scenarios.bear, factor), base: methodsAtHorizon(model.scenarios.base, factor), bull: methodsAtHorizon(model.scenarios.bull, factor) },
    ...(model.managementScenario ? { managementScenario: methodsAtHorizon(model.managementScenario, factor) } : {}),
    ...(fair?.status === "available" ? { fairValueRange: { ...fair, lower: methodsAtHorizon(fair.lower, factor), upper: methodsAtHorizon(fair.upper, factor) } } : {}),
  };
}

/** Dated price comparisons over the published assumptions; the research values stay frozen. */
export function modelAtReferencePrice(model: ValuationModelResult, price: number | null): ValuationModelResult {
  return {
    ...methodsOfPublishedModel(model),
    range: valuationRange({ bear: model.range.low, base: model.range.base, bull: model.range.high }, model.range.expected, price),
    implied: price != null && model.modelType === "fcff" ? impliedGrowth(model, model.discountRate.value, model.shares.economic, price / (model.forward?.factor ?? 1)) : null,
  };
}
