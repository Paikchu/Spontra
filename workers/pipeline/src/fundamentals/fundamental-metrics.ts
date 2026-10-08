import { FUNDAMENTAL_METRIC_CATALOG as sharedCatalog } from "../../../../shared/analysis-contract/fundamental-metric-catalog.ts";

export const FUNDAMENTAL_METRIC_CATALOG_VERSION = "fundamental-metrics.v2";

export type FundamentalMetricCategory =
  | "income_statement"
  | "cash_flow"
  | "balance_sheet"
  | "per_share"
  | "valuation"
  | "ratio";

/** `multiple` is a unit-less ratio of price to a fundamental — P/E, EV/EBITDA. */
export type FundamentalUnitFamily = "currency" | "percent" | "per_share" | "shares" | "multiple";
export type FundamentalChartMark = "bar" | "line";
export type FundamentalTransform =
  | "value"
  | "qoq_growth"
  | "yoy_growth"
  | "qoq_change"
  | "yoy_change";
export type FundamentalDisplaySign = "as_reported" | "outflow_magnitude";

type ReportedMetricDefinition = {
  basis: "reported";
  /** Null for a metric only SEC XBRL reports; Yahoo has no field for it. */
  yahooField: string | null;
  label: string;
  shortLabel: string;
  category: Exclude<FundamentalMetricCategory, "ratio">;
  unitFamily: Exclude<FundamentalUnitFamily, "percent">;
  defaultMark: FundamentalChartMark;
  displaySign: FundamentalDisplaySign;
  allowedTransforms: readonly FundamentalTransform[];
  colorRole: string;
};

type DerivedMetricDefinition = {
  basis: "derived";
  yahooField: null;
  label: string;
  shortLabel: string;
  category: "ratio";
  unitFamily: "percent";
  defaultMark: "line";
  displaySign: "as_reported";
  allowedTransforms: readonly FundamentalTransform[];
  colorRole: string;
  derivation: {
    kind: "ratio";
    numerator: string;
    denominator: string;
    scale: 100;
  };
};

const reportedMetrics = {
  total_revenue: { ...sharedCatalog.total_revenue, yahooField: "quarterlyTotalRevenue" },
  gross_profit: { ...sharedCatalog.gross_profit, yahooField: "quarterlyGrossProfit" },
  operating_income: { ...sharedCatalog.operating_income, yahooField: "quarterlyOperatingIncome" },
  net_income: { ...sharedCatalog.net_income, yahooField: "quarterlyNetIncome" },
  diluted_eps: { ...sharedCatalog.diluted_eps, yahooField: "quarterlyDilutedEPS" },
  operating_cash_flow: { ...sharedCatalog.operating_cash_flow, yahooField: "quarterlyOperatingCashFlow" },
  capital_expenditure: { ...sharedCatalog.capital_expenditure, yahooField: "quarterlyCapitalExpenditure" },
  free_cash_flow: { ...sharedCatalog.free_cash_flow, yahooField: "quarterlyFreeCashFlow" },
  stock_based_compensation: { ...sharedCatalog.stock_based_compensation, yahooField: "quarterlyStockBasedCompensation" },
  depreciation_and_amortization: { ...sharedCatalog.depreciation_and_amortization, yahooField: "quarterlyDepreciationAndAmortization" },
  research_and_development: { ...sharedCatalog.research_and_development, yahooField: "quarterlyResearchAndDevelopment" },
  cash_and_cash_equivalents: { ...sharedCatalog.cash_and_cash_equivalents, yahooField: "quarterlyCashAndCashEquivalents" },
  remaining_performance_obligation: { ...sharedCatalog.remaining_performance_obligation, yahooField: null },
  long_term_debt: { ...sharedCatalog.long_term_debt, yahooField: "quarterlyLongTermDebt" },
  total_assets: { ...sharedCatalog.total_assets, yahooField: "quarterlyTotalAssets" },
  total_liabilities: { ...sharedCatalog.total_liabilities, yahooField: "quarterlyTotalLiabilitiesNetMinorityInterest" },
  stockholders_equity: { ...sharedCatalog.stockholders_equity, yahooField: "quarterlyStockholdersEquity" },
  inventory: { ...sharedCatalog.inventory, yahooField: "quarterlyInventory" },
  accounts_receivable: { ...sharedCatalog.accounts_receivable, yahooField: "quarterlyAccountsReceivable" },
  ordinary_shares: { ...sharedCatalog.ordinary_shares, yahooField: "quarterlyOrdinarySharesNumber" },
  market_cap: { ...sharedCatalog.market_cap, yahooField: "quarterlyMarketCap" },
  enterprise_value: { ...sharedCatalog.enterprise_value, yahooField: "quarterlyEnterpriseValue" },
  pe_ratio: { ...sharedCatalog.pe_ratio, yahooField: "quarterlyPeRatio" },
  forward_pe_ratio: { ...sharedCatalog.forward_pe_ratio, yahooField: "quarterlyForwardPeRatio" },
  peg_ratio: { ...sharedCatalog.peg_ratio, yahooField: "quarterlyPegRatio" },
  price_to_sales: { ...sharedCatalog.price_to_sales, yahooField: "quarterlyPsRatio" },
  price_to_book: { ...sharedCatalog.price_to_book, yahooField: "quarterlyPbRatio" },
  ev_to_revenue: { ...sharedCatalog.ev_to_revenue, yahooField: "quarterlyEnterprisesValueRevenueRatio" },
  ev_to_ebitda: { ...sharedCatalog.ev_to_ebitda, yahooField: "quarterlyEnterprisesValueEBITDARatio" },
} as const satisfies Record<string, ReportedMetricDefinition>;

