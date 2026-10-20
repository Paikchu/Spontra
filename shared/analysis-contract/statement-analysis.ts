import type { BusinessFlowQuarter } from "./business-flow.ts";
import type { AnalysisFinding, FindingEvidence, FindingRef, FindingSpan } from "./findings.ts";

/**
 * The three-statement checkup (docs/three-statement-analysis-design.md): a fixed catalogue of metrics, each a
 * reference the findings runtime resolves, and fixed rules with thresholds. The page and Spontra Analysis run the same
 * pure function over the same data, so a flag the reader sees is the flag the findings writer and the analyst were
 * told about. Nothing here is written by a model; nothing here is a sentence.
 */

/** Bumped when the catalogue, a formula or a threshold changes; part of the findings fingerprint, never stored in a table. */
export const STATEMENT_ANALYSIS_VERSION = "statement-analysis.v1";

export const STATEMENT_DIMENSIONS = ["growth", "profitability", "earningsQuality", "capitalEfficiency", "safety", "valuation"] as const;
export type StatementDimension = (typeof STATEMENT_DIMENSIONS)[number];

export type IncomeModel = NonNullable<BusinessFlowQuarter["incomeModel"]>;
/** The presentations a metric applies to; "unknown" and an absent model read as "standard". */
export type MetricModels = "all" | IncomeModel[];

/** How a metric's number is written: a rate, a multiple ("2.6x"), an amount, a per-share figure, a change in points, or a count of months. */
export type MetricForm = "percent" | "multiple" | "money" | "per_share" | "points" | "months";
export type MetricBetter = "high" | "low" | "none";

/**
 * What the metric measures of its reference: the resolved value, its year-over-year or quarter-over-quarter change
 * (percent for amounts, points for rates), or the spread of its year-over-year change over another reference's.
 */
export type MetricMeasure = "value" | "yoy" | "qoq" | "spread";

export type StatementMetricDef = {
  id: string;
  dimension: StatementDimension;
  /** English and Chinese names; the English one is also what the ledger shows the model. */
  label: [en: string, zh: string];
  ref: FindingRef;
  measure: MetricMeasure;
  /** The reference a spread is measured against. */
  against?: FindingRef;
  form: MetricForm;
  /** The span each quarterly point is read at: the quarter itself, or the four quarters ending there. */
  span: FindingSpan;
  better: MetricBetter;
  models: MetricModels;
};

const STANDARD: MetricModels = ["standard", "direct_operating"];
const FINANCIAL: MetricModels = ["financial", "insurance"];
const revenue = { metric: "revenue" } as const;

