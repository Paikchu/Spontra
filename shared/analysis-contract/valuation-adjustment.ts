import type { ReferenceQuote, ScenarioKey } from "./valuation.ts";
export type ValuationAdjustmentFactor = "revenueGrowth" | "operatingMargin" | "discountRate";
export type ValuationAdjustmentInput = { ticker: string; baseVersionId: string; factor: ValuationAdjustmentFactor; delta: number };
/** A reader's private, immutable one-variable sensitivity. This is not reviewed research or an observed event. */
export type ValuationAdjustment = {
  schemaVersion: "valuation-adjustment.v1";
  id: string;
  kind: "hypothetical_sensitivity";
  ticker: string;
  baseVersionId: string;
  calculatorVersion: string;
  createdAt: string;
  researchAsOf: string;
  financialPeriodEnd: string;
  currency: string;
  referenceQuote: ReferenceQuote | null;
  input: ValuationAdjustmentInput;
  method: "fcff_cash_flow_only";
  horizonMonths: number;
  shares: number;
  cases: Array<{ key: ScenarioKey; before: number; after: number; absoluteChange: number; fractionChange: number | null; gapToReference: number | null }>;
  evidenceIds: string[];
  limitations: string[];
};
export type ValuationAdjustmentRead = { status: "available"; result: ValuationAdjustment } | { status: "review_required"; result: null; reason: string };
