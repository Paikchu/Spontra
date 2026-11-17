import type { ReferenceQuote, ScenarioKey, ValuationModelType } from "./valuation.ts";

/** A projection of one immutable valuation publication. It never implies that a new filing caused its entire value. */
export type PriceImpactIdentity = {
  schemaVersion: "price-impact.v1";
  resultId: string;
  ticker: string;
  reportVersionId: string;
  financialPeriodEnd: string;
  valuationAsOf: string;
  generatedAt: string;
  inputFingerprint: string;
  calculatorVersion: string;
  currency: string;
  modelType: ValuationModelType | null;
  /** The report's original price; later market closes must not replace this denominator. */
  referenceQuote: ReferenceQuote | null;
  latestQuote: ReferenceQuote | null;
  marketChange: { absolute: number; fraction: number; fromDate: string; toDate: string } | null;
  /** An event attribution requires a controlled before/after calculation. A prior report alone is insufficient. */
  eventChange: { absolute: number; fraction: number | null; beforeResultId: string; afterResultId: string; evidenceIds: string[] } | null;
  eventMissingInputs: string[];
  freshnessStatus: "valid" | "updating" | "review_required" | "unavailable";
  missingInputs: string[];
  counterEvidence: string[];
  nextChecks: string[];
  evidenceIds: string[];
};
export type PriceImpactScenario = {
  key: ScenarioKey;
  perShare: number;
  /** Fraction, not percentage points. Null when the frozen quote is unusable. */
  gapToReference: number | null;
  narrative: string;
  triggers: string[];
  invalidation: string[];
  evidenceIds: string[];
};
export type PriceImpact = PriceImpactIdentity & (
  | { quantificationStatus: "quantified"; scenarios: PriceImpactScenario[]; sensitivities: Array<{ factor: string; step: string; perShare: number; changePercent: number }>; shares: number; horizonMonths: number | null }
  | { quantificationStatus: "sensitivity"; scenarios: []; sensitivities: Array<{ factor: string; step: string; perShare: number; changePercent: number }>; shares: number; horizonMonths: number | null }
  | { quantificationStatus: "unavailable"; scenarios: []; sensitivities: []; shares: number | null; horizonMonths: number | null }
);

export type ImpactCalculation = {
  calculatorVersion: "impact.calc.v1";
  status: "calculated" | "unavailable";
  /** Optional only for saved v1 results predating this field; sourced inputs do not establish event attribution. */
  quantificationBasis?: "sourced_inputs" | "sensitivity_only";
  /** All money uses base currency units and shares uses individual shares. No implicit millions conversion. */
  currency: string;
  values: Record<string, number>;
  formulas: Record<string, string>;
  missingInputs: string[];
  limitations: string[];
  /** Present only after typed source/assumption units were checked, never inferred from report prose. */
  provenance?: {
    unitContract: "impact-base-units.v1";
    calculation: Record<string, unknown>;
    inputs: Array<{ path: string; sourceId: string; basis: "fact" | "assumption"; rationale: string; unit: string }>;
  };
};