export const STATEMENT_METRICS: readonly StatementMetricDef[] = [
  // Growth: is the business getting bigger, and does profit scale faster than revenue?
  { id: "revenue-growth", dimension: "growth", label: ["Revenue growth", "营收同比"], ref: revenue, measure: "yoy", form: "percent", span: "quarter", better: "high", models: "all" },
  { id: "operating-leverage", dimension: "growth", label: ["Operating income growth over revenue growth", "经营杠杆（营业利润同比 − 营收同比）"], ref: { metric: "operating" }, measure: "spread", against: revenue, form: "points", span: "quarter", better: "high", models: STANDARD },
  { id: "eps-growth", dimension: "growth", label: ["Diluted EPS growth", "摊薄每股收益同比"], ref: { fundamental: "diluted_eps" }, measure: "yoy", form: "percent", span: "quarter", better: "high", models: "all" },
  { id: "rpo-to-revenue", dimension: "growth", label: ["RPO over four-quarter revenue", "RPO ÷ 近四季营收"], ref: { ratio: { numerator: { capital: "rpo" }, denominator: revenue } }, measure: "value", form: "multiple", span: "fiscal_year", better: "none", models: "all" },
  // Profitability: what each dollar of revenue keeps.
  { id: "gross-margin", dimension: "profitability", label: ["Gross margin", "毛利率"], ref: { ratio: { numerator: { metric: "gross" }, denominator: revenue } }, measure: "value", form: "percent", span: "quarter", better: "high", models: ["standard"] },
  { id: "operating-margin", dimension: "profitability", label: ["Operating margin", "营业利润率"], ref: { ratio: { numerator: { metric: "operating" }, denominator: revenue } }, measure: "value", form: "percent", span: "quarter", better: "high", models: STANDARD },
  { id: "net-margin", dimension: "profitability", label: ["Net margin", "净利率"], ref: { ratio: { numerator: { metric: "net" }, denominator: revenue } }, measure: "value", form: "percent", span: "quarter", better: "high", models: "all" },
  { id: "rd-intensity", dimension: "profitability", label: ["R&D % of revenue", "研发费用率"], ref: { ratio: { numerator: { metric: "research" }, denominator: revenue } }, measure: "value", form: "percent", span: "quarter", better: "none", models: ["standard"] },
  { id: "sm-intensity", dimension: "profitability", label: ["S&M % of revenue", "销售及市场费用率"], ref: { ratio: { numerator: { metric: "sales" }, denominator: revenue } }, measure: "value", form: "percent", span: "quarter", better: "none", models: ["standard"] },
  { id: "ga-intensity", dimension: "profitability", label: ["G&A % of revenue", "管理费用率"], ref: { ratio: { numerator: { metric: "administration" }, denominator: revenue } }, measure: "value", form: "percent", span: "quarter", better: "none", models: ["standard"] },
  { id: "tax-rate", dimension: "profitability", label: ["Effective tax rate", "有效税率"], ref: { ratio: { numerator: { metric: "tax" }, denominator: { metric: "pretax" } } }, measure: "value", form: "percent", span: "quarter", better: "none", models: "all" },
  // Earnings quality: is the profit cash?
  { id: "cash-conversion", dimension: "earningsQuality", label: ["Operating cash flow over net income", "经营现金流 ÷ 净利润"], ref: { ratio: { numerator: { capital: "operatingCashFlow" }, denominator: { metric: "net" } } }, measure: "value", form: "multiple", span: "fiscal_year", better: "high", models: "all" },
  { id: "accruals", dimension: "earningsQuality", label: ["Accruals ratio", "应计项比率"], ref: { derived: "accruals" }, measure: "value", form: "percent", span: "fiscal_year", better: "low", models: "all" },
  { id: "receivables-vs-revenue", dimension: "earningsQuality", label: ["Receivables growth over revenue growth", "应收账款增速 − 营收增速"], ref: { capital: "receivables" }, measure: "spread", against: revenue, form: "points", span: "quarter", better: "low", models: STANDARD },
  { id: "inventory-vs-revenue", dimension: "earningsQuality", label: ["Inventory growth over revenue growth", "存货增速 − 营收增速"], ref: { capital: "inventory" }, measure: "spread", against: revenue, form: "points", span: "quarter", better: "low", models: STANDARD },
  { id: "sbc-intensity", dimension: "earningsQuality", label: ["Stock-based compensation % of revenue", "股权激励 ÷ 营收"], ref: { ratio: { numerator: { derived: "stockCompensationExpense" }, denominator: revenue } }, measure: "value", form: "percent", span: "fiscal_year", better: "low", models: "all" },
  { id: "working-capital-share", dimension: "earningsQuality", label: ["Working-capital change over operating cash flow", "营运资本变动 ÷ 经营现金流"], ref: { ratio: { numerator: { derived: "workingCapitalChange" }, denominator: { capital: "operatingCashFlow" } } }, measure: "value", form: "percent", span: "fiscal_year", better: "none", models: "all" },
  // Capital efficiency: what the capital put in earns, and whether new capital is still earning.
  { id: "roe", dimension: "capitalEfficiency", label: ["Return on equity", "净资产收益率（ROE）"], ref: { ratio: { numerator: { metric: "net" }, denominator: { derived: "averageEquity" } } }, measure: "value", form: "percent", span: "fiscal_year", better: "high", models: "all" },
  { id: "roa", dimension: "capitalEfficiency", label: ["Return on assets", "总资产收益率（ROA）"], ref: { ratio: { numerator: { metric: "net" }, denominator: { derived: "averageAssets" } } }, measure: "value", form: "percent", span: "fiscal_year", better: "high", models: FINANCIAL },
  { id: "roic", dimension: "capitalEfficiency", label: ["Return on invested capital", "投入资本回报率（ROIC）"], ref: { ratio: { numerator: { derived: "nopat" }, denominator: { derived: "averageInvestedCapital" } } }, measure: "value", form: "percent", span: "fiscal_year", better: "high", models: STANDARD },
  { id: "asset-turnover", dimension: "capitalEfficiency", label: ["Asset turnover", "资产周转率"], ref: { ratio: { numerator: revenue, denominator: { derived: "averageAssets" } } }, measure: "value", form: "multiple", span: "fiscal_year", better: "high", models: STANDARD },
  { id: "capex-to-depreciation", dimension: "capitalEfficiency", label: ["Capex over depreciation", "资本开支 ÷ 折旧摊销"], ref: { ratio: { numerator: { capital: "capex" }, denominator: { derived: "depreciationAmortization" } } }, measure: "value", form: "multiple", span: "fiscal_year", better: "none", models: STANDARD },
  { id: "capex-intensity", dimension: "capitalEfficiency", label: ["Capex % of revenue", "资本开支 ÷ 营收"], ref: { ratio: { numerator: { capital: "capex" }, denominator: revenue } }, measure: "value", form: "percent", span: "fiscal_year", better: "none", models: STANDARD },
  { id: "asset-formation", dimension: "capitalEfficiency", label: ["Property and equipment over four-quarter revenue", "固定资产 ÷ 近四季营收"], ref: { ratio: { numerator: { capital: "productive" }, denominator: revenue } }, measure: "value", form: "multiple", span: "fiscal_year", better: "none", models: STANDARD },
  { id: "incremental-return", dimension: "capitalEfficiency", label: ["Return on added capital", "增量资本回报"], ref: { derived: "incrementalReturn" }, measure: "value", form: "percent", span: "fiscal_year", better: "high", models: STANDARD },
  // Safety: can the company carry its debts and fund its plans?
  { id: "net-debt-to-ebitda", dimension: "safety", label: ["Net debt over EBITDA", "净债务 ÷ EBITDA"], ref: { ratio: { numerator: { derived: "netDebt" }, denominator: { derived: "ebitda" } } }, measure: "value", form: "multiple", span: "fiscal_year", better: "low", models: STANDARD },
  { id: "cash-to-debt", dimension: "safety", label: ["Cash over debt", "现金 ÷ 有息债务"], ref: { ratio: { numerator: { capital: "cash" }, denominator: { capital: "debt" } } }, measure: "value", form: "multiple", span: "quarter", better: "high", models: "all" },
  { id: "current-ratio", dimension: "safety", label: ["Current ratio", "流动比率"], ref: { ratio: { numerator: { capital: "currentAssets" }, denominator: { capital: "currentLiabilities" } } }, measure: "value", form: "multiple", span: "quarter", better: "high", models: STANDARD },
  { id: "interest-burden", dimension: "safety", label: ["Cash interest over operating cash flow", "现金利息 ÷ 经营现金流"], ref: { ratio: { numerator: { capital: "interestPaid" }, denominator: { capital: "operatingCashFlow" } } }, measure: "value", form: "percent", span: "fiscal_year", better: "low", models: "all" },
  { id: "free-cash-flow", dimension: "safety", label: ["Free cash flow", "自由现金流"], ref: { capital: "freeCashFlow" }, measure: "value", form: "money", span: "fiscal_year", better: "high", models: STANDARD },
  { id: "fcf-margin", dimension: "safety", label: ["Free cash flow margin", "自由现金流率"], ref: { ratio: { numerator: { capital: "freeCashFlow" }, denominator: revenue } }, measure: "value", form: "percent", span: "fiscal_year", better: "high", models: STANDARD },
  { id: "self-funding", dimension: "safety", label: ["Operating cash flow over capex", "自给率（经营现金流 ÷ 资本开支）"], ref: { ratio: { numerator: { capital: "operatingCashFlow" }, denominator: { capital: "capex" } } }, measure: "value", form: "multiple", span: "fiscal_year", better: "high", models: STANDARD },
  { id: "external-funding", dimension: "safety", label: ["Net external funding over capex", "外部融资依赖（净外部融资 ÷ 资本开支）"], ref: { ratio: { numerator: { derived: "netExternalFunding" }, denominator: { capital: "capex" } } }, measure: "value", form: "percent", span: "fiscal_year", better: "low", models: STANDARD },
  { id: "debt-due-coverage", dimension: "safety", label: ["Coverage of debt due within 12 months", "12 个月内到期债务覆盖倍数"], ref: { derived: "debtDueCoverage" }, measure: "value", form: "multiple", span: "quarter", better: "high", models: "all" },
  { id: "cash-runway", dimension: "safety", label: ["Cash runway", "现金跑道"], ref: { derived: "cashRunwayMonths" }, measure: "value", form: "months", span: "quarter", better: "high", models: "all" },
  // Valuation: what the market pays, from the fundamentals feed; read only, no rule.
  { id: "pe", dimension: "valuation", label: ["P/E", "市盈率（P/E）"], ref: { fundamental: "pe_ratio" }, measure: "value", form: "multiple", span: "quarter", better: "none", models: "all" },
  { id: "ev-to-ebitda", dimension: "valuation", label: ["EV/EBITDA", "EV/EBITDA"], ref: { fundamental: "ev_to_ebitda" }, measure: "value", form: "multiple", span: "quarter", better: "none", models: "all" },
  { id: "ev-to-revenue", dimension: "valuation", label: ["EV/Revenue", "EV/营收"], ref: { fundamental: "ev_to_revenue" }, measure: "value", form: "multiple", span: "quarter", better: "none", models: "all" },
  { id: "price-to-sales", dimension: "valuation", label: ["P/S", "市销率（P/S）"], ref: { fundamental: "price_to_sales" }, measure: "value", form: "multiple", span: "quarter", better: "none", models: "all" },
  { id: "price-to-book", dimension: "valuation", label: ["P/B", "市净率（P/B）"], ref: { fundamental: "price_to_book" }, measure: "value", form: "multiple", span: "quarter", better: "none", models: "all" },
];

