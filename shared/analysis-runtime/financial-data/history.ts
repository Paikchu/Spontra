import { z } from "zod";
import type { BusinessFlowQuarter } from "../../analysis-contract/business-flow.ts";
import type { RevenueHistory, RevenueHistoryQuarter } from "../../analysis-contract/revenue-history.ts";

export const HISTORY_QUARTERS = 8;
const amount = z.string().refine(v => v.trim() !== "" && Number.isFinite(Number(v)));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const secUrl = z.string().refine(v => { try { const u = new URL(v); return u.protocol === "https:" && /(^|\.)sec\.gov$/.test(u.hostname); } catch { return false; } });
const lineage = z.array(z.object({accession: z.string().regex(/^\d{10}-\d{2}-\d{6}$/), url: secUrl, concept: z.string().max(300), contextId: z.string().max(500), periodStart: date, periodEnd: date, parserVersion: z.string().max(100), dimensions: z.record(z.string(),z.string())})).max(80);
const leaf = z.object({ id: z.string().min(1).max(200), name: z.string().max(200), value: amount, lineage: lineage.optional() });
const quarterSchema = z.object({
  periodStart: date, periodEnd: date, currency: z.string().regex(/^[A-Z]{3}$/), scale: z.number().finite().positive(), revenue: amount,
  basis: z.enum(["reported", "derived"]), formula: z.string().max(500).optional(),
  presentation: z.string().max(500).optional(), lineage: lineage.optional(),
  segments: z.array(leaf.extend({ children: z.array(leaf).max(40).optional() })).min(1).max(40),
  source: z.object({ accession: z.string().regex(/^\d{10}-\d{2}-\d{6}$/), url: secUrl, filedAt: date, form: z.string().max(12) }),
});
export const revenueHistorySchema = z.object({ schemaVersion: z.literal("revenue-history.v1"), ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/), updatedAt: z.string(), quarters: z.array(quarterSchema).max(16) });

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.max(Math.abs(a), Math.abs(b)) * 1e-9);
const days = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 86400000;

/** A quarter is kept only when it is a three-month period whose disclosed nonnegative businesses add up to revenue. */
export function validHistoryQuarter(q: RevenueHistoryQuarter): boolean {
  if (!quarterSchema.safeParse(q).success) return false;
  const span = days(q.periodStart, q.periodEnd), revenue = Number(q.revenue);
  if (!(span >= 70 && span <= 110) || !(revenue > 0) || new Set(q.segments.map(s => s.id)).size !== q.segments.length) return false;
  if (q.segments.some(s => !(Number(s.value) >= 0)) || !near(q.segments.reduce((sum, s) => sum + Number(s.value), 0), revenue)) return false;
  return q.segments.every(s => !s.children || (s.children.length > 0 && new Set(s.children.map(c => c.id)).size === s.children.length && s.children.every(c => Number(c.value) >= 0) && near(s.children.reduce((sum, c) => sum + Number(c.value), 0), Number(s.value))));
}

/** Projects an extracted flow quarter onto revenue only; children are kept only when they reconcile. */
export function historyQuarterFrom(q: BusinessFlowQuarter, source: RevenueHistoryQuarter["source"]): RevenueHistoryQuarter | null {
  const revenue = q.figures.revenue?.value;
  if (!q.periodStart || revenue == null || !q.segmentsComplete || !q.segments.length || q.segments.some(s => s.revenue?.value == null)) return null;
  const derived = q.figures.revenue!.basis === "derived";
  const candidate: RevenueHistoryQuarter = {
    periodStart: q.periodStart, periodEnd: q.periodEnd, currency: q.currency, scale: q.scale, revenue, basis: derived ? "derived" : "reported",
    ...(derived && q.figures.revenue!.formula ? { formula: q.figures.revenue!.formula } : {}),
    ...(q.figures.revenue!.lineage ? {lineage: q.figures.revenue!.lineage} : {}),
    segments: q.segments.map(s => {
      const children = s.children?.filter(c => c.revenue?.value != null).map(c => ({ id: c.id, name: c.name, value: c.revenue.value!, ...(c.revenue.lineage ? {lineage: c.revenue.lineage} : {}) }));
      const balanced = children?.length && near(children.reduce((sum, c) => sum + Number(c.value), 0), Number(s.revenue!.value));
      return { id: s.id, name: s.name, value: s.revenue!.value!, ...(s.revenue!.lineage ? {lineage: s.revenue!.lineage} : {}), ...(balanced ? { children } : {}) };
    }),
    source,
  };
  return validHistoryQuarter(candidate) ? candidate : null;
}

/** Reported beats derived; prefer the newest disclosure, retaining a verified split over an equal-revenue total-only fallback. */
export function mergeHistory(ticker: string, existing: RevenueHistoryQuarter[], incoming: RevenueHistoryQuarter[], updatedAt: string): RevenueHistory {
  const byPeriod = new Map<string, RevenueHistoryQuarter>();
  const rank = (q: RevenueHistoryQuarter) => [q.basis === "reported" ? 1 : 0, q.source.filedAt] as const;
  for (const q of [...existing, ...incoming]) {
    if (!validHistoryQuarter(q)) continue;
    const old = byPeriod.get(q.periodEnd);
    if (!old) { byPeriod.set(q.periodEnd, q); continue; }
    const [a, b] = [rank(q), rank(old)];
    if (a[0] === b[0] && q.currency === old.currency && q.scale === old.scale && q.periodStart === old.periodStart && near(Number(q.revenue), Number(old.revenue))) {
      if (q.segments.length === 1 && old.segments.length > 1) continue;
      if (q.segments.length > 1 && old.segments.length === 1) { byPeriod.set(q.periodEnd, q); continue; }
      if (a[1] === b[1]) {
        const detail = (v: RevenueHistoryQuarter) => v.segments.reduce((n, s) => n + (s.children?.length ?? 1), 0);
        if (detail(q) < detail(old)) continue;
      }
    }
    if (a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1])) byPeriod.set(q.periodEnd, q);
  }
  const quarters = [...byPeriod.values()].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).slice(0, 12).reverse();
  return { schemaVersion: "revenue-history.v1", ticker, updatedAt, quarters };
}

/** Public projection: invalid payloads are dropped, never repaired. */
export function readHistory(raw: unknown, ticker: string): RevenueHistory | null {
  const parsed = revenueHistorySchema.safeParse(raw);
  if (!parsed.success || parsed.data.ticker !== ticker) return null;
  const quarters = parsed.data.quarters.filter(validHistoryQuarter).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).slice(-HISTORY_QUARTERS);
  return quarters.length ? { ...parsed.data, quarters } : null;
}

/** Snapshot quarters already passed the complete-flow review, so they anchor the history at the periods the Sankey shows. */
export function historyFromSnapshot(q: BusinessFlowQuarter): RevenueHistoryQuarter | null {
  const lineage = q.figures.revenue?.lineage?.[0];
  if (!lineage || !q.reportedAt) return null;
  return historyQuarterFrom(q, { accession: lineage.accession, url: lineage.url, filedAt: q.reportedAt.slice(0, 10), form: "SEC" });
}
