import type { ReferenceQuote } from "./valuation.ts";

export const PRICE_GUIDE_REASONS = ["no_range", "no_quote", "unusable_quote", "stale_quote", "currency_mismatch", "incomplete_research", "unresolved_evidence", "report_updating", "non_positive_range"] as const;
export type PriceGuideReason = typeof PRICE_GUIDE_REASONS[number];

/** A dated comparison, separate from the immutable research and its stress scenarios. */
export type ValuationPriceGuide =
  | { status: "available"; reportVersionId: string; quote: ReferenceQuote; position: "below" | "within" | "above"; gapToLow: number; gapToBase: number; gapToHigh: number; discountToBase: number }
  | { status: "unavailable"; reportVersionId: string | null; quote: ReferenceQuote | null; reason: PriceGuideReason };
