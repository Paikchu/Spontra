import { SEC_FIGURE_METRIC_LABELS } from "@/shared/analysis-runtime/sec-figures.ts";

const CURRENCY_NAMES: Record<string, string> = { USD: "美元", CNY: "人民币", HKD: "港元", EUR: "欧元", JPY: "日元", GBP: "英镑", CAD: "加元", TWD: "新台币" };
const MINUS = "−";

export const metricLabel = (metricKey: string) => SEC_FIGURE_METRIC_LABELS[metricKey] ?? metricKey;
export const currencyName = (unit: string) => CURRENCY_NAMES[unit] ?? unit;
export const isCurrency = (unit: string) => /^[A-Z]{3}$/.test(unit);

/** A real minus sign; positive values carry an explicit plus when `signed`. */
function sign(value: number, signed: boolean) {
  return value < 0 ? MINUS : signed && value > 0 ? "+" : "";
}

function scaled(value: number) {
  const magnitude = Math.abs(value);
  const [divisor, suffix] = magnitude >= 1e8 ? [1e8, " 亿"] : magnitude >= 1e4 ? [1e4, " 万"] : [1, ""];
  const v = magnitude / divisor;
  const digits = divisor === 1 ? 2 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(v)}${suffix}`;
}

/** A value in its own unit: currency amounts, ratios, per-share amounts and share counts. */
export function formatValue(value: number, unit: string, { signed = false, withUnit = true } = {}): string {
  if (unit === "ratio") return `${sign(value, signed)}${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.abs(value) * 100)}%`;
  if (/\/shares$/.test(unit)) return `${sign(value, signed)}${Math.abs(value).toFixed(2)}${withUnit ? ` ${currencyName(unit.split("/")[0])}/股` : ""}`;
  if (unit === "shares") return `${sign(value, signed)}${scaled(value)}${withUnit ? "股" : ""}`;
  return `${sign(value, signed)}${scaled(value)}${withUnit && isCurrency(unit) ? currencyName(unit) : withUnit && unit !== "pure" ? ` ${unit}` : ""}`;
}

/** A relative change as a signed percentage. */
export function formatChange(ratio: number, digits = 1): string {
  return `${sign(ratio, true)}${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(Math.abs(ratio) * 100)}%`;
}

/** Ratio change in percentage points (0.021 → "+2.1 个百分点"). */
export function formatPoints(delta: number): string {
  return `${sign(delta, true)}${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.abs(delta) * 100)} 个百分点`;
}

/** Compact period label for axes: 2026-09-27 → 26/09. */
export const shortPeriod = (date: string) => `${date.slice(2, 4)}/${date.slice(5, 7)}`;

export const direction = (value: number) => (value > 0 ? "up" : value < 0 ? "down" : "flat");
