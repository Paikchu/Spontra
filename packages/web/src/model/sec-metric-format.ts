/**
 * Presentation helpers for the structured-report metrics the timeline shows.
 *
 * The analysis pipeline stores `metricKey`/`currentValue` exactly as the model
 * emitted them: snake_case English keys and raw magnitudes ("96221000000",
 * "0.7497531724"). That is the right storage shape — it stays comparable across
 * runs — but the disclosure timeline is a reading surface, so it needs a readable
 * label and a human magnitude.
 */

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
  data_center_revenue: "Data Center revenue",
  gaming_revenue: "Gaming revenue",
  shares_outstanding: "Shares outstanding",
};

/** Keys whose value is a ratio, whether the model stored 0.75 or 75. */
const RATIO_KEY = /(margin|ratio|rate|yield|growth|percent)$/;

export function formatSecMetricLabel(metricKey: string): string {
  const key = metricKey.trim().toLowerCase();
  return METRIC_LABELS[key] ?? metricKey.trim().replace(/_/g, " ");
}

/**
 * Render a stored metric value for reading. Anything that is not a bare number
 * is passed through untouched: the model sometimes already writes "$96.2B"
 * or "not disclosed", and rewriting those would lose meaning.
 */
export function formatSecMetricValue(metricKey: string, rawValue: string, unit?: string, currency?: string): string {
  const value = rawValue.trim();
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;

  if (RATIO_KEY.test(metricKey.trim().toLowerCase())) {
    const percent = unit === "ratio" ? numeric * 100 : unit === "%" || unit === "percent" ? numeric : Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
    return `${percent.toFixed(1)}%`;
  }

  const large = Math.abs(numeric) >= 1e4;
  const digits = { notation: large ? "compact" : "standard", maximumFractionDigits: large ? 1 : 2, minimumFractionDigits: large ? 0 : 2 } as const;
  if (/shares/.test(metricKey) || unit === "shares") return `${new Intl.NumberFormat("en-US", { ...digits, minimumFractionDigits: 0 }).format(numeric)} shares`;
  const code = (currency || unit || "").toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) {
    try { return new Intl.NumberFormat("en-US", { ...digits, style: "currency", currency: code }).format(numeric); } catch { /* not an ISO currency code */ }
  }
  return new Intl.NumberFormat("en-US", digits).format(numeric);
}
