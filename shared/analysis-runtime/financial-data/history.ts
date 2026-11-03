import { z } from "zod";
import { isSecUrl } from "../sec-sources.ts";
import type { BusinessFlowQuarter } from "../../analysis-contract/business-flow.ts";
import type { RevenueHistory, RevenueHistoryQuarter } from "../../analysis-contract/revenue-history.ts";
import { TICKER_PATTERN } from "./policy.ts";
import { daysBetween as days } from "../dates.ts";

/** Eight displayed quarters plus four prior-year comparison quarters. */
const HISTORY_QUARTERS = 12;
const amount = z.string().refine(v => v.trim() !== "" && Number.isFinite(Number(v)));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const secUrl = z.string().refine(isSecUrl);
const lineage = z.array(z.object({accession: z.string().regex(/^\d{10}-\d{2}-\d{6}$/), url: secUrl, concept: z.string().max(300), contextId: z.string().max(500), periodStart: date, periodEnd: date, parserVersion: z.string().max(100), dimensions: z.record(z.string(),z.string())})).max(80);
const leaf = z.object({ id: z.string().min(1).max(200), name: z.string().max(200), value: amount, basis: z.enum(["reported", "derived"]).optional(), formula: z.string().max(500).optional(), lineage: lineage.optional() });
const quarterSchema = z.object({
  periodStart: date, periodEnd: date, currency: z.string().regex(/^[A-Z]{3}$/), scale: z.number().finite().positive(), revenue: amount,
  basis: z.enum(["reported", "derived"]), formula: z.string().max(500).optional(),
  presentation: z.string().max(500).optional(), lineage: lineage.optional(),
  segmentDisclosure: z.literal("single_reportable_segment").optional(),
  segments: z.array(leaf.extend({ children: z.array(leaf).max(40).optional() })).min(1).max(40),
  revenueAdjustments: z.array(leaf).max(20).optional(),
  source: z.object({ accession: z.string().regex(/^\d{10}-\d{2}-\d{6}$/), url: secUrl, filedAt: date, form: z.string().max(12) }),
  dilutedEps: z.object({ value: amount, basis: z.literal("reported"), source: z.object({ accession: z.string().regex(/^\d{10}-\d{2}-\d{6}$/), url: secUrl, filedAt: date, form: z.literal("8-K") }), lineage }).optional(),
  fiscalYear: z.number().int().nullable().optional(),
  fiscalQuarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable().optional(),
  fiscalYearEndMonth: z.number().int().min(1).max(12).nullable().optional(),
  labelSource: z.enum(["xbrl", "derived", "unknown"]).optional(),
});
export const revenueHistorySchema = z.object({ schemaVersion: z.literal("revenue-history.v1"), ticker: z.string().regex(TICKER_PATTERN), updatedAt: z.string(), quarters: z.array(quarterSchema).max(16) });

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.max(Math.abs(a), Math.abs(b)) * 1e-9);

/** A quarter is kept only when it is a three-month period whose disclosed nonnegative businesses add up to revenue. */
export function validHistoryQuarter(q: RevenueHistoryQuarter): boolean {
  if (!quarterSchema.safeParse(q).success) return false;
  const span = days(q.periodStart, q.periodEnd), revenue = Number(q.revenue);
  if (!(span >= 70 && span <= 110) || !(revenue > 0) || new Set(q.segments.map(s => s.id)).size !== q.segments.length) return false;
  if (q.segments.some(s => !(Number(s.value) >= 0)) || !near(q.segments.reduce((sum, s) => sum + Number(s.value), 0)+(q.revenueAdjustments??[]).reduce((sum,a)=>sum+Number(a.value),0), revenue)) return false;
  return q.segments.every(s => !s.children || (s.children.length > 0 && new Set(s.children.map(c => c.id)).size === s.children.length && s.children.every(c => Number(c.value) >= 0) && near(s.children.reduce((sum, c) => sum + Number(c.value), 0), Number(s.value))));
}

