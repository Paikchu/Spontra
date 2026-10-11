import { SEC_FIGURE_METRIC_LABELS } from "@/shared/analysis-runtime/sec-figures.ts";

const MINUS = "−";

export const metricLabel = (metricKey: string) => SEC_FIGURE_METRIC_LABELS[metricKey] ?? metricKey;
export const isCurrency = (unit: string) => /^[A-Z]{3}$/.test(unit);

/** The symbol readers expect for an ISO currency code ("$", "CN¥", "HK$"); the code itself otherwise. */
export function currencySymbol(unit: string): string {
  if (!isCurrency(unit)) return unit;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: unit }).formatToParts(0).find((part) => part.type === "currency")?.value ?? unit;
  } catch {
    return unit;
  }
}

/** A real minus sign; positive values carry an explicit plus when `signed`. */
function sign(value: number, signed: boolean) {
  return value < 0 ? MINUS : signed && value > 0 ? "+" : "";
}

/** Compact magnitude without a sign: 39_300_000_000 → "39.3B", 1.234 → "1.23". */
function scaled(magnitude: number, currency?: string) {
  const large = magnitude >= 1e4;
  const options: Intl.NumberFormatOptions = { notation: large ? "compact" : "standard", maximumFractionDigits: large ? 1 : 2 };
  if (currency) {
    try { return new Intl.NumberFormat("en-US", { ...options, style: "currency", currency }).format(magnitude); } catch { /* not an ISO code */ }
  }
  return new Intl.NumberFormat("en-US", options).format(magnitude);
}

/** A value in its own unit: currency amounts ("$39.3B"), ratios, per-share amounts and share counts. */
export function formatValue(value: number, unit: string, { signed = false, withUnit = true } = {}): string {
  const s = sign(value, signed), magnitude = Math.abs(value);
  if (unit === "ratio") return `${s}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(magnitude * 100)}%`;
  if (/\/shares$/.test(unit)) {
    const currency = unit.split("/")[0];
    const text = withUnit && isCurrency(currency) ? scaledPerShare(magnitude, currency) : magnitude.toFixed(2);
    return `${s}${text}${withUnit && !isCurrency(currency) ? ` ${currency}/share` : ""}`;
  }
  if (unit === "shares") return `${s}${scaled(magnitude)}${withUnit ? " shares" : ""}`;
  if (withUnit && isCurrency(unit)) return `${s}${scaled(magnitude, unit)}`;
  return `${s}${scaled(magnitude)}${withUnit && unit !== "pure" ? ` ${unit}` : ""}`;
}

function scaledPerShare(magnitude: number, currency: string) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(magnitude); } catch { return magnitude.toFixed(2); }
}

/** A relative change as a signed percentage. */
export function formatChange(ratio: number, digits = 1): string {
  return `${sign(ratio, true)}${new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(Math.abs(ratio) * 100)}%`;
}

/** Ratio change in percentage points (0.021 → "+2.1 pp"). */
export function formatPoints(delta: number): string {
  return `${sign(delta, true)}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.abs(delta) * 100)} pp`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Compact period label for axes: 2026-09-27 → Sep '26. */
export const shortPeriod = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1] ?? date.slice(5, 7)} '${date.slice(2, 4)}`;

export const direction = (value: number) => (value > 0 ? "up" : value < 0 ? "down" : "flat");
