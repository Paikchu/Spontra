import type { RevenueHistory, RevenueHistoryQuarter } from "../analysis-contract/revenue-history.ts";

/**
 * Segment bases (B6). A company that re-segments (Microsoft from the quarter to 2026-09-30: Agents and Infra, Devices
 * and Consumer) reports its businesses on a new basis, and its next filings restate the year-ago quarters on it. A
 * quarter's basis is the set of businesses it splits revenue into, compared by name or member id without case, spacing,
 * punctuation, a namespace or a trailing "Member". Two quarters on different bases are never compared business by
 * business; a year-ago quarter restated in the current filing (the revenue history keeps the newest filing's figures for
 * each period) is on the current basis and is the comparison to use. A quarter that only states total revenue has no
 * basis and neither starts nor ends one.
 */

const norm = (text: string) => text.toLowerCase().replace(/&/g, "and").replace(/[^\p{L}\p{N}]/gu, "");
/** "msft:AgentsAndInfraMember" and "filing-agents-and-infra" are the same business. */
export const memberKey = (id: string) => norm(id.split(":").pop()!.replace(/Member$/, "").replace(/^filing-/, ""));
const PLACEHOLDER = new Set(["reported-company-total"]);

type Named = { id: string; name: string };
/** One business of a basis: its name, and its member id, either of which may match. */
const keysOf = (node: Named) => [norm(node.name), memberKey(node.id)];

/** The basis a list of businesses forms; null for a single business or total revenue only. */
export function segmentBasis(segments: readonly Named[]): string | null {
  const real = segments.filter(s => !PLACEHOLDER.has(s.id));
  if (real.length < 2) return null;
  return real.map(s => norm(s.name)).sort().join("|");
}

/** Whether two lists of businesses are the same basis: every business of each matches one of the other by name or member id. */
export function sameBasis(a: readonly Named[], b: readonly Named[]): boolean {
  const left = a.filter(s => !PLACEHOLDER.has(s.id)), right = b.filter(s => !PLACEHOLDER.has(s.id));
  if (left.length < 2 || left.length !== right.length) return false;
  const match = (x: Named, ys: readonly Named[]) => ys.some(y => keysOf(x).some(k => keysOf(y).includes(k)));
  return left.every(x => match(x, right)) && right.every(y => match(y, left));
}

const DAY = 86_400_000;
const near = (a: string, b: string, days: number) => Math.abs(Date.parse(a) - Date.parse(b)) <= days * DAY;
const sorted = (history: RevenueHistory | null) => [...history?.quarters ?? []].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
const hasBasis = (q: RevenueHistoryQuarter) => segmentBasis(q.segments) != null;

/** The latest quarter before `periodEnd` that splits revenue into businesses. */
export function previousSplit(history: RevenueHistory | null, periodEnd: string): RevenueHistoryQuarter | null {
  return sorted(history).filter(q => Date.parse(q.periodEnd) < Date.parse(periodEnd) - 20 * DAY && hasBasis(q)).at(-1) ?? null;
}

/**
 * The quarter's basis changed: the latest earlier quarter that splits revenue is on another basis. Either side without a
 * split, or a quarter the history does not hold, is no change.
 */
export function basisChangedAt(history: RevenueHistory | null, periodEnd: string, segments?: readonly Named[]): boolean {
  const quarter = segments ?? sorted(history).find(q => near(q.periodEnd, periodEnd, 20))?.segments;
  const before = previousSplit(history, periodEnd);
  return !!quarter && segmentBasis(quarter) != null && !!before && !sameBasis(quarter, before.segments);
}

export type RestatedYearAgo = {
  quarter: RevenueHistoryQuarter;
  /** The year-ago figures were restated in the filing that reports the quarter itself. */
  restatedInFiling: boolean;
};

/**
 * The year-ago quarter on the quarter's own basis, from the revenue history: the restated comparative the current filing
 * carries when it does, otherwise the year-ago quarter as filed when it happens to be on the same basis; null when the
 * year-ago quarter is on another basis, in another currency, or not held.
 */
export function yearAgoOnBasis(history: RevenueHistory | null, periodEnd: string, segments: readonly Named[], currency: string, accession: string | null = null): RestatedYearAgo | null {
  const quarters = sorted(history);
  const target = new Date(Date.parse(periodEnd) - 365 * DAY).toISOString().slice(0, 10);
  const yearAgo = quarters.find(q => near(q.periodEnd, target, 20));
  if (!yearAgo || yearAgo.currency !== currency || !sameBasis(segments, yearAgo.segments)) return null;
  const own = accession ?? quarters.find(q => near(q.periodEnd, periodEnd, 20))?.source.accession ?? null;
  return { quarter: yearAgo, restatedInFiling: !!own && yearAgo.source.accession === own };
}

/** A business's revenue in a history quarter, in base currency units; null when it is not there. */
export function businessValue(quarter: RevenueHistoryQuarter, business: Named): number | null {
  const node = quarter.segments.find(s => keysOf(s).some(k => keysOf(business).includes(k)));
  const value = node ? Number(node.value) * quarter.scale : NaN;
  return Number.isFinite(value) ? value : null;
}

/** Each quarter's basis, oldest first, and where it starts: a run begins at a split quarter on another basis than the split before it. */
export function basisRuns(history: RevenueHistory | null): Array<{ periodEnd: string; basis: string | null; starts: boolean }> {
  let last: RevenueHistoryQuarter | null = null;
  return sorted(history).map(q => {
    const basis = segmentBasis(q.segments);
    const starts = basis != null && last != null && !sameBasis(q.segments, last.segments);
    if (basis != null) last = q;
    return { periodEnd: q.periodEnd, basis, starts };
  });
}
