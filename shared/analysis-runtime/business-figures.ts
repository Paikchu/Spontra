import { z } from "zod";
import type { PlannedFigures } from "../analysis-contract/business-figures.ts";
import { figureSchema, harnessFigures } from "./business-narrative.ts";

export const plannedFiguresSchema = z.object({
  schemaVersion: z.literal("business-figures.v1"),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/), generatedAt: z.string().max(40), model: z.string().trim().min(1).max(80), fingerprint: z.string().trim().min(1).max(128),
  company: z.array(figureSchema).max(4),
  businesses: z.array(z.object({ nodeId: z.string().trim().min(1).max(200), figures: z.array(figureSchema).max(4) })).max(24),
});

/**
 * Parses a plan for one ticker, re-applying the stack harness against the names the caller knows
 * (business names for the company, offering and capability labels per business). A plan with no
 * figure left reads as none.
 */
export function readPlannedFigures(value: unknown, ticker: string, names: { company: Set<string>; business: (nodeId: string) => Set<string> }): PlannedFigures | null {
  const parsed = plannedFiguresSchema.safeParse(value);
  if (!parsed.success || parsed.data.ticker !== ticker) return null;
  const company = harnessFigures(parsed.data.company, names.company);
  const businesses = parsed.data.businesses.map(b => ({ nodeId: b.nodeId, figures: harnessFigures(b.figures, names.business(b.nodeId)) })).filter(b => b.figures.length);
  return company.length || businesses.length ? { ...parsed.data, company, businesses } : null;
}
