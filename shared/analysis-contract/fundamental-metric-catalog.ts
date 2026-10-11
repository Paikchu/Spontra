// Shared display and derivation metadata. Provider field mappings remain in Pipeline.
export const FUNDAMENTAL_METRIC_CATALOG = {
  "total_revenue": {
    "basis": "reported",
    "label": "Revenue",
    "shortLabel": "Revenue",
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
    "label": "Gross profit",
    "shortLabel": "Gross profit",
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
    "label": "Operating income",
    "shortLabel": "Op. income",
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
    "label": "Net income",
    "shortLabel": "Net income",
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
    "label": "Diluted EPS",
    "shortLabel": "Diluted EPS",
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
    "label": "Operating cash flow",
    "shortLabel": "Op. cash flow",
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
    "label": "Capital expenditures",
    "shortLabel": "Capex",
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
    "label": "Free cash flow",
    "shortLabel": "FCF",
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
    "label": "Stock-based compensation",
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
    "label": "Depreciation and amortization",
    "shortLabel": "D&A",
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
    "label": "Research and development",
    "shortLabel": "R&D",
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
    "label": "Remaining performance obligations",
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
    "label": "Cash and cash equivalents",
    "shortLabel": "Cash",
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
    "label": "Long-term debt",
    "shortLabel": "LT debt",
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
    "label": "Total assets",
    "shortLabel": "Assets",
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
    "label": "Total liabilities",
    "shortLabel": "Liabilities",
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
    "label": "Stockholders' equity",
    "shortLabel": "Equity",
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
    "label": "Inventories",
    "shortLabel": "Inventory",
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
    "label": "Accounts receivable",
    "shortLabel": "Receivables",
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
    "label": "Shares outstanding",
    "shortLabel": "Shares",
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
    "label": "Market cap",
    "shortLabel": "Market cap",
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
    "label": "Enterprise value",
    "shortLabel": "EV",
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
    "label": "P/E (TTM)",
    "shortLabel": "P/E",
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
    "label": "Forward P/E",
    "shortLabel": "Fwd P/E",
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
    "label": "PEG (5-yr expected)",
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
    "label": "Price/sales",
    "shortLabel": "P/S",
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
    "label": "Price/book",
    "shortLabel": "P/B",
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
    "label": "EV/revenue",
    "shortLabel": "EV/Revenue",
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
    "label": "EV/EBITDA",
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
    "label": "Gross margin",
    "shortLabel": "Gross margin",
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
    "label": "Operating margin",
    "shortLabel": "Op. margin",
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
