import { z } from "zod";
import { PRICE_GUIDE_REASONS, type PriceGuideReason, type ValuationPriceGuide } from "../../analysis-contract/price-guide.ts";
import type { ReferenceQuote, ValuationPublication } from "../../analysis-contract/valuation.ts";

export const PRICE_GUIDE_QUOTE_MAX_AGE_DAYS = 7;
const DAY_MS = 86_400_000;
export const referenceQuoteSchema = z.object({
  price: z.number().finite().positive(), currency: z.string(), priceDate: z.iso.date(), source: z.string(), sourceUrl: z.string(),
  fetchedAt: z.string(), usable: z.boolean(), limitations: z.array(z.string()),
});
const priceGuideSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), reportVersionId: z.string(), quote: referenceQuoteSchema, position: z.enum(["below", "within", "above"]), gapToLow: z.number().finite(), gapToBase: z.number().finite(), gapToHigh: z.number().finite(), discountToBase: z.number().finite() }),
  z.object({ status: z.literal("unavailable"), reportVersionId: z.string().nullable(), quote: referenceQuoteSchema.nullable(), reason: z.enum(PRICE_GUIDE_REASONS) }),
]) satisfies z.ZodType<ValuationPriceGuide>;

export function readPriceGuide(value: unknown): ValuationPriceGuide | undefined {
  const parsed = priceGuideSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function priceGuideOf({ report, quote, asOf, outdated = false }: {
  report: ValuationPublication | null; quote: ReferenceQuote | null; asOf: string; outdated?: boolean;
}): ValuationPriceGuide {
  const unavailable = (reason: PriceGuideReason): ValuationPriceGuide => ({ status: "unavailable", reportVersionId: report?.versionId ?? null, quote, reason });
  if (outdated) return unavailable("report_updating");
  const fair = report?.model?.fairValueRange;
  if (!report || !fair || fair.status !== "available") return unavailable("no_range");
  if (report.reportStatus !== "ready") return unavailable("incomplete_research");
  if (report.gaps.some(g => ["identity_mismatch", "conflicting_sources", "calculation_rejected", "review_incomplete", "unresolved_counter_evidence"].includes(g.code)) || report.model?.gates?.some(g => g.status === "fail")) return unavailable("unresolved_evidence");
  const knownIds = new Set([...report.evidence.map(e => e.evidenceId), ...report.facts.map(f => f.id)]);
  const citations = [fair.evidenceIds, fair.lower.evidenceIds, fair.upper.evidenceIds,
    ...[fair.lower, fair.upper].flatMap(c => [c.assumptions.revenue.evidenceIds, c.assumptions.margin.evidenceIds, c.assumptions.capex.evidenceIds])];
  if (citations.some(ids => !ids.length || ids.some(id => !knownIds.has(id))) || ![fair.low, fair.base, fair.high].every(Number.isFinite) || fair.low <= 0 || fair.low > fair.base || fair.base > fair.high) return unavailable("unresolved_evidence");
  if (!quote) return unavailable("no_quote");
  if (quote.currency !== report.currency || quote.currency !== report.model?.currency) return unavailable("currency_mismatch");
  if (!quote.usable || !Number.isFinite(quote.price) || quote.price <= 0) return unavailable("unusable_quote");
  const age = (Date.parse(asOf.slice(0, 10)) - Date.parse(quote.priceDate)) / DAY_MS;
  if (!Number.isFinite(age) || age < 0 || age > PRICE_GUIDE_QUOTE_MAX_AGE_DAYS) return unavailable("stale_quote");
  const price = quote.price;
  return {
    status: "available", reportVersionId: report.versionId, quote,
    position: price < fair.low ? "below" : price > fair.high ? "above" : "within",
    gapToLow: fair.low / price - 1, gapToBase: fair.base / price - 1, gapToHigh: fair.high / price - 1, discountToBase: 1 - price / fair.base,
  };
}
