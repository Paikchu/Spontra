import { z } from "zod";
import type { Locale } from "./locale.ts";

/**
 * Report figures the application draws from validated XBRL. Spontra Analysis builds every instance
 * before writing; the model only places an existing `figureKey` beside its argument and writes the
 * title and caption. Values never come from the model.
 */
export const SEC_FIGURE_KINDS = ["kpi_strip", "growth", "margin_ladder", "profit_flow", "per_hundred", "cash_bridge", "cash_debt", "share_count"] as const;
export type SecFigureKind = typeof SEC_FIGURE_KINDS[number];

/** What each kind can answer. Shown to the writer and reviewer next to every available instance. */
export const SEC_FIGURE_CATALOG: Record<SecFigureKind, { label: string; answers: string; limits: string }> = {
  kpi_strip: { label: "Key figures", answers: "2–4 verified headline numbers for the period, their change from the prior-year period and the recent trend", limits: "Shows the numbers only; does not explain causes" },
  growth: { label: "Revenue and YoY growth", answers: "Revenue scale over time and whether year-over-year growth is accelerating or slowing", limits: "Total revenue cannot prove segment, customer or pricing changes" },
  margin_ladder: { label: "Margin ladder", answers: "How gross, operating and net margin each changed, and whether profitability improved", limits: "The narrative and evidence must explain why margins changed" },
  profit_flow: { label: "Revenue to net income", answers: "How much net income remains after cost of revenue, operating expenses, and taxes and other items", limits: "Breaks down only to income statement lines; no segment or expense detail" },
  per_hundred: { label: "Where each $100 of revenue goes", answers: "$100 of revenue split into cost of revenue, operating expenses, taxes and other, and net income, compared with the prior-year period", limits: "A change in mix alone cannot prove pricing or cost-efficiency causes" },
  cash_bridge: { label: "Net income to free cash flow", answers: "Net income adjusted for working capital and other items to operating cash flow, then less capital expenditures to free cash flow", limits: "Working capital adjustments are a total; no split by inventory, receivables or other items" },
  cash_debt: { label: "Cash and long-term debt", answers: "Size and trend of cash and long-term debt, and net cash or net debt", limits: "Excludes leases, short-term borrowings and other liabilities" },
  share_count: { label: "Share count", answers: "Whether the share count is rising (dilution) or falling (buybacks)", limits: "Does not separate buybacks from stock-based compensation" },
};

export const SEC_FIGURE_METRIC_LABELS: Record<string, string> = {
  revenue: "Revenue", gross_profit: "Gross profit", gross_margin: "Gross margin", operating_income: "Operating income", operating_margin: "Operating margin",
  net_income: "Net income", net_margin: "Net margin", diluted_eps: "Diluted EPS", operating_cash_flow: "Operating cash flow", capex: "Capital expenditures",
  free_cash_flow: "Free cash flow", cash: "Cash and equivalents", debt: "Long-term debt", shares: "Shares outstanding",
};

/** Reader-facing names in Chinese, beside the English Spontra Analysis shows the writer. */
const SEC_FIGURE_LABELS_ZH: Record<SecFigureKind, string> = {
  kpi_strip: "关键数据", growth: "营收与同比增长", margin_ladder: "利润率阶梯", profit_flow: "营收到净利润",
  per_hundred: "每 100 美元营收的去向", cash_bridge: "净利润到自由现金流", cash_debt: "现金与长期债务", share_count: "股数",
};
const SEC_FIGURE_METRIC_LABELS_ZH: Record<string, string> = {
  revenue: "营收", gross_profit: "毛利", gross_margin: "毛利率", operating_income: "营业利润", operating_margin: "营业利润率",
  net_income: "净利润", net_margin: "净利率", diluted_eps: "稀释每股收益", operating_cash_flow: "经营现金流", capex: "资本开支",
  free_cash_flow: "自由现金流", cash: "现金及等价物", debt: "长期债务", shares: "流通股数",
};

/** A figure kind's name for the reader. */
export const secFigureLabel = (kind: SecFigureKind, locale: Locale = "en"): string =>
  locale === "zh-CN" ? SEC_FIGURE_LABELS_ZH[kind] : SEC_FIGURE_CATALOG[kind].label;
/** A figure metric's name for the reader; undefined for a key outside the catalog. */
export const secFigureMetricLabel = (metricKey: string, locale: Locale = "en"): string | undefined =>
  (locale === "zh-CN" ? SEC_FIGURE_METRIC_LABELS_ZH : SEC_FIGURE_METRIC_LABELS)[metricKey];

