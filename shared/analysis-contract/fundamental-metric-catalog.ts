// Shared display and derivation metadata. Provider field mappings remain in Pipeline.
export const FUNDAMENTAL_METRIC_CATALOG = {
  "total_revenue": {
    "basis": "reported",
    "label": "营收",
    "shortLabel": "营收",
    "category": "income_statement",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "revenue"
  },
  "gross_profit": {
    "basis": "reported",
    "label": "毛利润",
    "shortLabel": "毛利",
    "category": "income_statement",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "gross-profit"
  },
  "operating_income": {
    "basis": "reported",
    "label": "营业利润",
    "shortLabel": "营业利润",
    "category": "income_statement",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "operating-income"
  },
  "net_income": {
    "basis": "reported",
    "label": "净利润",
    "shortLabel": "净利润",
    "category": "income_statement",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "net-income"
  },
  "diluted_eps": {
    "basis": "reported",
    "label": "摊薄每股收益",
    "shortLabel": "摊薄 EPS",
    "category": "per_share",
    "unitFamily": "per_share",
    "defaultMark": "line",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "eps"
  },
  "operating_cash_flow": {
    "basis": "reported",
    "label": "经营现金流",
    "shortLabel": "经营现金流",
    "category": "cash_flow",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "operating-cash-flow"
  },
  "capital_expenditure": {
    "basis": "reported",
    "label": "资本开支",
    "shortLabel": "资本开支",
    "category": "cash_flow",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "outflow_magnitude",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "capital-expenditure"
  },
  "free_cash_flow": {
    "basis": "reported",
    "label": "自由现金流",
    "shortLabel": "自由现金流",
    "category": "cash_flow",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "free-cash-flow"
  },
  "stock_based_compensation": {
    "basis": "reported",
    "label": "股权激励",
    "shortLabel": "SBC",
    "category": "cash_flow",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "stock-based-compensation"
  },
  "depreciation_and_amortization": {
    "basis": "reported",
    "label": "折旧与摊销",
    "shortLabel": "折旧摊销",
    "category": "cash_flow",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "depreciation-amortization"
  },
  "research_and_development": {
    "basis": "reported",
    "label": "研发费用",
    "shortLabel": "研发",
    "category": "income_statement",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "research-development"
  },
  "remaining_performance_obligation": {
    "basis": "reported",
    "label": "剩余履约义务",
    "shortLabel": "RPO",
    "category": "balance_sheet",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "backlog"
  },
  "cash_and_cash_equivalents": {
    "basis": "reported",
    "label": "现金及现金等价物",
    "shortLabel": "现金",
    "category": "balance_sheet",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "cash"
  },
  "long_term_debt": {
    "basis": "reported",
    "label": "长期债务",
    "shortLabel": "长期债务",
    "category": "balance_sheet",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "long-term-debt"
  },
  "total_assets": {
    "basis": "reported",
    "label": "总资产",
    "shortLabel": "总资产",
    "category": "balance_sheet",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "total-assets"
  },
  "total_liabilities": {
    "basis": "reported",
    "label": "总负债",
    "shortLabel": "总负债",
    "category": "balance_sheet",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "total-liabilities"
  },
  "stockholders_equity": {
    "basis": "reported",
    "label": "股东权益",
    "shortLabel": "股东权益",
    "category": "balance_sheet",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "stockholders-equity"
  },
  "inventory": {
    "basis": "reported",
    "label": "存货",
    "shortLabel": "存货",
    "category": "balance_sheet",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "inventory"
  },
  "accounts_receivable": {
    "basis": "reported",
    "label": "应收账款",
    "shortLabel": "应收账款",
    "category": "balance_sheet",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "accounts-receivable"
  },
  "ordinary_shares": {
    "basis": "reported",
    "label": "普通股股数",
    "shortLabel": "股数",
    "category": "balance_sheet",
    "unitFamily": "shares",
    "defaultMark": "line",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "ordinary-shares"
  },
  "market_cap": {
    "basis": "reported",
    "label": "市值",
    "shortLabel": "市值",
    "category": "valuation",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "market-cap"
  },
  "enterprise_value": {
    "basis": "reported",
    "label": "企业价值",
    "shortLabel": "企业价值",
    "category": "valuation",
    "unitFamily": "currency",
    "defaultMark": "bar",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "enterprise-value"
  },
  "pe_ratio": {
    "basis": "reported",
    "label": "市盈率 TTM",
    "shortLabel": "市盈率",
    "category": "valuation",
    "unitFamily": "multiple",
    "defaultMark": "line",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "pe-ratio"
  },
  "forward_pe_ratio": {
    "basis": "reported",
    "label": "预期市盈率",
    "shortLabel": "预期 PE",
    "category": "valuation",
    "unitFamily": "multiple",
    "defaultMark": "line",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "forward-pe-ratio"
  },
  "peg_ratio": {
    "basis": "reported",
    "label": "PEG 五年预期",
    "shortLabel": "PEG",
    "category": "valuation",
    "unitFamily": "multiple",
    "defaultMark": "line",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "peg-ratio"
  },
  "price_to_sales": {
    "basis": "reported",
    "label": "市销率",
    "shortLabel": "市销率",
    "category": "valuation",
    "unitFamily": "multiple",
    "defaultMark": "line",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "price-to-sales"
  },
  "price_to_book": {
    "basis": "reported",
    "label": "市净率",
    "shortLabel": "市净率",
    "category": "valuation",
    "unitFamily": "multiple",
    "defaultMark": "line",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "price-to-book"
  },
  "ev_to_revenue": {
    "basis": "reported",
    "label": "企业价值 / 收入",
    "shortLabel": "EV/收入",
    "category": "valuation",
    "unitFamily": "multiple",
    "defaultMark": "line",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "ev-to-revenue"
  },
  "ev_to_ebitda": {
    "basis": "reported",
    "label": "企业价值 / EBITDA",
    "shortLabel": "EV/EBITDA",
    "category": "valuation",
    "unitFamily": "multiple",
    "defaultMark": "line",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_growth",
      "yoy_growth"
    ],
    "colorRole": "ev-to-ebitda"
  },
  "gross_margin": {
    "basis": "derived",
    "label": "毛利率",
    "shortLabel": "毛利率",
    "category": "ratio",
    "unitFamily": "percent",
    "defaultMark": "line",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_change",
      "yoy_change"
    ],
    "colorRole": "gross-margin",
    "derivation": {
      "kind": "ratio",
      "numerator": "gross_profit",
      "denominator": "total_revenue",
      "scale": 100
    }
  },
  "operating_margin": {
    "basis": "derived",
    "label": "营业利润率",
    "shortLabel": "营业利润率",
    "category": "ratio",
    "unitFamily": "percent",
    "defaultMark": "line",
    "displaySign": "as_reported",
    "allowedTransforms": [
      "value",
      "qoq_change",
      "yoy_change"
    ],
    "colorRole": "operating-margin",
    "derivation": {
      "kind": "ratio",
      "numerator": "operating_income",
      "denominator": "total_revenue",
      "scale": 100
    }
  }
} as const;