export type FlagLevel = "alert" | "watch" | "note";

/**
 * One test of a metric's series at a quarter, in the metric's own display units (a rate in percent, a multiple in
 * turns, an amount's change in percent, a spread in points): the value or its change against a threshold, a sign
 * flip against four quarters earlier, or a run of falling quarters.
 */
export type RuleCondition =
  | { metric: string; on: "value" | "yoy" | "qoq"; op: "<" | ">"; value: number }
  | { metric: string; flipped: "toNegative" | "toPositive" }
  | { metric: string; falling: number };

export type StatementRuleDef = {
  id: string;
  dimension: StatementDimension;
  /** The metric the flag is filed under; the one whose figure the flag shows. */
  metric: string;
  /** Every condition must hold. */
  all: RuleCondition[];
  /** Consecutive quarters, ending at the report, over which every condition must hold; a run quiets one-quarter noise. */
  persist: number;
  level: FlagLevel;
};

/**
 * The thresholds the checkup flags on. They are a starting point, the same for every company; a presentation that
 * disables a metric never trips its rules. The 8% in `returns-below-cost` stands in for a cost of capital and is
 * shown as the constant it is.
 */
export const STATEMENT_RULES: readonly StatementRuleDef[] = [
  { id: "revenue-decline", dimension: "growth", metric: "revenue-growth", all: [{ metric: "revenue-growth", on: "value", op: "<", value: 0 }], persist: 2, level: "watch" },
  { id: "growth-decelerating", dimension: "growth", metric: "revenue-growth", all: [{ metric: "revenue-growth", falling: 3 }, { metric: "revenue-growth", on: "yoy", op: "<", value: -10 }], persist: 1, level: "watch" },
  { id: "operating-leverage", dimension: "growth", metric: "operating-leverage", all: [{ metric: "operating-leverage", on: "value", op: ">", value: 15 }, { metric: "revenue-growth", on: "value", op: ">", value: 0 }], persist: 2, level: "note" },
  { id: "margin-compression", dimension: "profitability", metric: "operating-margin", all: [{ metric: "operating-margin", on: "yoy", op: "<", value: -2 }], persist: 2, level: "watch" },
  { id: "gross-margin-compression", dimension: "profitability", metric: "gross-margin", all: [{ metric: "gross-margin", on: "yoy", op: "<", value: -2 }], persist: 2, level: "watch" },
  { id: "margin-expansion", dimension: "profitability", metric: "operating-margin", all: [{ metric: "operating-margin", on: "yoy", op: ">", value: 2 }], persist: 2, level: "note" },
  { id: "cash-below-profit", dimension: "earningsQuality", metric: "cash-conversion", all: [{ metric: "cash-conversion", on: "value", op: "<", value: 0.8 }], persist: 1, level: "alert" },
  { id: "cash-above-profit", dimension: "earningsQuality", metric: "cash-conversion", all: [{ metric: "cash-conversion", on: "value", op: ">", value: 1.5 }], persist: 1, level: "note" },
  { id: "receivables-outrun", dimension: "earningsQuality", metric: "receivables-vs-revenue", all: [{ metric: "receivables-vs-revenue", on: "value", op: ">", value: 15 }], persist: 2, level: "watch" },
  { id: "inventory-outrun", dimension: "earningsQuality", metric: "inventory-vs-revenue", all: [{ metric: "inventory-vs-revenue", on: "value", op: ">", value: 15 }], persist: 2, level: "watch" },
  { id: "sbc-heavy", dimension: "earningsQuality", metric: "sbc-intensity", all: [{ metric: "sbc-intensity", on: "value", op: ">", value: 15 }], persist: 1, level: "watch" },
  { id: "capex-cycle", dimension: "capitalEfficiency", metric: "capex-to-depreciation", all: [{ metric: "capex-to-depreciation", on: "value", op: ">", value: 2 }], persist: 1, level: "watch" },
  { id: "capex-unmatched", dimension: "capitalEfficiency", metric: "asset-formation", all: [{ metric: "capex-to-depreciation", on: "value", op: ">", value: 2 }, { metric: "asset-formation", on: "yoy", op: ">", value: 0 }, { metric: "revenue-growth", on: "yoy", op: "<", value: 0 }], persist: 2, level: "alert" },
  { id: "returns-below-cost", dimension: "capitalEfficiency", metric: "roic", all: [{ metric: "roic", on: "value", op: "<", value: 8 }, { metric: "capex-to-depreciation", on: "value", op: ">", value: 1.5 }], persist: 1, level: "alert" },
  { id: "backlog-large", dimension: "growth", metric: "rpo-to-revenue", all: [{ metric: "rpo-to-revenue", on: "value", op: ">", value: 1 }], persist: 1, level: "note" },
  { id: "returns-strong", dimension: "capitalEfficiency", metric: "roic", all: [{ metric: "roic", on: "value", op: ">", value: 20 }], persist: 1, level: "note" },
  { id: "fcf-negative", dimension: "safety", metric: "free-cash-flow", all: [{ metric: "free-cash-flow", on: "value", op: "<", value: 0 }], persist: 1, level: "watch" },
  { id: "fcf-turned-positive", dimension: "safety", metric: "free-cash-flow", all: [{ metric: "free-cash-flow", flipped: "toPositive" }], persist: 1, level: "note" },
  { id: "fcf-turned-negative", dimension: "safety", metric: "free-cash-flow", all: [{ metric: "free-cash-flow", flipped: "toNegative" }], persist: 1, level: "watch" },
  { id: "external-funding", dimension: "safety", metric: "external-funding", all: [{ metric: "external-funding", on: "value", op: ">", value: 50 }, { metric: "free-cash-flow", on: "value", op: "<", value: 0 }], persist: 1, level: "alert" },
  { id: "leverage-high", dimension: "safety", metric: "net-debt-to-ebitda", all: [{ metric: "net-debt-to-ebitda", on: "value", op: ">", value: 3 }], persist: 1, level: "alert" },
  { id: "leverage-rising", dimension: "safety", metric: "net-debt-to-ebitda", all: [{ metric: "net-debt-to-ebitda", on: "yoy", op: ">", value: 1 }], persist: 1, level: "watch" },
  { id: "liquidity-thin", dimension: "safety", metric: "current-ratio", all: [{ metric: "current-ratio", on: "value", op: "<", value: 1 }], persist: 1, level: "watch" },
  { id: "maturity-wall", dimension: "safety", metric: "debt-due-coverage", all: [{ metric: "debt-due-coverage", on: "value", op: "<", value: 1 }], persist: 1, level: "alert" },
  { id: "runway-short", dimension: "safety", metric: "cash-runway", all: [{ metric: "cash-runway", on: "value", op: "<", value: 18 }], persist: 1, level: "alert" },
  { id: "interest-burden", dimension: "safety", metric: "interest-burden", all: [{ metric: "interest-burden", on: "value", op: ">", value: 20 }], persist: 1, level: "watch" },
];