const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => Number.isFinite(Date.parse(value)), "Invalid date");
const accession = z.string().min(1).max(40);
const amount = z.number();
const point = z.strictObject({ date: day, value: amount, accession });
const series = z.strictObject({
  metricKey: z.string().min(1).max(120), unit: z.string().min(1).max(24), basis: z.string().min(1).max(24),
  points: z.array(point).min(2).max(12),
}).refine((value) => value.points.every((p, i) => i === 0 || value.points[i - 1].date < p.date), "Points must be unique and ascending");
const income = z.strictObject({
  date: day, currency: z.string().regex(/^[A-Z]{3}$/),
  revenue: amount, grossProfit: amount, operatingIncome: amount, netIncome: amount,
  accessions: z.array(accession).min(1).max(8),
});
const base = { figureKey: id, periodScope: z.enum(["quarter", "annual"]), periodEnd: day };

export const SEC_FIGURE_SCHEMA = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("kpi_strip"), series: z.array(series).min(2).max(4) }),
  z.strictObject({ ...base, kind: z.literal("growth"), revenue: series }),
  z.strictObject({ ...base, kind: z.literal("margin_ladder"), series: z.array(series).min(2).max(3) }),
  z.strictObject({ ...base, kind: z.literal("profit_flow"), current: income }),
  z.strictObject({ ...base, kind: z.literal("per_hundred"), current: income, prior: income }),
  z.strictObject({ ...base, kind: z.literal("cash_bridge"), currency: z.string().regex(/^[A-Z]{3}$/),
    netIncome: amount.optional(), operatingCashFlow: amount, capex: amount, freeCashFlow: amount, accessions: z.array(accession).min(1).max(8) }),
  z.strictObject({ ...base, kind: z.literal("cash_debt"), cash: series, debt: series }),
  z.strictObject({ ...base, kind: z.literal("share_count"), shares: series }),
]);

export type SecFigure = z.infer<typeof SEC_FIGURE_SCHEMA>;
export type SecFigureSeries = z.infer<typeof series>;
export type SecFigurePoint = z.infer<typeof point>;
export type SecIncomeSnapshot = z.infer<typeof income>;

