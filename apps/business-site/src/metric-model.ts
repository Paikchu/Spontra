import { FUNDAMENTAL_METRIC_CATALOG, FUNDAMENTAL_METRIC_LABEL_ZH } from "@/shared/analysis-contract/fundamental-metric-catalog";
import { getLocale, labels } from "@/packages/web/src/i18n";
import type { FundamentalMetricCategory, FundamentalUnitFamily } from "@/shared/analysis-contract/fundamentals";
import type { BusinessFlowQuarter } from "@/shared/analysis-contract/business-flow";
import type { FindingFundamentals, FindingFundamentalSeries } from "@/shared/analysis-runtime/findings";
import { compareAmount, numeric, previousQuarter, yearAgoQuarter } from "@/packages/web/src/model/business-flow-model";
import { SLOTS, growth, monthEnd, monthIndex, rateTicks } from "./trend-model";

/** The trend's own revenue view, stacked by business from the disclosure history; every other metric is a company-level SEC series. */
export const REVENUE_METRIC = "revenue";
export const OPERATING_INCOME_METRIC = "operating_income";

const GROUP_LABEL = labels<FundamentalMetricCategory>(
  { income_statement: "Income statement", per_share: "Per share", ratio: "Ratios", cash_flow: "Cash flow", balance_sheet: "Balance sheet", valuation: "Valuation" },
  { income_statement: "利润表", per_share: "每股数据", ratio: "比率", cash_flow: "现金流", balance_sheet: "资产负债表", valuation: "估值" });
const GROUPS: FundamentalMetricCategory[] = ["income_statement", "per_share", "ratio", "cash_flow", "balance_sheet", "valuation"];

export type MetricOption = { key: string; label: string };
export type MetricPoint = { periodEnd: string; value: number | null; accession: string | null };
export type MetricTrend = {
  key: string; label: string; unitFamily: FundamentalUnitFamily; currency: string;
  /** Visible quarters, oldest first. */
  points: MetricPoint[];
  /** The visible quarters plus up to four earlier ones, so the first visible quarter still has a year-ago base. */
  history: MetricPoint[];
  comparisons?: Record<1 | 4, Array<number | null>>;
};
type TrendSeries = Pick<FindingFundamentalSeries, "metricKey" | "label" | "unitFamily" | "currency" | "points">;

const catalog = FUNDAMENTAL_METRIC_CATALOG as Record<string, { displaySign: string } | undefined>;
/** A series' name in the reader's language: the catalog's own Chinese label, or the name the series carries. */
const seriesLabel = (series: Pick<FindingFundamentalSeries, "metricKey" | "label">) =>
  getLocale() === "zh-CN" ? (FUNDAMENTAL_METRIC_LABEL_ZH as Record<string, string | undefined>)[series.metricKey] ?? series.label : series.label;

/** Outflows the catalog shows as magnitudes (capex) are drawn as positive amounts, as the original metrics table does. */
function pointValue(series: TrendSeries, raw: string | null): number | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return catalog[series.metricKey]?.displaySign === "outflow_magnitude" ? Math.abs(value) : value;
}

/**
 * Consecutive quarters ending at the series' newest reported value. A period the series does not report is a gap, never zero;
 * the visible run starts at the first reported quarter so a short series gets no leading empty bars.
 */
export function metricTrend(series: TrendSeries, visible = SLOTS): MetricTrend | null {
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
  return { key: series.metricKey, label: seriesLabel(series), unitFamily: series.unitFamily, currency: series.currency, points, history: history.slice(history.length - points.length - 4) };
}

/** The app's operating-income bars use the same published figures and comparison rules as its Sankey. */
export function statementOperatingTrend(quarters: BusinessFlowQuarter[], currency: string): MetricTrend | null {
  const comparable = quarters.filter(quarter => quarter.currency === currency);
  const byEnd = new Map(comparable.map(quarter => [quarter.periodEnd, quarter]));
  const trend = metricTrend({
    metricKey: OPERATING_INCOME_METRIC, label: "Operating income", currency, unitFamily: "currency",
    points: comparable.map(quarter => {
      const amount = quarter.figures.operating;
      const value = numeric(amount);
      return { periodEnd: quarter.periodEnd, valueDecimal: value == null ? null : String(value * quarter.scale),
        sourceAccession: amount?.lineage?.[0]?.accession };
    }),
  });
  if (!trend) return null;
  const changes = (prior: typeof previousQuarter) => trend.points.map(point => {
    const quarter = byEnd.get(point.periodEnd);
    return quarter ? compareAmount(quarter, prior(quarter, quarters), "operating").percent : null;
  });
  return { ...trend, comparisons: { 1: changes(previousQuarter), 4: changes(yearAgoQuarter) } };
}

/** Metrics with at least two reported quarters to compare, grouped as the statements present them. Revenue is the trend's own view. */
/** Lines of other income and expense, read as net income's non-operating composition (non-operating.ts), not charted on their own. */
const COMPONENT_METRICS = new Set(["equity_securities_gains", "nonoperating_interest_income", "nonoperating_interest_expense", "foreign_exchange_gains"]);

export function metricOptions(fundamentals: FindingFundamentals | null, groups: readonly FundamentalMetricCategory[] = GROUPS, operating?: MetricTrend | null): Array<{ group: string; options: MetricOption[] }> {
  // Fundamentals without a quarterly metric (an annual-only XBRL filer) offer none, even with year-end balances attached.
  const series = (fundamentals?.unavailable ? [] : fundamentals?.series ?? []).filter(s => s.available && s.metricKey !== "total_revenue" && !COMPONENT_METRICS.has(s.metricKey) && metricTrend(s));
  return groups
    .map(category => {
      const options: MetricOption[] = series.filter(s => s.category === category).map(s => ({ key: s.metricKey, label: seriesLabel(s) }));
      if (category === "income_statement" && operating && !options.some(option => option.key === operating.key)) {
        options.unshift({ key: operating.key, label: operating.label });
      }
      return { group: GROUP_LABEL[category], options };
    })
    .filter(g => g.options.length);
}

/**
 * The change line: growth for amounts (a base at or below zero has no meaningful growth, so it is a gap), and a
 * percentage-point change for rates, which are already in points. Visible quarters only, aligned with `points`.
 */
export function metricChanges(trend: MetricTrend, lag: 1 | 4): Array<number | null> {
  if (trend.comparisons) return trend.comparisons[lag];
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
