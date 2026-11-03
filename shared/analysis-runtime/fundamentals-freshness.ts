/**
 * Whether the SEC fundamentals keep up with the page (B9). The page's latest quarter comes from the published statements
 * (read from the filing itself); the fundamentals from Company Facts, which SEC can fill a day or more after the filing.
 * Fundamentals are behind when the latest quarter any income-statement or cash-flow series has a value for ends more
 * than 20 days (a 52/53-week calendar) before the page's latest quarter. Balance-sheet series do not count: a year-end
 * balance copied from an annual report says nothing about the quarters.
 */

type Point = { periodEnd: string; valueDecimal: string | null };
type Series = { category: string; points: readonly Point[] };

const FLOWS = new Set(["income_statement", "cash_flow"]);
const DAY = 86_400_000;

/** The latest quarter an income-statement or cash-flow series reports a value for; null when none does. */
export function latestFundamentalsQuarter(series: readonly Series[]): string | null {
  let latest: string | null = null;
  for (const s of series) if (FLOWS.has(s.category)) for (const p of s.points) if (p.valueDecimal != null && (!latest || p.periodEnd > latest)) latest = p.periodEnd;
  return latest;
}

/** The fundamentals end before the page's latest quarter (or have no quarter at all while the page has one). */
export function fundamentalsBehind(fundamentalsQuarter: string | null, pageQuarter: string | null): boolean {
  if (!pageQuarter) return false;
  return !fundamentalsQuarter || Date.parse(fundamentalsQuarter) < Date.parse(pageQuarter) - 20 * DAY;
}