/** Stored snapshots are re-validated at render time; damaged ones are skipped, never drawn. */
export function readableSecFigure(value: unknown): SecFigure | null {
  const parsed = SEC_FIGURE_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const DAY = 86_400_000;
/** The comparable observation one year earlier (fiscal calendars drift by a few days). */
export function yearAgoPoint(points: readonly SecFigurePoint[], index: number): SecFigurePoint | undefined {
  const current = Date.parse(points[index]?.date ?? "");
  return points.slice(0, index).reverse().find((p) => Math.abs((current - Date.parse(p.date)) / DAY - 365) <= 21);
}

/** Change of the latest point against the same period last year, else against the prior period. */
export function latestChange(value: SecFigureSeries): { basis: "yoy" | "prior"; prior: SecFigurePoint; current: SecFigurePoint; delta: number; ratio?: number } {
  const index = value.points.length - 1;
  const current = value.points[index];
  const yoy = yearAgoPoint(value.points, index);
  const prior = yoy ?? value.points[index - 1];
  const delta = current.value - prior.value;
  return { basis: yoy ? "yoy" : "prior", prior, current, delta, ...(prior.value > 0 ? { ratio: delta / prior.value } : {}) };
}

/** Year-over-year growth for each point that has a comparable year-ago observation. */
export function yoyGrowth(value: SecFigureSeries): Array<{ date: string; growth: number }> {
  return value.points.flatMap((p, i) => {
    const prior = yearAgoPoint(value.points, i);
    return prior && prior.value > 0 ? [{ date: p.date, growth: (p.value - prior.value) / prior.value }] : [];
  });
}

export type IncomeParts = { cost: number; operatingExpenses: number; taxAndOther: number; netIncome: number };
/** Income statement layers. Null when a layer is negative and cannot be drawn as a share of revenue. */
export function incomeParts(snapshot: SecIncomeSnapshot): IncomeParts | null {
  const parts = {
    cost: snapshot.revenue - snapshot.grossProfit,
    operatingExpenses: snapshot.grossProfit - snapshot.operatingIncome,
    taxAndOther: snapshot.operatingIncome - snapshot.netIncome,
    netIncome: snapshot.netIncome,
  };
  return snapshot.revenue > 0 && Object.values(parts).every((v) => Number.isFinite(v) && v >= 0) ? parts : null;
}

/** Whole-number shares of 100 that always add to 100 (largest remainder). */
export function perHundred(snapshot: SecIncomeSnapshot): IncomeParts | null {
  const parts = incomeParts(snapshot);
  if (!parts) return null;
  const keys = Object.keys(parts) as Array<keyof IncomeParts>;
  const raw = keys.map((key) => parts[key] / snapshot.revenue * 100);
  const floors = raw.map(Math.floor);
  let rest = 100 - floors.reduce((sum, v) => sum + v, 0);
  for (const index of raw.map((v, i) => [v - floors[i], i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) {
    if (rest <= 0) break;
    floors[index] += 1; rest -= 1;
  }
  return Object.fromEntries(keys.map((key, i) => [key, floors[i]])) as IncomeParts;
}

export type CashBridgeStep = { key: string; label: string; value: number; kind: "total" | "change"; start: number; end: number };
const CASH_BRIDGE_LABELS: Record<Locale, Record<"net_income" | "adjustments" | "operating_cash_flow" | "capex" | "free_cash_flow", string>> = {
  en: { net_income: "Net income", adjustments: "Non-cash and working capital", operating_cash_flow: "Operating cash flow", capex: "Capital expenditures", free_cash_flow: "Free cash flow" },
  "zh-CN": { net_income: "净利润", adjustments: "非现金项目与营运资本", operating_cash_flow: "经营现金流", capex: "资本开支", free_cash_flow: "自由现金流" },
};
export function cashBridgeSteps(figure: Extract<SecFigure, { kind: "cash_bridge" }>, locale: Locale = "en"): CashBridgeStep[] {
  const label = CASH_BRIDGE_LABELS[locale];
  const steps: CashBridgeStep[] = [];
  if (figure.netIncome !== undefined) {
    steps.push({ key: "net_income", label: label.net_income, value: figure.netIncome, kind: "total", start: 0, end: figure.netIncome });
    const adjustment = figure.operatingCashFlow - figure.netIncome;
    steps.push({ key: "adjustments", label: label.adjustments, value: adjustment, kind: "change", start: figure.netIncome, end: figure.operatingCashFlow });
  }
  steps.push({ key: "operating_cash_flow", label: label.operating_cash_flow, value: figure.operatingCashFlow, kind: "total", start: 0, end: figure.operatingCashFlow });
  steps.push({ key: "capex", label: label.capex, value: -figure.capex, kind: "change", start: figure.operatingCashFlow, end: figure.operatingCashFlow - figure.capex });
  steps.push({ key: "free_cash_flow", label: label.free_cash_flow, value: figure.freeCashFlow, kind: "total", start: 0, end: figure.freeCashFlow });
  return steps;
}

const round = (value: number, digits = 4) => Number(value.toPrecision(digits));
/** Computed facts the writer may cite in captions; the reviewer checks text against the same numbers. */
export function summarizeSecFigure(figure: SecFigure): Record<string, unknown> {
  const latest = (s: SecFigureSeries) => ({ metricKey: s.metricKey, unit: s.unit, ...latestChangeSummary(s) });
  switch (figure.kind) {
    case "kpi_strip": return { metrics: figure.series.map(latest) };
    case "growth": return { latest: latest(figure.revenue), yoyGrowth: yoyGrowth(figure.revenue).map((g) => ({ date: g.date, growth: round(g.growth) })) };
    case "margin_ladder": case "cash_debt": case "share_count": {
      const list = figure.kind === "margin_ladder" ? figure.series : figure.kind === "cash_debt" ? [figure.cash, figure.debt] : [figure.shares];
      return { series: list.map(latest), ...(figure.kind === "cash_debt" ? { netCash: round(figure.cash.points.at(-1)!.value - figure.debt.points.at(-1)!.value) } : {}) };
    }
    case "profit_flow": return { date: figure.current.date, currency: figure.current.currency, revenue: figure.current.revenue, parts: incomeParts(figure.current) };
    case "per_hundred": return { currency: figure.current.currency, current: { date: figure.current.date, perHundred: perHundred(figure.current) }, prior: { date: figure.prior.date, perHundred: perHundred(figure.prior) } };
    case "cash_bridge": return { currency: figure.currency, steps: cashBridgeSteps(figure).map(({ label, value }) => ({ label, value })) };
  }
}

function latestChangeSummary(s: SecFigureSeries) {
  const change = latestChange(s);
  return { date: change.current.date, value: change.current.value, comparedWith: change.basis, priorDate: change.prior.date, priorValue: change.prior.value,
    ...(change.ratio !== undefined ? { changeRatio: round(change.ratio) } : {}) };
}
