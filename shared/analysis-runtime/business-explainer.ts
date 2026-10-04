import { z } from "zod";
import type { BusinessExplainer } from "../analysis-contract/business-explainer.ts";

const https = z.string().max(2000).refine(v => { try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } });
const text = (max: number) => z.string().trim().min(1).max(max);
const claim = z.object({ text: text(600), sourceIds: z.array(z.string().max(40)).min(1).max(6) });
const explanation = z.object({
  nodeId: text(200), name: text(200), summary: claim,
  howItWorks: claim.nullable(), products: z.array(text(80)).max(10),
  customers: claim.nullable(), monetization: claim.nullable(), relation: claim.nullable(),
});
export const businessExplainerSchema = z.object({
  schemaVersion: z.literal("business-explainer.v1"),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/),
  companyName: text(200), generatedAt: z.string().max(40), model: text(80), fingerprint: text(128),
  businesses: z.array(explanation).min(1).max(24),
  sources: z.array(z.object({ id: text(40), title: text(300), url: https, kind: z.enum(["sec", "web"]), publishedAt: z.string().max(40).nullable() })).min(1).max(40),
});

/**
 * Parses an explainer for one ticker, stripping unknown fields. Every claim must cite only sources
 * listed in the same document; an explanation whose summary has no valid citation is dropped, and
 * a document with nothing left is rejected rather than shown empty.
 */
export function readBusinessExplainer(value: unknown, ticker: string): BusinessExplainer | null {
  const parsed = businessExplainerSchema.safeParse(value);
  if (!parsed.success || parsed.data.ticker !== ticker) return null;
  const ids = new Set(parsed.data.sources.map(s => s.id));
  const valid = (c: { text: string; sourceIds: string[] } | null) => c && c.sourceIds.every(id => ids.has(id)) ? c : null;
  const businesses = parsed.data.businesses.flatMap(b => valid(b.summary) ? [{
    ...b, howItWorks: valid(b.howItWorks), customers: valid(b.customers), monetization: valid(b.monetization), relation: valid(b.relation),
  }] : []);
  return businesses.length ? { ...parsed.data, businesses } : null;
}
