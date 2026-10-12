import type { FindingRef, FindingSpan } from "../../analysis-contract/findings.ts";
import type { ResolvedValue, ValueUnit } from "../findings.ts";
import { ratioForm } from "../highlights.ts";

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥" };

/** "$75.7B", "−$28.7B", "$350M", "4.2B EUR": the way the stage writes amounts. */
export function compactMoney(value: number, currency: string | null): string {
  const abs = Math.abs(value);
  const [divisor, suffix] = abs >= 1e12 ? [1e12, "T"] : abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""];
  const digits = abs / divisor >= 100 || !suffix ? 0 : 1;
  const text = (abs / divisor).toFixed(digits) + suffix;
  const symbol = SYMBOL[currency ?? "USD"];
  return (value < 0 ? "−" : "") + (symbol ? symbol + text : `${text} ${currency}`);
}

/** One figure in its unit; a ratio reads as a percentage when it is a margin or an intensity, as "2.60×" otherwise. */
export function formatFigure(value: number, unit: ValueUnit, currency: string | null, ref?: FindingRef): string {
  if (unit === "USD") return compactMoney(value, currency);
  if (unit === "percent") return `${Number(value.toFixed(1))}%`;
  if (unit === "points") return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)} pp`;
  if (unit === "per_share") return `$${value.toFixed(2)}`;
  if (unit === "ratio") return ref && ratioForm(ref) === "percent" ? `${Number((value * 100).toFixed(1))}%` : `${Number(value.toFixed(2))}×`;
  return String(Number(value.toFixed(2)));
}

export function formatResolved(v: ResolvedValue, ref?: FindingRef): string {
  if (v.range && v.range.low !== v.range.high) return v.unit === "USD" ? `${compactMoney(v.range.low, v.currency)}–${compactMoney(v.range.high, v.currency)}` : `${v.range.low}–${v.range.high}%`;
  return formatFigure(v.value, v.unit, v.currency, ref);
}

/** A change as the page writes it: "+12.3%" for an amount, "+1.5 pp" for a rate, "+0.25×" for a multiple. */
export function formatDelta(delta: number, unit: ValueUnit, ref?: FindingRef): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "", abs = Math.abs(delta);
  if (unit === "percent") return `${sign}${abs.toFixed(1)} pp`;
  if (unit === "ratio") return ref && ratioForm(ref) === "percent" ? `${sign}${(abs * 100).toFixed(1)} pp` : `${sign}${abs.toFixed(2)}×`;
  return `${sign}${abs.toFixed(abs >= 100 ? 0 : 1)}%`;
}

export const shortPeriod = (end: string) => end.slice(0, 7).replace("-", ".");
/** "2026.08" for a quarter, "FY to 2026.08" for a four-quarter span. */
export const periodLabel = (end: string, span: FindingSpan) => span === "fiscal_year" ? `FY to ${shortPeriod(end)}` : shortPeriod(end);

/** Tick labels for an axis: amounts compact, rates with the unit, one decimal at most. */
export function tickLabel(value: number, unit: ValueUnit, currency: string | null, ref?: FindingRef): string {
  if (unit === "USD") return compactMoney(value, currency);
  if (unit === "ratio" && ref && ratioForm(ref) === "percent") return `${Number((value * 100).toFixed(1))}%`;
  if (unit === "percent") return `${Number(value.toFixed(1))}%`;
  if (unit === "points") return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Number(Math.abs(value).toFixed(1))} pp`;
  return formatFigure(value, unit, currency, ref);
}
