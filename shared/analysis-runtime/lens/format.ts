import type { FindingRef, FindingSpan } from "../../analysis-contract/findings.ts";
import type { ResolvedValue, ValueUnit } from "../findings.ts";
import { ratioForm } from "../highlights.ts";
import { compactMoney as moneyIn, fiscalYearTo, multiple, perShare, shortPeriod as quarterLabel, type Locale, range } from "../locale.ts";

/**
 * Every figure a lens chart writes. `locale` picks the reader's number forms; left out, the English forms
 * the pipeline has always written, which the harness shows the model.
 */

/** Percentage points after a signed figure: " pp" / "个百分点". */
const pp = (locale: Locale) => locale === "zh-CN" ? "个百分点" : " pp";

/** "$75.7B", "−$28.7B", "$350M", "4.2B EUR" / "757亿美元": the way the stage writes amounts. */
export function compactMoney(value: number, currency: string | null, locale: Locale = "en"): string {
  return moneyIn(value, currency, locale);
}

/** One figure in its unit; a ratio reads as a percentage when it is a margin or an intensity, as "2.60×" otherwise. */
export function formatFigure(value: number, unit: ValueUnit, currency: string | null, ref?: FindingRef, locale: Locale = "en"): string {
  if (unit === "USD") return compactMoney(value, currency, locale);
  if (unit === "percent") return `${Number(value.toFixed(1))}%`;
  if (unit === "points") return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}${pp(locale)}`;
  if (unit === "per_share") return locale === "en" ? `$${value.toFixed(2)}` : perShare(value, "USD", locale);
  if (unit === "ratio") return ref && ratioForm(ref) === "percent" ? `${Number((value * 100).toFixed(1))}%` : multiple(String(Number(value.toFixed(2))), locale);
  return String(Number(value.toFixed(2)));
}

export function formatResolved(v: ResolvedValue, ref?: FindingRef, locale: Locale = "en"): string {
  if (v.range && v.range.low !== v.range.high) return v.unit === "USD" ? range(compactMoney(v.range.low, v.currency, locale), compactMoney(v.range.high, v.currency, locale), locale) : `${v.range.low}–${v.range.high}%`;
  return formatFigure(v.value, v.unit, v.currency, ref, locale);
}

/** A change as the page writes it: "+12.3%" for an amount, "+1.5 pp" for a rate, "+0.25×" for a multiple. */
export function formatDelta(delta: number, unit: ValueUnit, ref?: FindingRef, locale: Locale = "en"): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "", abs = Math.abs(delta);
  if (unit === "percent") return `${sign}${abs.toFixed(1)}${pp(locale)}`;
  if (unit === "ratio") return ref && ratioForm(ref) === "percent" ? `${sign}${(abs * 100).toFixed(1)}${pp(locale)}` : multiple(`${sign}${abs.toFixed(2)}`, locale);
  return `${sign}${abs.toFixed(abs >= 100 ? 0 : 1)}%`;
}

export const shortPeriod = (end: string) => quarterLabel(end);
/** "2026.08" for a quarter, "FY to 2026.08" / "截至 2026.08 财年" for a four-quarter span. */
export const periodLabel = (end: string, span: FindingSpan, locale: Locale = "en") => span === "fiscal_year" ? fiscalYearTo(end, locale) : shortPeriod(end);

/** Tick labels for an axis: amounts compact, rates with the unit, one decimal at most. */
export function tickLabel(value: number, unit: ValueUnit, currency: string | null, ref?: FindingRef, locale: Locale = "en"): string {
  if (unit === "USD") return compactMoney(value, currency, locale);
  if (unit === "ratio" && ref && ratioForm(ref) === "percent") return `${Number((value * 100).toFixed(1))}%`;
  if (unit === "percent") return `${Number(value.toFixed(1))}%`;
  if (unit === "points") return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Number(Math.abs(value).toFixed(1))}${pp(locale)}`;
  return formatFigure(value, unit, currency, ref, locale);
}
