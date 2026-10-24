import type { FiscalLabelSource, FiscalPeriodFields, FiscalQuarterNumber } from "../analysis-contract/period.ts";
import type { Locale } from "./locale.ts";

/**
 * Fiscal year-end month for each covered issuer, from SEC submissions `fiscalYearEnd`
 * (NBIS omits that field; its 20-F period ends in December). Short names are the ones
 * readers see beside a ticker. A ticker absent from this map has no fiscal quarter.
 */
const ISSUERS: Record<string, { month: number; name: string }> = {
  AAPL: { month: 9, name: "Apple" },
  ADSK: { month: 1, name: "Autodesk" },
  AMZN: { month: 12, name: "Amazon" },
  "BRK.B": { month: 12, name: "Berkshire Hathaway" },
  CRWV: { month: 12, name: "CoreWeave" },
  GOOGL: { month: 12, name: "Alphabet" },
  JPM: { month: 12, name: "JPMorgan Chase" },
  META: { month: 12, name: "Meta" },
  MSFT: { month: 6, name: "Microsoft" },
  NBIS: { month: 12, name: "Nebius" },
  NET: { month: 12, name: "Cloudflare" },
  NVDA: { month: 1, name: "NVIDIA" },
  ORCL: { month: 5, name: "Oracle" },
  SPCX: { month: 12, name: "SpaceX" },
  TSM: { month: 12, name: "TSMC" },
  TTMI: { month: 12, name: "TTM Technologies" },
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const QUARTER_ZH = ["第一季度", "第二季度", "第三季度", "第四季度"];

export type XbrlFocus = { fiscalYear: number; fiscalQuarter: FiscalQuarterNumber };

export type ResolvedPeriod = FiscalPeriodFields & { periodEnd: string; periodStart: string | null };

export type PeriodCopy = ResolvedPeriod & {
  /** "2027 财年 Q2" / "FY27 Q2", or null when the quarter cannot be determined. */
  primary: string | null;
  /** "截至 2026.07.26" / "Ended Jul 26, 2026". */
  secondary: string;
  /** "截至 2026.07" / "Ended Jul 2026". */
  secondaryShort: string;
  /** "截至 2026.06.30 的季度" / "Quarter ended Jun 30, 2026". */
  unknown: string;
  tooltip: string;
  /** True when the fiscal year ends in December, so the fiscal year equals the calendar year. */
  calendarYear: boolean;
  /** Chart badge: "本季度 · 2027 财年 Q2" / "This quarter · FY27 Q2", or the unknown phrase. */
  badge: string;
};

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(value: string): { y: number; m: number; d: number } | null {
  const match = ISO.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

export function companyShortName(ticker: string): string | null {
  return ISSUERS[ticker.trim().toUpperCase()]?.name ?? null;
}

export function fiscalYearEndMonth(ticker: string): number | null {
  return ISSUERS[ticker.trim().toUpperCase()]?.month ?? null;
}

/** Covered issuers whose labels the unit tests lock to the latest filing cover. */
export function coveredFiscalTickers(): string[] {
  return Object.keys(ISSUERS);
}

/** Calendar quarter of a period end (2026-06-30 → "2026 Q2"). Kept for older clients. */
export function calendarLabel(periodEnd: string): string {
  const date = parts(periodEnd);
  if (!date) return periodEnd;
  return `${date.y} Q${Math.ceil(date.m / 3)}`;
}

/**
 * Quarter of `periodEnd` on a fiscal year that ends in `fyEndMonth`.
 * The year is the calendar year when the period ends on or before that month, otherwise the next year.
 * 52/53-week dates stay in the month the company reports them in.
 */
export function deriveFiscalQuarter(periodEnd: string, fyEndMonth: number): { fiscalYear: number; fiscalQuarter: FiscalQuarterNumber } | null {
  const date = parts(periodEnd);
  if (!date || fyEndMonth < 1 || fyEndMonth > 12) return null;
  const startMonth = fyEndMonth === 12 ? 1 : fyEndMonth + 1;
  let delta = date.m - startMonth;
  if (delta < 0) delta += 12;
  const fiscalQuarter = (Math.floor(delta / 3) + 1) as FiscalQuarterNumber;
  if (fiscalQuarter < 1 || fiscalQuarter > 4) return null;
  return { fiscalYear: date.m <= fyEndMonth ? date.y : date.y + 1, fiscalQuarter };
}

/** DEI focus as a numbered quarter. FY is the fourth; half-year and nine-month foci are not quarters. */
export function quarterNumber(fiscalPeriod: string): FiscalQuarterNumber | null {
  if (fiscalPeriod === "FY") return 4;
  const match = /^Q([1-4])$/.exec(fiscalPeriod);
  return match ? Number(match[1]) as FiscalQuarterNumber : null;
}

/**
 * Issuer quarter for one period end. A DEI focus whose quarter matches the fiscal calendar keeps `xbrl`
 * as the source; a year that is off by one (Oracle repeats the prior fiscal year) uses the calendar year.
 * A focus that disagrees on the quarter is ignored. No calendar and no focus is `unknown`.
 */
export function fiscalIdentity(input: { ticker?: string | null; periodEnd: string; xbrl?: XbrlFocus | null }): FiscalPeriodFields {
  const month = input.ticker ? fiscalYearEndMonth(input.ticker) : null;
  const derived = month ? deriveFiscalQuarter(input.periodEnd, month) : null;
  const xbrl = input.xbrl && input.xbrl.fiscalQuarter >= 1 && input.xbrl.fiscalQuarter <= 4 && Number.isInteger(input.xbrl.fiscalYear) ? input.xbrl : null;
  if (derived && xbrl && xbrl.fiscalQuarter === derived.fiscalQuarter && Math.abs(xbrl.fiscalYear - derived.fiscalYear) <= 1) {
    return { fiscalYear: derived.fiscalYear, fiscalQuarter: derived.fiscalQuarter, fiscalYearEndMonth: month, labelSource: "xbrl" };
  }
  if (derived) return { fiscalYear: derived.fiscalYear, fiscalQuarter: derived.fiscalQuarter, fiscalYearEndMonth: month, labelSource: "derived" };
  if (xbrl) return { fiscalYear: xbrl.fiscalYear, fiscalQuarter: xbrl.fiscalQuarter, fiscalYearEndMonth: month, labelSource: "xbrl" };
  return { fiscalYear: null, fiscalQuarter: null, fiscalYearEndMonth: month, labelSource: "unknown" };
}

function validQuarter(value: number | null | undefined): FiscalQuarterNumber | null {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : null;
}

/**
 * Use a stamped identity when the source is explicit. `unknown` stays unknown.
 * Fields left off an older payload are derived from the issuer calendar.
 */
export function resolvePeriod(input: {
  ticker?: string | null;
  periodEnd: string;
  periodStart?: string | null;
  fiscalYear?: number | null;
  fiscalQuarter?: number | null;
  fiscalYearEndMonth?: number | null;
  labelSource?: FiscalLabelSource | null;
}): ResolvedPeriod {
  const quarter = validQuarter(input.fiscalQuarter);
  const year = typeof input.fiscalYear === "number" && Number.isInteger(input.fiscalYear) ? input.fiscalYear : null;
  const stampedMonth = typeof input.fiscalYearEndMonth === "number" && input.fiscalYearEndMonth >= 1 && input.fiscalYearEndMonth <= 12 ? input.fiscalYearEndMonth : null;
  let fields: FiscalPeriodFields;
  if (input.labelSource === "unknown") fields = { fiscalYear: null, fiscalQuarter: null, fiscalYearEndMonth: stampedMonth, labelSource: "unknown" };
  else if ((input.labelSource === "xbrl" || input.labelSource === "derived") && year != null && quarter) {
    fields = { fiscalYear: year, fiscalQuarter: quarter, fiscalYearEndMonth: stampedMonth ?? (input.ticker ? fiscalYearEndMonth(input.ticker) : null), labelSource: input.labelSource };
  } else fields = fiscalIdentity({ ticker: input.ticker, periodEnd: input.periodEnd });
  return { ...fields, periodEnd: input.periodEnd, periodStart: input.periodStart ?? null };
}

function dot(periodEnd: string): string {
  return periodEnd.replaceAll("-", ".");
}

function enLong(periodEnd: string): string {
  const date = parts(periodEnd);
  if (!date) return periodEnd;
  return `${MONTHS_SHORT[date.m - 1]} ${date.d}, ${date.y}`;
}

function enMonth(periodEnd: string): string {
  const date = parts(periodEnd);
  if (!date) return periodEnd;
  return `${MONTHS_SHORT[date.m - 1]} ${date.y}`;
}

function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

function zhSpan(start: string | null, end: string): string {
  const close = parts(end);
  if (!close) return `本季截至 ${end}`;
  const open = start ? parts(start) : null;
  if (!open) return `本季截至 ${close.y} 年 ${close.m} 月 ${close.d} 日`;
  if (open.y === close.y) return `本季覆盖 ${open.y} 年 ${open.m} 月 ${open.d} 日至 ${close.m} 月 ${close.d} 日`;
  return `本季覆盖 ${open.y} 年 ${open.m} 月 ${open.d} 日至 ${close.y} 年 ${close.m} 月 ${close.d} 日`;
}

function enSpan(start: string | null, end: string): string {
  const close = parts(end);
  if (!close) return `This quarter ended ${end}`;
  const open = start ? parts(start) : null;
  if (!open) return `This quarter ended ${enLong(end)}`;
  const right = `${MONTHS_SHORT[close.m - 1]} ${close.d}, ${close.y}`;
  const left = open.y === close.y ? `${MONTHS_SHORT[open.m - 1]} ${open.d}` : `${MONTHS_SHORT[open.m - 1]} ${open.d}, ${open.y}`;
  return `This quarter runs ${left} to ${right}`;
}

/**
 * The one label function for the site. Pass a stamped period or just ticker + period end.
 * `companyName` overrides the short name in the tooltip.
 */
export function periodLabel(input: {
  ticker?: string | null;
  periodEnd: string;
  periodStart?: string | null;
  fiscalYear?: number | null;
  fiscalQuarter?: number | null;
  fiscalYearEndMonth?: number | null;
  labelSource?: FiscalLabelSource | null;
  companyName?: string | null;
}, locale: Locale = "en"): PeriodCopy {
  const resolved = resolvePeriod(input);
  const zh = locale === "zh-CN";
  const name = input.companyName?.trim() || companyShortName(input.ticker ?? "") || input.ticker?.trim() || "";
  const secondary = zh ? `截至 ${dot(resolved.periodEnd)}` : `Ended ${enLong(resolved.periodEnd)}`;
  const secondaryShort = zh ? `截至 ${dot(resolved.periodEnd).slice(0, 7)}` : `Ended ${enMonth(resolved.periodEnd)}`;
  const unknown = zh ? `截至 ${dot(resolved.periodEnd)} 的季度` : `Quarter ended ${enLong(resolved.periodEnd)}`;
  if (resolved.labelSource === "unknown" || resolved.fiscalYear == null || resolved.fiscalQuarter == null) {
    return { ...resolved, primary: null, secondary, secondaryShort, unknown, tooltip: unknown, calendarYear: false, badge: unknown };
  }
  const yy = String(resolved.fiscalYear).slice(-2);
  const primary = zh ? `${resolved.fiscalYear} 财年 Q${resolved.fiscalQuarter}` : `FY${yy} Q${resolved.fiscalQuarter}`;
  const calendarYear = resolved.fiscalYearEndMonth === 12;
  const tooltip = calendarYear
    ? (zh ? `${name} 的财年与自然年一致。` : `${possessive(name)} fiscal year matches the calendar year.`)
    : (zh
      ? `${name} 的财年在 ${resolved.fiscalYearEndMonth} 月结束。${zhSpan(resolved.periodStart, resolved.periodEnd)}，即公司财报中的 ${resolved.fiscalYear} 财年${QUARTER_ZH[resolved.fiscalQuarter - 1]}。`
      : `${possessive(name)} fiscal year ends in ${MONTHS[(resolved.fiscalYearEndMonth ?? 1) - 1]}. ${enSpan(resolved.periodStart, resolved.periodEnd)}, reported as Q${resolved.fiscalQuarter} of fiscal ${resolved.fiscalYear}.`);
  const badge = zh ? `本季度 · ${primary}` : `This quarter · ${primary}`;
  return { ...resolved, primary, secondary, secondaryShort, unknown, tooltip, calendarYear, badge };
}