/** Projects an extracted flow quarter onto revenue only; children are kept only when they reconcile. */
export function historyQuarterFrom(q: BusinessFlowQuarter, source: RevenueHistoryQuarter["source"]): RevenueHistoryQuarter | null {
  const revenue = q.figures.revenue?.value;
  if (!q.periodStart || revenue == null || !q.segmentsComplete || !q.segments.length || q.segments.some(s => s.revenue?.value == null)) return null;
  const derived = q.figures.revenue!.basis === "derived";
  const candidate: RevenueHistoryQuarter = {
    periodStart: q.periodStart, periodEnd: q.periodEnd, currency: q.currency, scale: q.scale, revenue, basis: derived ? "derived" : "reported",
    ...(q.fiscalQuarter ? {fiscalQuarter:q.fiscalQuarter} : {}),
    ...(derived && q.figures.revenue!.formula ? { formula: q.figures.revenue!.formula } : {}),
    ...(q.figures.revenue!.lineage ? {lineage: q.figures.revenue!.lineage} : {}),
    ...(q.segmentDisclosure ? {segmentDisclosure: q.segmentDisclosure} : {}),
    segments: q.segments.map(s => {
      const children = s.children?.filter(c => c.revenue?.value != null).map(c => ({ id: c.id, name: c.name, value: c.revenue.value!, ...(c.revenue.lineage ? {lineage: c.revenue.lineage} : {}) }));
      const balanced = children?.length && near(children.reduce((sum, c) => sum + Number(c.value), 0), Number(s.revenue!.value));
      return { id: s.id, name: s.name, value: s.revenue!.value!, basis: s.revenue!.basis, formula: s.revenue!.formula, ...(s.revenue!.lineage ? {lineage: s.revenue!.lineage} : {}), ...(balanced ? { children } : {}) };
    }),
    ...(q.revenueAdjustments?.length?{revenueAdjustments:q.revenueAdjustments.map(a=>({id:a.id,name:a.name,value:a.amount.value!,basis:a.amount.basis,formula:a.amount.formula,lineage:a.amount.lineage}))}:{}),
    source,
  };
  return validHistoryQuarter(candidate) ? candidate : null;
}

/** Q4 only: one million reporting-currency units or one basis point (0.01%), whichever
 * is larger. Convert the absolute floor to the stored scale. This is a ranking tolerance,
 * never a relaxation of the exact segment reconciliation gate. */
export function roundingCompatible(a: RevenueHistoryQuarter, b: RevenueHistoryQuarter): boolean {
  return a.currency === b.currency && a.scale === b.scale && a.periodStart === b.periodStart && a.periodEnd === b.periodEnd
    && Math.abs(Number(a.revenue) - Number(b.revenue)) <= Math.max(1_000_000 / a.scale, Math.max(Math.abs(Number(a.revenue)), Math.abs(Number(b.revenue))) * 0.0001);
}
export function reconcileRounding(split: RevenueHistoryQuarter, total: RevenueHistoryQuarter): RevenueHistoryQuarter {
  if (total.basis !== "reported" || Number(split.revenue) === Number(total.revenue)) return split;
  const adjustments = (split.revenueAdjustments ?? []).filter(a => a.id !== "rounding");
  const originalTotal = split.segments.reduce((sum,s)=>sum+Number(s.value),0) + adjustments.reduce((sum,a)=>sum+Number(a.value),0);
  const difference = Number(total.revenue) - originalTotal;
  // Keep the directly reported consolidated total; the split's own provenance remains on its leaves.
  const lineage = [...(total.lineage ?? []), ...(split.lineage ?? []), ...split.segments.flatMap(s => s.lineage ?? []), ...(split.revenueAdjustments ?? []).flatMap(a=>a.lineage??[])];
  if (!lineage.length) return split;
  const result: RevenueHistoryQuarter = {...split, revenue: total.revenue, basis: split.basis, formula: split.basis === "derived" ? `${split.formula ?? "Verified split"}; adjusted to reported revenue ${total.revenue}`.slice(0,500) : undefined,
    lineage: total.lineage, revenueAdjustments: [...adjustments, {
      id: "rounding", name: "Reporting rounding difference", value: String(difference), basis: "derived",
      formula: `Reported revenue ${total.revenue} (${total.source.accession}) − verified split total ${originalTotal} (${split.source.accession}); Q4 reporting rounding tolerance`,
      lineage: [...new Map(lineage.map(l => [JSON.stringify(l), l])).values()].slice(0, 80),
    }]};
  return validHistoryQuarter(result) ? result : split;
}

