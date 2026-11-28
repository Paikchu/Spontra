import { z } from "zod";
import { calculateImpact, impactCalculationSchema, impactInputUnit, impactUnitIssue, impactValueInUnit, isSensitivityCalculation, type ImpactSourceValue } from "../price-impact-runtime.ts";
import type { ImpactCalculation } from "../price-impact-contract.ts";
import { defineTool, type AnyTool } from "../../../ai/tools/registry.ts";

/** Every numeric leaf is either verified against a registered figure or explicitly identified as a sensitivity assumption. */
const parameters = z.object({
  calculation: impactCalculationSchema,
  inputs: z.array(z.object({ path: z.string().min(1), sourceId: z.string().min(1), basis: z.enum(["fact", "assumption"]), rationale: z.string().min(1), unit: z.string().min(1).optional() })).min(1),
});
type InputBasis = z.infer<typeof parameters>["inputs"][number];
export function impactCalculationTool<S>(adapter: {
  sourceExists(state: S, id: string): boolean;
  /** Null means the source has no machine-readable number: that leaf must be an explicit assumption. */
  sourceValues(state: S, id: string): readonly ImpactSourceValue[] | null;
  /** Derived figures retain their sensitivity classification even when the next tool input is declared a fact. */
  sourceCalculation(state: S, id: string): ImpactCalculation | null;
  record(state: S, result: ImpactCalculation, inputs: InputBasis[]): string;
}): AnyTool<S> {
  return defineTool<S>()({
    name: "compute_investment_impact", strict: false,
    description: "Compute financing, cash-gap, capacity or price sensitivity. All calculation amounts use base currency units (16400 USD millions becomes 16400000000 USD), individual shares and decimal rates (+50bp is 0.005), years and MW. Every numeric leaf needs an inputs entry (dot path, sourceId, fact/assumption, rationale, unit). Use the calculation's base unit in unit; source facts are matched with their typed scale. Assumptions require an explicit unit and remain sensitivity. Fixed existing coupons do not reprice; equity financing includes both cash and shares. This does not establish a target price or event attribution.",
    parameters,
    execute({ calculation, inputs }, { state }) {
      const leaves: Array<[string, number]> = [];
      const walk = (value: unknown, prefix = "") => {
        if (typeof value === "number") leaves.push([prefix, value]);
        else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) walk(child, prefix ? `${prefix}.${key}` : key);
      };
      walk(calculation);
      for (const [path, value] of leaves) {
        const matches = inputs.filter(i => i.path === path);
        if (matches.length !== 1) return { observation: `Not accepted: ${path} needs exactly one declared source or assumption.`, error: true };
        const input = matches[0]!;
        if (!adapter.sourceExists(state, input.sourceId)) return { observation: `Not accepted: ${input.sourceId} has not been read in this session.`, error: true };
        const prior = adapter.sourceCalculation(state, input.sourceId);
        const legacy = impactUnitIssue(prior ? { [input.sourceId]: prior } : undefined, [input.sourceId]);
        if (legacy) return { observation: `Not accepted: ${legacy}`, error: true };
        const unit = impactInputUnit(calculation, path);
        if (input.basis === "assumption" && !input.unit) return { observation: `Not accepted: ${path} is an assumption and needs unit=${unit}. Convert the numeric input to base currency units, individual shares or decimal rates first; +50bp is 0.005 ratio.`, error: true };
        if (input.unit && impactValueInUnit({ value: 1, unit: input.unit }, unit) !== 1) return { observation: `Not accepted: ${path} must be supplied in ${unit}, not ${input.unit}. Convert the number and declare unit=${unit}; do not pass a printed millions/percent figure as a base-unit input.`, error: true };
        const values = adapter.sourceValues(state, input.sourceId);
        const close = (n: number) => Math.abs(n - value) <= Math.max(1e-8, Math.abs(n) * 1e-10);
        const converted = values?.map(source => impactValueInUnit(source, unit)).filter((n): n is number => n !== null) ?? [];
        if (input.basis === "fact" && !converted.some(close)) return { observation: `Not accepted: ${path}=${value} ${unit} does not match a registered figure with compatible units. Source figures: ${JSON.stringify(values)}. Convert the typed source scale (e.g. 16400 USD millions = 16400000000 USD; 50bp = 0.005 ratio), or read a typed source and justify a genuine sensitivity assumption.`, error: true };
        if (input.basis === "assumption" && values?.some(source => close(source.value) && impactValueInUnit(source, unit) !== null && !close(impactValueInUnit(source, unit)!)) && !converted.some(close)) return { observation: `Not accepted: ${path} repeats a source's printed number with a different scale. Source figures: ${JSON.stringify(values)}. Convert to ${unit}; declaring an assumption does not remove the source unit.`, error: true };
      }
      if (inputs.some(i => !leaves.some(([path]) => path === i.path))) return { observation: "Not accepted: an input path is not a numeric leaf of this calculation.", error: true };
      const result = calculateImpact(calculation);
      result.provenance = { unitContract: "impact-base-units.v1", calculation, inputs: inputs.map(input => ({ ...input, unit: impactInputUnit(calculation, input.path) })) };
      if (inputs.some(i => i.basis === "assumption" || isSensitivityCalculation(adapter.sourceCalculation(state, i.sourceId)))) {
        result.quantificationBasis = "sensitivity_only";
        result.limitations.unshift("Sensitivity only: one or more inputs are assumed or derived from a sensitivity. Do not present this calculation as an observed event effect.");
      }
      const id = adapter.record(state, result, inputs);
      return { observation: JSON.stringify({ id, ...result }), error: false };
    },
    observe: (_args, result) => result.observation,
  });
}