/* ---------- Output ---------- */

export type MetricPoint = { periodEnd: string; value: number };

/** A figure as the findings runtime resolves it (the runtime's `ResolvedValue`, stated here so the contract stays declarative). */
export type ResolvedFigure = { value: number; unit: "USD" | "percent" | "per_share" | "shares" | "ratio" | "points"; currency: string | null; periodStart: string | null; periodEnd: string; span: FindingSpan; accessions: string[] };

/** Where the company's figure stands among its comparable peers at the same span, each peer at its aligned quarter. */
export type PeerRank = {
  /** 1 is best by the metric's direction. */
  rank: number;
  of: number;
  rows: Array<{ ticker: string; value: number; periodEnd: string; own: boolean }>;
};

export type AssessedMetric = {
  id: string;
  dimension: StatementDimension;
  label: string;
  ref: FindingRef;
  measure: MetricMeasure;
  form: MetricForm;
  span: FindingSpan;
  better: MetricBetter;
  /** Quarterly points in display units, oldest first: up to nine, ending at the report; gaps are left out. */
  series: MetricPoint[];
  /** The report's point, with what it resolved from. */
  current: { value: number; resolved: ResolvedFigure };
  /** Change against a year earlier and the prior quarter, in display units: points for a rate, turns for a multiple, percent for an amount. */
  yoy: number | null;
  qoq: number | null;
  /** The reader's evidence for this metric at the report, as a finding would cite it. */
  evidence: FindingEvidence;
};

