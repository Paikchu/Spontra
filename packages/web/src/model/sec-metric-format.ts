/**
 * Presentation helpers for the structured-report metrics the timeline shows.
 *
 * Spontra Analysis stores `metricKey`/`currentValue` exactly as the model
 * emitted them: snake_case English keys and raw magnitudes ("96221000000",
 * "0.7497531724"). That is the right storage shape — it stays comparable across
 * runs — but the disclosure timeline is a reading surface, so it needs a readable
 * label and a human magnitude.
 *
 * The business-site Worker formats the same metrics for its API, so the locale is a parameter that
 * defaults to English rather than read from the page.
 */
import { compactMoney, compactNumber, compactShares, currencyName, MINUS, type Locale } from "@/shared/analysis-runtime/locale.ts";

const METRIC_LABELS: Record<string, string> = {
  revenue: "Revenue",
  total_revenue: "Revenue",
  net_revenue: "Revenue",
  gross_profit: "Gross profit",
  gross_margin: "Gross margin",
  operating_income: "Operating income",
  operating_margin: "Operating margin",
  operating_expenses: "Operating expenses",
  net_income: "Net income",
  net_margin: "Net margin",
  eps: "EPS",
  diluted_eps: "Diluted EPS",
  basic_eps: "Basic EPS",
  operating_cash_flow: "Operating cash flow",
  free_cash_flow: "Free cash flow",
  capex: "Capital expenditures",
  cash: "Cash and equivalents",
  debt: "Debt",
  shares: "Shares outstanding",
  management_net_capex: "Net capex (management)",
  depreciation: "Depreciation",
  capital_expenditure: "Capital expenditures",
  research_and_development: "Research and development",
  cash_and_cash_equivalents: "Cash and equivalents",
  remaining_performance_obligation: "Remaining performance obligations",
  inventory: "Inventories",
  accounts_receivable: "Accounts receivable",
  long_term_debt: "Long-term debt",
  total_debt: "Total debt",
  total_assets: "Total assets",
  total_liabilities: "Total liabilities",
  stockholders_equity: "Stockholders' equity",
  shares_outstanding: "Shares outstanding",
};

const METRIC_LABELS_ZH: Record<string, string> = {
  revenue: "营收",
  total_revenue: "营收",
  net_revenue: "营收",
  gross_profit: "毛利",
  gross_margin: "毛利率",
  operating_income: "营业利润",
  operating_margin: "营业利润率",
  operating_expenses: "营业费用",
  net_income: "净利润",
  net_margin: "净利率",
  eps: "每股收益",
  diluted_eps: "稀释每股收益",
  basic_eps: "基本每股收益",
  operating_cash_flow: "经营现金流",
  free_cash_flow: "自由现金流",
  capex: "资本开支",
  cash: "现金及等价物",
  debt: "债务",
  shares: "流通股数",
  management_net_capex: "净资本开支（管理层口径）",
  depreciation: "折旧",
  capital_expenditure: "资本开支",
  research_and_development: "研发费用",
  cash_and_cash_equivalents: "现金及等价物",
  remaining_performance_obligation: "剩余履约义务",
  inventory: "存货",
  accounts_receivable: "应收账款",
  long_term_debt: "长期债务",
  total_debt: "总债务",
  total_assets: "总资产",
  total_liabilities: "总负债",
  stockholders_equity: "股东权益",
  shares_outstanding: "流通股数",
};

/** Keys whose value is a ratio, whether the model stored 0.75 or 75. */
const RATIO_KEY = /(margin|ratio|rate|yield|growth|percent)$/;

/**
 * A known metric reads by its label. A key that ends in one (`data_center_revenue`) is that metric for the part of the
 * business its leading words name, kept as the filing names it: "Data Center revenue" / "Data Center 营收".
 */
export function formatSecMetricLabel(metricKey: string, locale: Locale = "en"): string {
  const labels = locale === "zh-CN" ? METRIC_LABELS_ZH : METRIC_LABELS;
  const key = metricKey.trim().toLowerCase();
  if (labels[key]) return labels[key];
  const words = key.split("_").filter(Boolean);
  for (let i = 1; i < words.length; i++) {
    const metric = labels[words.slice(i).join("_")];
    if (!metric) continue;
    const part = words.slice(0, i).map(w => w[0]!.toUpperCase() + w.slice(1)).join(" ");
    return locale === "zh-CN" || /^[A-Z]{2}/.test(metric) ? `${part} ${metric}` : `${part} ${metric[0]!.toLowerCase()}${metric.slice(1)}`;
  }
  return metricKey.trim().replace(/_/g, " ");
}

/**
 * Render a stored metric value for reading. Anything that is not a bare number
 * is passed through untouched: the model sometimes already writes "$96.2B"
 * or "not disclosed", and rewriting those would lose meaning.
 */
export function formatSecMetricValue(metricKey: string, rawValue: string, unit?: string, currency?: string, locale: Locale = "en"): string {
  const value = rawValue.trim();
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;

  if (RATIO_KEY.test(metricKey.trim().toLowerCase())) {
    const percent = unit === "ratio" ? numeric * 100 : unit === "%" || unit === "percent" ? numeric : Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
    return `${percent.toFixed(1)}%`;
  }

  const large = Math.abs(numeric) >= 1e4;
  if (locale === "zh-CN") return chineseValue(metricKey, numeric, large, unit, currency);
  const digits = { notation: large ? "compact" : "standard", maximumFractionDigits: large ? 1 : 2, minimumFractionDigits: large ? 0 : 2 } as const;
  if (/shares/.test(metricKey) || unit === "shares") return `${new Intl.NumberFormat("en-US", { ...digits, minimumFractionDigits: 0 }).format(numeric)} shares`;
  const code = (currency || unit || "").toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) {
    try { return new Intl.NumberFormat("en-US", { ...digits, style: "currency", currency: code }).format(numeric); } catch { /* not an ISO currency code */ }
  }
  return new Intl.NumberFormat("en-US", digits).format(numeric);
}

/** "757亿美元", "1.24美元", "123万股": Chinese counting units, the currency named after the amount. */
function chineseValue(metricKey: string, numeric: number, large: boolean, unit?: string, currency?: string): string {
  if (/shares/.test(metricKey) || unit === "shares") return compactShares(numeric, "zh-CN");
  const code = (currency || unit || "").toUpperCase();
  if (/^[A-Z]{3}$/.test(code) && large) return compactMoney(numeric, code, "zh-CN");
  const sign = numeric < 0 ? MINUS : "";
  const body = large ? compactNumber(Math.abs(numeric), "zh-CN") : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(Math.abs(numeric));
  return sign + body + (/^[A-Z]{3}$/.test(code) ? currencyName(code, "zh-CN") : "");
}
