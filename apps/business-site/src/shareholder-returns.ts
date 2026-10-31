import type { FindingFundamentals, FindingFundamentalSeries } from "@/shared/analysis-runtime/findings";
import { yearEndMonth } from "@/shared/analysis-runtime/fiscal-label";
import type { ValuationResponse } from "@/shared/analysis-contract/valuation";

/**
 * Cash returned to shareholders (R25), from the SEC XBRL series the fundamentals feed carries: share repurchases
 * (PaymentsForRepurchaseOfCommonStock, …OfEquity) and dividends paid (PaymentsOfDividends, …CommonStock, ordinary
 * dividends), over the four quarters ending at the report on the stage and the last three fiscal years. A figure the
 * filings do not tag is undisclosed (null), never zero. Nothing is estimated.
 */

export type ReturnWindow = {
  /** "ttm" for the four quarters, otherwise a fiscal year. */
  kind: "ttm" | "fy";
  periodStart: string | null;
  periodEnd: string;
  /** The fiscal year a twelve-month period closes, by the issuer's own year end. */
  fiscalYear: number | null;
  buybacks: number | null;
  dividends: number | null;
  /** Buybacks plus dividends; null only when neither is disclosed. */
  total: number | null;
  freeCashFlow: number | null;
  /** Total over free cash flow; null when free cash flow is not positive or not disclosed. */
  ofFreeCashFlow: number | null;
  stockCompensation: number | null;
};

export type ReturnQuarter = { periodEnd: string; buybacks: number | null; dividends: number | null };

export type ShareholderReturns = {
  currency: string;
  ttm: ReturnWindow;
  quarters: ReturnQuarter[];
  years: ReturnWindow[];
  /** Total over the market value of the equity, for the four quarters; null without a market value. */
  yield: number | null;
  marketCap: number | null;
};