/** A verified Q4 split beats a rounding-compatible total-only placeholder. Otherwise reported beats derived,
 * and a periodic report (10-Q, 10-K, 20-F, 6-K) beats the earnings release it supersedes;
 * then prefer the newest disclosure, retaining a verified split over an equal-revenue total-only fallback. */
export function mergeHistory(ticker: string, existing: RevenueHistoryQuarter[], incoming: RevenueHistoryQuarter[], updatedAt: string): RevenueHistory {
  const byPeriod = new Map<string, RevenueHistoryQuarter>();
  const rank = (q: RevenueHistoryQuarter) => [(q.basis === "reported" ? 2 : 0) + (q.source.form === "8-K" ? 0 : 1), q.source.filedAt] as const;
  for (const q of alignReleaseSplits([...existing, ...incoming].filter(validHistoryQuarter).map(q => ({...q})))) {
    const old = byPeriod.get(q.periodEnd);
    if (!old) { byPeriod.set(q.periodEnd, q); continue; }
    // EPS is independently reported; keep it even when a periodic split wins the revenue ranking.
    const eps = q.currency === old.currency && q.periodStart === old.periodStart ? (q.dilutedEps && (!old.dilutedEps || q.dilutedEps.source.filedAt >= old.dilutedEps.source.filedAt) ? q.dilutedEps : old.dilutedEps) : undefined;
    if (eps) { q.dilutedEps = eps; old.dilutedEps = eps; }
    const [a, b] = [rank(q), rank(old)];
    const placeholder = (v: RevenueHistoryQuarter) => v.segments.length === 1 && v.segments[0].id === "reported-company-total" && v.segmentDisclosure !== "single_reportable_segment";
    const verifiedSplit = (v: RevenueHistoryQuarter) => v.segments.length > 1 || v.segmentDisclosure === "single_reportable_segment";
    if ((q.basis === "derived" || old.basis === "derived" || q.fiscalQuarter === 4 || old.fiscalQuarter === 4) && q.currency === old.currency && q.scale === old.scale && q.periodStart === old.periodStart && roundingCompatible(q, old)) {
      if (placeholder(q) && verifiedSplit(old)) { byPeriod.set(q.periodEnd, reconcileRounding(old, q)); continue; }
      if (placeholder(old) && verifiedSplit(q)) { byPeriod.set(q.periodEnd, reconcileRounding(q, old)); continue; }
    }
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
  const quarters = [...byPeriod.values()].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).slice(0, HISTORY_QUARTERS).reverse();
  return { schemaVersion: "revenue-history.v1", ticker, updatedAt, quarters };
}

/**
 * A series compares like with like: an earnings release's revenue lines stand only where they name the categories a
 * neighbouring periodic report (the nearest before or after its quarter) splits revenue into. Another split (a release
 * printing products and services beside reports split by segment) reads as the company total, as a release that
 * prints no split does.
 */
function alignReleaseSplits(quarters: RevenueHistoryQuarter[]): RevenueHistoryQuarter[] {
  const names = (q: RevenueHistoryQuarter) => q.segments.map(s => s.name.trim().toLowerCase()).sort().join("|");
  const periodic = quarters.filter(q => q.source.form !== "8-K" && q.segments.length > 1).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  if (!periodic.length) return quarters;
  return quarters.map(q => {
    if (q.source.form !== "8-K" || q.segments.length < 2) return q;
    const before = periodic.filter(p => p.periodEnd <= q.periodEnd).at(-1), after = periodic.find(p => p.periodEnd >= q.periodEnd);
    return [before, after].some(p => p && names(p) === names(q)) ? q
      : { ...q, revenueAdjustments: undefined, segments: [{ id: "reported-company-total", name: "Total company (segment split not yet verified)", value: q.revenue, ...(q.lineage ? { lineage: q.lineage } : {}) }] };
  });
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