const derivedMetrics = {
  gross_margin: { ...sharedCatalog.gross_margin, yahooField: null },
  operating_margin: { ...sharedCatalog.operating_margin, yahooField: null },
} as const satisfies Record<string, DerivedMetricDefinition>;

export const FUNDAMENTAL_METRIC_CATALOG = Object.freeze({
  ...reportedMetrics,
  ...derivedMetrics,
});

export type FundamentalMetricKey = keyof typeof FUNDAMENTAL_METRIC_CATALOG;
export type YahooQuarterlyFundamentalField = Exclude<(typeof reportedMetrics)[keyof typeof reportedMetrics]["yahooField"], null>;
export type FundamentalMetricDefinition = (typeof FUNDAMENTAL_METRIC_CATALOG)[FundamentalMetricKey];

const metricKeys = new Set<string>(Object.keys(FUNDAMENTAL_METRIC_CATALOG));
const yahooFieldToMetric = new Map<YahooQuarterlyFundamentalField, FundamentalMetricKey>();
const colorRoles = new Set<string>();

for (const [metricKey, definition] of Object.entries(FUNDAMENTAL_METRIC_CATALOG)) {
  if (colorRoles.has(definition.colorRole)) {
    throw new Error(`Duplicate fundamental metric color role: ${definition.colorRole}`);
  }
  colorRoles.add(definition.colorRole);

  if (definition.basis === "derived") {
    if (!metricKeys.has(definition.derivation.numerator) || !metricKeys.has(definition.derivation.denominator)) {
      throw new Error(`Derived fundamental metric ${metricKey} references an unknown source metric.`);
    }
    continue;
  }
  if (definition.yahooField === null) continue;
  if (yahooFieldToMetric.has(definition.yahooField)) {
    throw new Error(`Duplicate Yahoo fundamental field: ${definition.yahooField}`);
  }
  yahooFieldToMetric.set(definition.yahooField, metricKey as FundamentalMetricKey);
}

export const YAHOO_QUARTERLY_FUNDAMENTAL_FIELDS = Object.freeze([...yahooFieldToMetric.keys()]);

export function isFundamentalMetricKey(value: string): value is FundamentalMetricKey {
  return metricKeys.has(value);
}

export function isYahooQuarterlyFundamentalField(value: string): value is YahooQuarterlyFundamentalField {
  return yahooFieldToMetric.has(value as YahooQuarterlyFundamentalField);
}

export function getMetricKeyForYahooField(field: YahooQuarterlyFundamentalField): FundamentalMetricKey {
  return yahooFieldToMetric.get(field)!;
}

export function getFundamentalMetricDefinition(metricKey: FundamentalMetricKey): FundamentalMetricDefinition {
  return FUNDAMENTAL_METRIC_CATALOG[metricKey];
}
