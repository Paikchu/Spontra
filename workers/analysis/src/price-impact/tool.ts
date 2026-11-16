import { z } from "zod";
import { calculateImpact, impactCalculationSchema } from "../../../../shared/analysis-runtime/price-impact.ts";
import type { ImpactCalculation } from "../../../../shared/analysis-contract/price-impact.ts";
import { defineTool, type AnyTool } from "../tools/registry.ts";

/** Every numeric leaf is either verified against a registered figure or explicitly identified as a sensitivity assumption. */
const parameters = z.object({
  calculation: impactCalculationSchema,
  inputs: z.array(z.object({ path: z.string().min(1), sourceId: z.string().min(1), basis: z.enum(["fact", "assumption"]), rationale: z.string().min(1) })).min(1),
});
type InputBasis = z.infer<typeof parameters>["inputs"][number];
export function impactCalculationTool<S>(adapter: {
  sourceExists(state: S, id: string): boolean;
  /** Null means the source has no machine-readable number: that leaf must be an explicit assumption. */
  sourceValues(state: S, id: string): readonly number[] | null;
  record(state: S, result: ImpactCalculation, inputs: InputBasis[]): string;
}): AnyTool<S> {
  return defineTool<S>()({
    name: "compute_investment_impact", strict: false,
    description: "Compute financing, cash-gap, capacity or price sensitivity in base currency units and individual shares. Every numeric leaf needs an inputs entry (dot path, sourceId, fact/assumption, rationale); facts must match a registered value, assumptions remain sensitivity. Fixed existing coupons do not reprice; equity financing includes both cash and shares. This does not establish a target price or event attribution.",
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
        const values = adapter.sourceValues(state, input.sourceId);
        if (input.basis === "fact" && !values?.some(n => Math.abs(n - value) <= Math.max(1e-8, Math.abs(n) * 1e-10))) return { observation: `Not accepted: ${path} does not match a registered number. Read a typed source or declare a justified sensitivity assumption.`, error: true };
      }
      if (inputs.some(i => !leaves.some(([path]) => path === i.path))) return { observation: "Not accepted: an input path is not a numeric leaf of this calculation.", error: true };
      const result = calculateImpact(calculation);
      if (inputs.some(i => i.basis === "assumption")) result.limitations.unshift("Sensitivity only: one or more inputs are explicitly assumed. Do not present this calculation as an observed event effect.");
      const id = adapter.record(state, result, inputs);
      return { observation: JSON.stringify({ id, ...result }), error: false };
    },
    observe: (_args, result) => result.observation,
  });
}
