/**
 * The fixed Chinese for recurring financial terms (docs/i18n-conventions.md). The interface tables use these words,
 * and the pipeline's translator is told to use them, so a term reads the same in a label and in a sentence.
 */
export const GLOSSARY_ZH: ReadonlyArray<readonly [string, string]> = [
  ["revenue", "营收"], ["cost of revenue", "营业成本"], ["gross profit", "毛利"], ["gross margin", "毛利率"],
  ["operating expenses", "营业费用"], ["research and development", "研发费用"], ["sales and marketing", "销售及市场费用"],
  ["general and administrative", "管理费用"], ["operating income", "营业利润"], ["operating margin", "营业利润率"],
  ["pretax income", "税前利润"], ["income tax", "所得税"], ["net income", "净利润"], ["net margin", "净利率"],
  ["operating cash flow", "经营现金流"], ["capital expenditures (capex)", "资本开支"], ["free cash flow", "自由现金流"],
  ["buybacks", "回购"], ["dividends", "分红"], ["balance sheet", "资产负债表"], ["cash flow", "现金流"],
  ["remaining performance obligations (RPO)", "剩余履约义务（RPO）"], ["backlog", "订单储备"], ["guidance", "业绩指引"],
  ["raised / lowered / reaffirmed guidance", "上调 / 下调 / 重申指引"], ["constant currency", "固定汇率"],
  ["year over year (YoY)", "同比"], ["quarter over quarter (QoQ)", "环比"], ["fiscal year", "财年"], ["quarter", "季度"],
  ["segment", "业务分部"], ["insider", "内部人"], ["10b5-1 plan", "10b5-1 交易计划"], ["basis", "口径"],
  ["percentage points", "个百分点"], ["not disclosed", "未披露"],
  ["accruals", "应计项"], ["invested capital", "投入资本"], ["net debt", "净债务"], ["return on invested capital (ROIC)", "投入资本回报率（ROIC）"],
  ["return on equity (ROE)", "净资产收益率（ROE）"], ["cash runway", "现金跑道"], ["return on added capital", "增量资本回报"], ["operating leverage", "经营杠杆"],
];