export type Flag = {
  ruleId: string;
  level: FlagLevel;
  dimension: StatementDimension;
  metricId: string;
  /** The flagged metric's value at the report, in display units. */
  value: number;
  /** The rule as a formula in the reader's language: "< 0.8×, 2 quarters" / "< 0.8倍，连续 2 季". */
  threshold: string;
  /** The oldest quarter of the run that ends at the report. */
  since: string;
  /** What the three statement views light while the flag is in focus, in the findings' own shape. */
  anchors: AnalysisFinding["anchors"];
  evidence: FindingEvidence[];
};

export type AssessedDimension = {
  id: StatementDimension;
  metrics: AssessedMetric[];
  flags: Flag[];
  /** Metrics the presentation enables and, of those, how many resolved at the report. */
  total: number;
  covered: number;
};

/**
 * One step of the profit-to-cash bridge, signed as it moves cash (capex negative), or a running total (operating cash
 * flow, free cash flow, the net change) marked `total`. A reference, when one exists, resolves the figure the statement
 * states for it, in the sign the findings runtime gives it.
 */
export type BridgeStep = { id: string; label: string; value: number; ref: FindingRef | null; total?: true };
export type CashBridge = {
  span: FindingSpan;
  periodEnd: string;
  currency: string;
  steps: BridgeStep[];
  /** Cash at the start and end of the span, from the balance sheets, when both are held. */
  openingCash: number | null;
  closingCash: number | null;
  /** The steps sum to the statement's net change within rounding. */
  closes: boolean;
};

/** Four series indexed to the oldest quarter held (= 100), so the reader sees whether revenue and cash followed the capital put in. */
export type CapitalChain = {
  base: string;
  series: Array<{ id: "capex" | "productive" | "revenue" | "operatingCashFlow"; label: string; ref: FindingRef; span: FindingSpan; points: Array<MetricPoint & { index: number }> }>;
};

export type StatementAssessment = {
  version: typeof STATEMENT_ANALYSIS_VERSION;
  periodEnd: string;
  model: IncomeModel;
  dimensions: AssessedDimension[];
  /** Every flag, alerts first, then watches, then notes; within a level, the furthest past its threshold first. */
  flags: Flag[];
  bridge: { quarter: CashBridge | null; year: CashBridge | null };
  chain: CapitalChain | null;
};
