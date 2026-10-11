import type { FundamentalCurrentObservation } from "../fundamentals/fundamentals-d1.ts";
import type { FundamentalMetricKey } from "../fundamentals/fundamental-metrics.ts";

export const COMPANY_FEATURE_FORMULA_VERSION = "company-features.v1";

const FLOW_METRICS: FundamentalMetricKey[] = [
  "total_revenue",
  "gross_profit",
  "operating_income",
  "net_income",
  "operating_cash_flow",
  "capital_expenditure",
  "free_cash_flow",
  "stock_based_compensation",
  "depreciation_and_amortization",
  "research_and_development",
];

const CORE_METRICS: FundamentalMetricKey[] = [
  ...FLOW_METRICS,
  "gross_margin",
  "operating_margin",
  "cash_and_cash_equivalents",
  "long_term_debt",
  "stockholders_equity",
  "total_assets",
  "total_liabilities",
  "inventory",
  "accounts_receivable",
  "diluted_eps",
];

export type CompanyFeature = {
  featureRef: string;
  metricKey: string;
  label: string;
  periodEnd: string;
  value: number | null;
  qoqGrowth: number | null;
  yoyGrowth: number | null;
  ttmValue: number | null;
  quality: "complete" | "partial" | "unavailable";
  source: "yahoo_finance";
};

export type CompanyFeaturePack = {
  version: typeof COMPANY_FEATURE_FORMULA_VERSION;
  source: "yahoo_finance";
  ticker: string;
  targetPeriodEnd: string;
  availablePeriods: string[];
  features: CompanyFeature[];
  derived: Array<{
    featureRef: string;
    metricKey: string;
    label: string;
    value: number | null;
    quality: "complete" | "partial" | "unavailable";
    source: "yahoo_finance";
  }>;
  missingMetricKeys: string[];
};

export function buildCompanyFeaturePack(input: {
  source: string;
  ticker: string;
  targetPeriodEnd: string;
  observations: FundamentalCurrentObservation[];
}): CompanyFeaturePack {
  if (input.source !== "yahoo_finance") {
    throw new Error("Company Feature Engine only accepts Yahoo Finance observations.");
  }
  const observations = input.observations.filter((item) => item.periodType === "3M");
  if (observations.some((item) => item.ticker !== input.ticker)) {
    throw new Error("Company Feature Engine received a cross-company observation.");
  }
  const periods = [...new Set(observations.map((item) => item.periodEnd))].sort();
  const targetIndex = periods.indexOf(input.targetPeriodEnd);
  if (targetIndex < 0 || valueFor(observations, input.targetPeriodEnd, "total_revenue") === null) {
    throw new Error("Yahoo target quarter is not ready: 3M total_revenue is required as the anchor.");
  }

  const features = CORE_METRICS.map((metricKey) => {
    const actual = valueFor(observations, input.targetPeriodEnd, metricKey);
    const qoq = targetIndex >= 1 ? valueFor(observations, periods[targetIndex - 1]!, metricKey) : null;
    const yoy = targetIndex >= 4 ? valueFor(observations, periods[targetIndex - 4]!, metricKey) : null;
    const ttmPeriods = periods.slice(Math.max(0, targetIndex - 3), targetIndex + 1);
    const ttmValues = FLOW_METRICS.includes(metricKey)
      ? ttmPeriods.map((period) => valueFor(observations, period, metricKey))
      : [];
    const ttmValue = ttmValues.length === 4 && ttmValues.every((value) => value !== null)
      ? ttmValues.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : null;
    return {
      featureRef: `yahoo:${input.ticker}:${input.targetPeriodEnd}:${metricKey}:${COMPANY_FEATURE_FORMULA_VERSION}`,
      metricKey,
      label: metricKey,
      periodEnd: input.targetPeriodEnd,
      value: actual,
      qoqGrowth: growth(actual, qoq),
      yoyGrowth: growth(actual, yoy),
      ttmValue,
      quality: actual === null ? "unavailable" as const : qoq === null || yoy === null ? "partial" as const : "complete" as const,
      source: "yahoo_finance" as const,
    };
  });
  const map = new Map(features.map((feature) => [feature.metricKey, feature]));
  const current = (metric: FundamentalMetricKey) => map.get(metric)?.value ?? null;
  const ttm = (metric: FundamentalMetricKey) => map.get(metric)?.ttmValue ?? null;
  const derived = [
    ratioFeature(input, "net_margin", "Net margin", current("net_income"), current("total_revenue")),
    ratioFeature(input, "operating_cash_conversion", "Operating cash flow / net income", ttm("operating_cash_flow"), ttm("net_income")),
    ratioFeature(input, "capex_to_net_income", "Capital expenditure / net income", absolute(ttm("capital_expenditure")), ttm("net_income")),
    ratioFeature(input, "long_term_debt_repayment_years", "Years to repay long-term debt", current("long_term_debt"), ttm("net_income")),
    ratioFeature(input, "return_on_equity_proxy", "TTM net income / ending stockholders' equity", ttm("net_income"), current("stockholders_equity")),
  ];
  return {
    version: COMPANY_FEATURE_FORMULA_VERSION,
    source: "yahoo_finance",
    ticker: input.ticker,
    targetPeriodEnd: input.targetPeriodEnd,
    availablePeriods: periods,
    features,
    derived,
    missingMetricKeys: features.filter((feature) => feature.value === null).map((feature) => feature.metricKey),
  };
}

function valueFor(
  observations: FundamentalCurrentObservation[],
  periodEnd: string,
  metricKey: FundamentalMetricKey,
): number | null {
  const raw = observations.find((item) => item.periodEnd === periodEnd && item.metricKey === metricKey)?.valueDecimal;
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function growth(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  return (current - prior) / Math.abs(prior);
}

function absolute(value: number | null): number | null {
  return value === null ? null : Math.abs(value);
}

function ratioFeature(
  input: { ticker: string; targetPeriodEnd: string },
  metricKey: string,
  label: string,
  numerator: number | null,
  denominator: number | null,
) {
  const value = numerator === null || denominator === null || denominator === 0
    ? null
    : numerator / Math.abs(denominator);
  return {
    featureRef: `yahoo:${input.ticker}:${input.targetPeriodEnd}:${metricKey}:${COMPANY_FEATURE_FORMULA_VERSION}`,
    metricKey,
    label,
    value,
    quality: value === null ? "unavailable" as const : "complete" as const,
    source: "yahoo_finance" as const,
  };
}
