import { FUNDAMENTAL_METRIC_CATALOG } from "@/shared/analysis-contract/fundamental-metric-catalog";
import type { FundamentalMetricCategory, FundamentalUnitFamily } from "@/shared/analysis-contract/fundamentals";
import type { FindingFundamentals, FindingFundamentalSeries } from "@/shared/analysis-runtime/findings";
import { SLOTS, growth, monthEnd, monthIndex, rateTicks } from "./trend-model";

/** The trend's own revenue view, stacked by business from the disclosure history; every other metric is a company-level SEC series. */
export const REVENUE_METRIC = "revenue";

const GROUPS: Array<[FundamentalMetricCategory, string]> = [
  ["income_statement", "利润表"], ["per_share", "每股"], ["ratio", "比率"], ["cash_flow", "现金流"], ["balance_sheet", "资产负债"], ["valuation", "估值"],
];

export type MetricOption = { key: string; label: string };
export type MetricPoint = { periodEnd: string; value: number | null; accession: string | null };
export type MetricTrend = {
  key: string; label: string; unitFamily: FundamentalUnitFamily; currency: string;
  /** Visible quarters, oldest first. */
  points: MetricPoint[];
  /** The visible quarters plus up to four earlier ones, so the first visible quarter still has a year-ago base. */
  history: MetricPoint[];
};

const catalog = FUNDAMENTAL_METRIC_CATALOG as Record<string, { displaySign: string } | undefined>;

/** Outflows the catalog shows as magnitudes (capex) are drawn as positive amounts, as the original metrics table does. */
function pointValue(series: FindingFundamentalSeries, raw: string | null): number | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return catalog[series.metricKey]?.displaySign === "outflow_magnitude" ? Math.abs(value) : value;
}

/**
 * Consecutive quarters ending at the series' newest reported value. A period the series does not report is a gap, never zero;
 * the visible run starts at the first reported quarter so a short series gets no leading empty bars.
 */
export function metricTrend(series: FindingFundamentalSeries, visible = SLOTS): MetricTrend | null {
  const known = series.points
    .map(p => ({ periodEnd: p.periodEnd, value: pointValue(series, p.valueDecimal), accession: p.sourceAccession ?? null }))
    .filter(p => p.value != null)
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const latest = known.at(-1);
  if (!latest) return null;
  const top = monthIndex(latest.periodEnd), count = visible + 4;
  const history = Array.from({ length: count }, (_, i): MetricPoint => {
    const target = top - 3 * (count - 1 - i);
    return known.find(p => Math.abs(monthIndex(p.periodEnd) - target) <= 1) ?? { periodEnd: monthEnd(target), value: null, accession: null };
  });
  const tail = history.slice(-visible);
  const first = tail.findIndex(p => p.value != null);
  const points = tail.slice(first);
  if (points.filter(p => p.value != null).length < 2) return null;
  return { key: series.metricKey, label: series.label, unitFamily: series.unitFamily, currency: series.currency, points, history: history.slice(history.length - points.length - 4) };
}

/** Metrics with at least two reported quarters to compare, grouped as the statements present them. Revenue is the trend's own view. */
export function metricOptions(fundamentals: FindingFundamentals | null): Array<{ group: string; options: MetricOption[] }> {
  const series = (fundamentals?.series ?? []).filter(s => s.available && s.metricKey !== "total_revenue" && metricTrend(s));
  return GROUPS
    .map(([category, group]) => ({ group, options: series.filter(s => s.category === category).map(s => ({ key: s.metricKey, label: s.label })) }))
    .filter(g => g.options.length);
}

/**
 * The change line: growth for amounts (a base at or below zero has no meaningful growth, so it is a gap), and a
 * percentage-point change for rates, which are already in points. Visible quarters only, aligned with `points`.
 */
export function metricChanges(trend: MetricTrend, lag: 1 | 4): Array<number | null> {
  const offset = trend.history.length - trend.points.length;
  return trend.points.map((point, i) => {
    const base = trend.history[offset + i - lag];
    if (!base || point.value == null || base.value == null) return null;
    return trend.unitFamily === "percent" ? point.value - base.value : growth(point.value, base.value);
  });
}

/** Value axis with zero on a gridline, so a loss or negative free cash flow hangs below it rather than being clipped. */
export function metricTicks(trend: MetricTrend): number[] {
  return rateTicks(trend.points.map(p => p.value)) ?? [0, 1, 2, 3];
}
