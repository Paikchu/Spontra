import { z } from "zod";
import type { PlannedFigures } from "../analysis-contract/business-figures.ts";
import { figureSchema, harnessFigures, harnessLayout, panelPlanSchema } from "./business-narrative.ts";

export const plannedFiguresSchema = z.object({
  schemaVersion: z.literal("business-figures.v1"),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/), generatedAt: z.string().max(40), model: z.string().trim().min(1).max(80), fingerprint: z.string().trim().min(1).max(128),
  company: z.array(figureSchema).max(4),
  businesses: z.array(z.object({ nodeId: z.string().trim().min(1).max(200), figures: z.array(figureSchema).max(4) })).max(24),
  layouts: z.object({ company: panelPlanSchema.nullable(), businesses: z.array(z.object({ nodeId: z.string().trim().min(1).max(200), layout: panelPlanSchema })).max(24), findings: z.array(z.object({ findingId: z.string().trim().min(1).max(80), layout: panelPlanSchema })).max(12).optional() }).optional(),
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
  const count = (nodeId: string) => businesses.find(b => b.nodeId === nodeId)?.figures.length ?? 0;
  const layouts = parsed.data.layouts ? {
    company: harnessLayout(parsed.data.layouts.company, company.length),
    businesses: parsed.data.layouts.businesses.flatMap(b => { const layout = harnessLayout(b.layout, count(b.nodeId)); return layout ? [{ nodeId: b.nodeId, layout }] : []; }),
    // A finding's panels draw on the company's figures.
    findings: (parsed.data.layouts.findings ?? []).flatMap(f => { const layout = harnessLayout(f.layout, company.length); return layout ? [{ findingId: f.findingId, layout }] : []; }),
  } : undefined;
  return company.length || businesses.length || layouts?.company || layouts?.businesses.length || layouts?.findings?.length ? { ...parsed.data, company, businesses, layouts } : null;
}
