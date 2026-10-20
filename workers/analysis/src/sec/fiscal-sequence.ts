import type { SecFiscalPeriod } from "../../../../shared/analysis-contract/report.ts";

/** A reported quarter of one company: the fourth quarter is the fiscal year (a 10-K or 20-F). */
export type FiscalLabel = { fiscalYear: number; quarter: 1 | 2 | 3 | 4; periodEnd: string };

const DAY = 86_400_000;
const QUARTER_DAYS = 365.25 / 4;
const days = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY;
const position = (label: Pick<FiscalLabel, "fiscalYear" | "quarter">) => label.fiscalYear * 4 + label.quarter - 1;

/**
 * An issuer's DEI fiscal year can repeat the year before (Oracle's 10-Q for 2026-08-31 says FY2026 Q1, the label of
 * 2025-08-31, right after its FY2026 10-K), and SEC Company Facts repeats it. Labels must rise with the period end: one
 * that does not is counted on from the label before it by the quarters between their period ends, and takes that
 * year when the quarter it declared is the one reached. Only the year is corrected; a declared quarter that does not
 * fit is left as it is. Labels arrive in any order; the corrected list keeps that order.
 */
export function inFiscalSequence<T extends FiscalLabel>(labels: T[]): T[] {
  const order = labels.map((label, index) => ({ label, index })).sort((a, b) => a.label.periodEnd.localeCompare(b.label.periodEnd));
  const out = [...labels];
  let previous: FiscalLabel | null = null;
  for (const { label, index } of order) {
    let current: T = label;
    if (previous && position(current) <= position(previous)) {
      const reached = position(previous) + Math.round(days(previous.periodEnd, current.periodEnd) / QUARTER_DAYS);
      if (reached > position(previous) && reached % 4 === current.quarter - 1) current = { ...current, fiscalYear: Math.floor(reached / 4) };
    }
    out[index] = current;
    if (!previous || position(current) > position(previous)) previous = current;
  }
  return out;
}

/**
 * The quarter that ends on `periodEnd`, counted on from the newest fiscal year end before it: a foreign issuer's 6-K
 * results carry no DEI focus, and its 20-F's fiscal year is the anchor. Null without an anchor less than a year back.
 */
export function quarterAfterYearEnd(anchors: FiscalLabel[], periodEnd: string): FiscalLabel | null {
  const anchor = anchors.filter(a => a.quarter === 4 && a.periodEnd < periodEnd).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).at(-1);
  if (!anchor) return null;
  const quarters = Math.round(days(anchor.periodEnd, periodEnd) / QUARTER_DAYS);
  if (quarters < 1 || quarters > 4) return null;
  return { fiscalYear: anchor.fiscalYear + 1, quarter: quarters as FiscalLabel["quarter"], periodEnd };
}

/** The DEI focus as a quarter: FY is the fourth; half-year and nine-month foci name no call. */
export function quarterOf(fiscalPeriod: string): FiscalLabel["quarter"] | null {
  if (fiscalPeriod === "FY") return 4;
  const match = /^Q([1-4])$/.exec(fiscalPeriod);
  return match ? Number(match[1]) as FiscalLabel["quarter"] : null;
}

/** SEC fiscal periods with their years put in sequence; half-year and nine-month foci pass through unchanged. */
export function fiscalPeriodsInSequence(periods: SecFiscalPeriod[]): SecFiscalPeriod[] {
  const labelled = periods.flatMap((period, index) => { const quarter = quarterOf(period.fiscalPeriod); return quarter ? [{ fiscalYear: period.fiscalYear, quarter, periodEnd: period.periodEnd, index }] : []; });
  const out = [...periods];
  for (const label of inFiscalSequence(labelled)) out[label.index] = { ...periods[label.index]!, fiscalYear: label.fiscalYear };
  return out;
}