const series = (f: FindingFundamentals | null | undefined, key: string): FindingFundamentalSeries | null => f?.series.find(s => s.metricKey === key && s.unitFamily === "currency") ?? null;
const num = (v: string | null | undefined) => { if (v == null || v.trim() === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
/** The same period end, allowing for 52/53-week calendars that close a few days either side of a month end. */
const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 20 * 86_400_000;

const pointAt = (s: FindingFundamentalSeries | null, end: string) => { const p = s?.points.find(p => near(p.periodEnd, end)); return p ? num(p.valueDecimal) : null; };
const yearAt = (s: FindingFundamentalSeries | null, end: string) => { const p = s?.annual?.find(p => near(p.periodEnd, end)); return p ? num(p.valueDecimal) : null; };
const sum = (values: Array<number | null>) => values.every(v => v != null) ? values.reduce<number>((t, v) => t + v!, 0) : null;
const plus = (a: number | null, b: number | null) => a == null && b == null ? null : (a ?? 0) + (b ?? 0);
/** Payments are tagged positive; a stray sign is read as the magnitude it describes. */
const paid = (v: number | null) => v == null ? null : Math.abs(v);

/** The fiscal year a twelve-month period ending on `periodEnd` closes: a year closing in a month's first week belongs to the month before. */
export function fiscalYearOf(periodEnd: string): number {
  const month = yearEndMonth(periodEnd), year = Number(periodEnd.slice(0, 4));
  return month === 12 && Number(periodEnd.slice(5, 7)) === 1 ? year - 1 : year;
}

function window(kind: ReturnWindow["kind"], periodStart: string | null, periodEnd: string, buybacks: number | null, dividends: number | null, freeCashFlow: number | null, stockCompensation: number | null): ReturnWindow {
  const total = plus(buybacks, dividends);
  return { kind, periodStart, periodEnd, fiscalYear: kind === "fy" ? fiscalYearOf(periodEnd) : null, buybacks, dividends, total, freeCashFlow,
    ofFreeCashFlow: total != null && freeCashFlow != null && freeCashFlow > 0 ? total / freeCashFlow : null, stockCompensation };
}

/** The market value of the equity, from the valuation report's usable reference close and its share count; null otherwise. */
export function marketCapOf(valuation: ValuationResponse | null | undefined, currency: string): number | null {
  const report = valuation?.availability === "ready" ? valuation.report : null;
  const quote = report?.quote, shares = report?.model?.shares.base;
  if (!quote?.usable || quote.currency !== currency || !(quote.price > 0) || !(shares && shares > 0)) return null;
  return quote.price * shares;
}

/**
 * Shareholder returns at the report ending `periodEnd`: its four quarters (consecutive, each a three-month value) and the
 * three latest fiscal years closed by then. Null when the feed tags neither buybacks nor dividends for the company.
 */
export function shareholderReturns(fundamentals: FindingFundamentals | null | undefined, periodEnd: string, marketCap: number | null = null): ShareholderReturns | null {
  const buybacks = series(fundamentals, "share_repurchases"), dividends = series(fundamentals, "dividends_paid");
  const fcf = series(fundamentals, "free_cash_flow"), sbc = series(fundamentals, "stock_based_compensation");
  if (!buybacks?.available && !dividends?.available && !buybacks?.annual?.length && !dividends?.annual?.length) return null;
  const currency = (buybacks?.available ? buybacks.currency : dividends?.currency) || buybacks?.currency || "USD";
  // The four quarters ending at the report, by calendar position: a quarter the feed lacks is undisclosed, not skipped.
  const top = monthIndex(periodEnd);
  const ends = [3, 2, 1, 0].map(back => {
    const target = top - 3 * back;
    return [buybacks, dividends, fcf, sbc].flatMap(s => s?.points ?? []).find(p => Math.abs(monthIndex(p.periodEnd) - target) <= 1)?.periodEnd ?? null;
  });
  const quarters: ReturnQuarter[] = ends.map((end, i) => end
    ? { periodEnd: end, buybacks: paid(pointAt(buybacks, end)), dividends: paid(pointAt(dividends, end)) }
    : { periodEnd: new Date(Date.UTC(Math.floor((top - 3 * (3 - i)) / 12), (top - 3 * (3 - i)) % 12 + 1, 0)).toISOString().slice(0, 10), buybacks: null, dividends: null });
  const four = (s: FindingFundamentalSeries | null) => sum(ends.map(end => end ? pointAt(s, end) : null));
  const ttm = window("ttm", null, periodEnd, paid(sum(quarters.map(q => q.buybacks))), paid(sum(quarters.map(q => q.dividends))), four(fcf), four(sbc));
  // Fiscal years closed by the report, newest first, from whichever series tags them: a year with free cash flow but no
  // buyback or dividend tag is still one of the last three, its returns undisclosed.
  const yearEnds = [...new Map([buybacks, dividends, fcf].flatMap(s => s?.annual ?? []).filter(p => p.periodEnd <= periodEnd)
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).map(p => [fiscalYearOf(p.periodEnd), p] as const)).values()].slice(0, 3);
  const years = yearEnds.map(p => window("fy", p.periodStart, p.periodEnd, paid(yearAt(buybacks, p.periodEnd)), paid(yearAt(dividends, p.periodEnd)), yearAt(fcf, p.periodEnd), yearAt(sbc, p.periodEnd)));
  return { currency, ttm, quarters, years, marketCap, yield: marketCap && ttm.total != null ? ttm.total / marketCap : null };
}

/**
 * How the buybacks stand against stock pay over the same four quarters, the dilution they offset: "more than" with the
 * multiple, "less than" with the share; null when either is undisclosed.
 */
export function buybacksAgainstStockPay(r: ShareholderReturns): { buybacks: number; stockCompensation: number; ratio: number } | null {
  const { buybacks, stockCompensation } = r.ttm;
  if (buybacks == null || stockCompensation == null || !(stockCompensation > 0)) return null;
  return { buybacks, stockCompensation, ratio: buybacks / stockCompensation };
}
