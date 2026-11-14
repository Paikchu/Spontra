import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { markContent } from "./vitals";
import { Button } from "@/packages/web/src/ui/button";
import { labels, messages, useLocale } from "@/packages/web/src/i18n";
import { SourceLanguage, langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { compactMoney, compactShares, perShare } from "@/shared/analysis-runtime/locale";
import { CONFIDENCES, CONFIDENCE_RULES, DIMENSION_TEMPLATE, DIMENSION_WEIGHTS, DISCOUNT_RATE_COMPONENTS, EXTENDED_SCENARIO_KEYS, SCORE_ANCHOR_LEVELS, VALUATION_DIMENSIONS, VALUATION_METHODS, type ScenarioEntry, type ValuationEvidence, type ValuationPublication, type ValuationResponse } from "@/shared/analysis-contract/valuation";
import type { ValuationPriceGuide } from "@/shared/analysis-contract/price-guide";
import { modelAtReferencePrice } from "@/shared/analysis-runtime/valuation/current-price";
import { track } from "./track";
import { citationOrder, pathLeaf, proseBlocks, proseParts } from "./valuation-prose";
import { Radar } from "./ValuationCharts";
import "./valuation.css";

/**
 * The assessment as one document: the composite score and the reference close in the head, the five dimensions on the
 * fixed radar beside their scores, the model's three scenarios in one table with the figures that compare them to the
 * price, the written report, then each dimension's judgement. How the value was computed stays folded under the model;
 * every number is Spontra Analysis's.
 */
const m = messages({
  title: "Valuation assessment",
  compositeScore: "Composite score", outOfTen: "/ 10", sourcesCount: (n: number) => `${n} sources`,
  scores: "Five-dimension research score", partialResearch: "Research so far", researched: (date: string) => `Researched ${date}`,
  template: "Scoring template", templateNote: "The same five dimensions, weights and anchors for every company; a score names the anchor it was given against.", phaseResearch: "research phase", phaseAssumptions: "assumptions phase",
  compositeRule: "Composite is the weighted sum to one decimal, empty while any dimension is unscored; overall confidence is the lowest of the five.",
  report: "Assessment report", valueSource: "Where the value comes from", horizonNote: (months: number, rate: string) => `Every value is the equity's value ${months} months after the research date: the present-value model rolled forward at its ${rate} discount rate; dividends and buybacks within the period are not deducted.`,
  score: "Composite score", unscored: "Not scored", confidence: "Confidence",
  researchDate: "Research date", financialBase: "Statements to", generated: (date: string) => `Generated ${date}`,
  preparing: "The assessment is being prepared", preparingNote: "Research runs over the filings, figures and calls on file; the report appears here once it is written and checked.",
  failed: "The last assessment did not complete", failedNote: "A new attempt starts when the company's material changes or the assessment is requested again.",
  insufficient: "Assessment incomplete", insufficientNote: "The available research is shown below; scores are withheld until the assessment is complete.",
  updating: "A newer assessment is in progress", attemptNotPublished: (date: string) => `The assessment of ${date} was not published.`, attemptFailed: "The latest assessment could not be completed.", attemptCounterEvidence: "Its review left decisive counter-evidence unanswered, so its assumptions need another look.", attemptIncomplete: "The latest assessment is incomplete.", attemptReview: "Its review did not complete.", attemptInsufficient: "It did not establish enough to replace the current report.", retained: (date: string) => `The report researched on ${date} stays in force.`,
  dimensions: "Five dimensions", weight: (value: string) => `Weight ${value}`, composite: (score: string) => `Composite ${score} of 10`, citedAs: (n: string) => `Source ${n}`,
  readThesis: "Read the full thesis", hideThesis: "Hide the full thesis",

  range: "Value per share, 12 months out", bear: "Bear", base: "Base", bull: "Bull", expected: "Expected", price: "Reference close", priceDate: (date: string) => `Close of ${date}`,
  marginOfSafety: "Margin of safety", baseUpside: "To base value", expectedUpside: "To expected value", downside: "Bear case vs. price", noQuote: "No usable reference close",
  model: "Model",
  discountRate: "Discount rate", wacc: "WACC", costOfEquity: "Cost of equity", shares: "Economic shares", dilution: (value: string) => ` (incl. dilution reserve ${value})`, rateBasis: (basis: string) => ` (${basis})`, bridge: "Equity bridge", nonOperating: "Non-operating assets", claims: "Debt and other claims",
  scenarios: "Scenarios", probability: "Probability", perShareValue: "Per share", terminalShare: "Terminal value share", growth: "Revenue growth", margin: "Operating margin", drivers: "Average over five years",
  sensitivities: "Sensitivity of the base value", implied: "What the price implies", impliedText: (implied: string, base: string) => `A constant revenue growth of ${implied} a year reproduces the reference close; the base case averages ${base}.`, impliedNotConverged: "The reference close lies outside what the model's growth range can reproduce.",
  limitations: "Model limitations", inputs: "Model inputs", triggers: "Triggers", invalidation: "Invalidation", showModel: "Show model inputs", hideModel: "Hide model inputs",
  summary: "Summary", thesis: "Thesis", expectationsGap: "Expectations gap", catalysts: "Catalysts", counterEvidence: "Counter-evidence", nextChecks: "Next checks", modelNotes: "Model notes",
  evidence: "Supporting evidence", counter: "Against", gaps: "Gaps", nextCheck: "Next check", diagnostics: "Diagnostics", sources: "Sources", source: "Source", openSource: "Open the filing", snapshot: "As read when the report was written", close: "Close",
  history: "History of each factor", years: (n: number) => `${n} years`, median: "Median", rangeLabel: "Range",
  // valuation.calc.v4: the methods and their judged weights, the four scenarios and their probabilities, the comparable set, the checks, management's targets and the consensus.
  expectedValue: "Scenario-weighted value", expectedNote: "Probability-weighted over the bear, base, management and bull scenarios; the headline base value weighs the cash-flow model with the forward multiples at the weights below.",
  methods: "Valuation methods", methodLow: "Low (peer p25)", methodBase: "Base (peer median)", methodHigh: "High (peer p75)", weightCol: "Weight", notApplied: "Not applied", why: "Why",
  dcfValue: "Cash-flow value", weightedValue: "Weighted value", management: "Management", probabilities: "Scenario probabilities", managementScenarioNote: "Computed by code from management's cited targets on the base case's rate, shares, bridge and horizon; weighed by its judged probability, never the base.",
  yearlyForecast: "Base case yearly forecast", forecastYear: (year: number) => `Year ${year}`, revenueCol: "Revenue", nopatCol: "NOPAT", capexCol: "CapEx", depreciationCol: "D&A", workingCapitalCol: "ΔNWC", fcffCol: "FCFF", reinvestmentCol: "Reinvestment", adjustmentCol: "Adjustment",
  explicitCapitalPlan: "Uses the annual capital plan: FCFF = NOPAT + D&A − CapEx − ΔNWC, plus any adjustment shown. No additional sales-to-capital reinvestment or build capex is deducted.",
  salesCapitalPlan: "Reinvestment is estimated from revenue changes and includes any additional construction spending. FCFF = NOPAT − reinvestment, plus any adjustment shown.",
  revenuePath: "Revenue path", marginPath: "Margin path", capexPath: "Capex path", rateSources: "Discount rate sources",
  peers: "Comparable set", peerBasisLabel: "Basis", peerQuartiles: (p25: string, median: string, p75: string) => `p25 ${p25} · median ${median} · p75 ${p75}`, peerNone: "No peer multiples were available; the cash-flow model stands alone.",
  checks: "Model checks", checkStatus: "Status", checkDetail: "Detail",
  managementTargets: "Management targets vs base case", yearCol: "Year", fiscalYear: (fy: number) => `FY${fy}`, targetCol: "Target", baseCol: "Base case", gapCol: "Gap", targetSources: "Target sources",
  consensus: "Sell-side consensus", consensusMean: "Mean target", consensusRange: "Range", analysts: (n: number) => `${n} analysts`, consensusUnavailable: "Consensus unavailable", asOf: (date: string) => `as of ${date}`,
  pricePosition: "Price relative to the 12-month fair value", fairRange: "Fair value range, 12 months out", centralValue: "Base value", keyAssumptions: "Key assumptions", stressScenarios: "Scenarios and stress tests", researchAssessment: "Research assessment",
  below: "Below normal operating range", within: "Within normal operating range", above: "Above normal operating range", unable: "Unable to assess",
  lowConfidence: "Low confidence", methodDisagreement: "The valuation methods differ substantially, so confidence in the price comparison is low.",
  lowConfidenceReason: "Key evidence or assumptions remain uncertain, so confidence in the price comparison is low.",
  priceConclusion: (position: string) => `The current price is ${position.toLowerCase()}.`,
  normalRangeNote: "This range covers normal operating assumptions. The bear and bull scenarios below test more adverse or favourable outcomes and can fall outside it; the base value is shared.",
  baseComposition: "Base value by method", compositionEquals: "=", compositionPlus: "+",
  reportSnapshot: (date: string) => `Research written on ${date}. Its commentary records the conditions at that time; the reference close and price comparisons above are updated separately.`,
  reportSnapshotPrice: (price: string, date: string) => `Price used in the original commentary: ${price}, close of ${date}.`,
  impliedBasis: "Implied growth uses the cash-flow method alone, at the same valuation horizon.",
  noPositiveRange: "The model does not support a positive equity value range.", equityShortfall: "Negative values represent a modelled shortfall after senior claims, not a tradable negative share price.", noRange: "A supported fair value range is not available.", noQuoteGuide: "A reference quote is not available.", unusableQuote: "The reference quote cannot be used for this comparison.", staleQuote: "The reference quote is out of date.", currencyMismatch: "The quote and valuation use different currencies.", incompleteResearch: "The research is not complete enough to assess fair value.", unresolvedEvidence: "Key valuation assumptions still need supporting evidence.", reportUpdating: "The current assessment needs updating.",
}, {
  title: "估值评估",
  compositeScore: "综合评分", outOfTen: "/ 10", sourcesCount: (n: number) => `来源 ${n} 条`,
  scores: "五维研究评分", partialResearch: "已获取的研究信息", researched: (date: string) => `${date} 研究`,
  template: "评分模板", templateNote: "每家公司都用同一组维度、权重与锚点；每个分值对应其所落的档位。", phaseResearch: "研究阶段", phaseAssumptions: "假设阶段",
  compositeRule: "综合为加权和，一位小数，任一维度未评分则为空；整体信心取五项中最低。",
  report: "评估报告", valueSource: "价值来源", horizonNote: (months: number, rate: string) => `所有价值均为研究日期之后 ${months} 个月的股权价值：现值模型按 ${rate} 的折现率向前滚动；期内分红与回购未扣除。`,
  score: "综合分", unscored: "未评分", confidence: "置信度",
  researchDate: "研究日期", financialBase: "财务基期", generated: (date: string) => `生成于 ${date}`,
  preparing: "评估正在准备", preparingNote: "研究基于已归档的申报、财务数据与电话会；报告写成并核验后会显示在这里。",
  failed: "上一次评估未完成", failedNote: "公司材料更新或再次请求评估时会开始新的尝试。",
  insufficient: "评估尚未完成", insufficientNote: "下方保留已有研究信息；评估完成前不展示评分。",
  updating: "新的评估正在进行", attemptNotPublished: (date: string) => `${date} 的评估未发布。`, attemptFailed: "本次评估未能完成。", attemptCounterEvidence: "复核发现决定性的反方证据未被回应，假设需要重新审视。", attemptIncomplete: "本次评估尚未完成。", attemptReview: "复核未完成。", attemptInsufficient: "结论不足以替换当前报告。", retained: (date: string) => `沿用 ${date} 研究的报告。`,
  dimensions: "五个维度", weight: (value: string) => `权重 ${value}`, composite: (score: string) => `综合 ${score} 分，满分 10 分`, citedAs: (n: string) => `来源 ${n}`,
  readThesis: "展开完整论证", hideThesis: "收起完整论证",

  range: "12 个月后每股价值", bear: "悲观", base: "基准", bull: "乐观", expected: "期望", price: "参考收盘价", priceDate: (date: string) => `${date} 收盘`,
  marginOfSafety: "安全边际", baseUpside: "至基准价值", expectedUpside: "至期望价值", downside: "悲观情景相对现价", noQuote: "无可用参考收盘价",
  model: "模型",
  discountRate: "折现率", wacc: "加权平均资本成本", costOfEquity: "权益成本", shares: "经济股数", dilution: (value: string) => `（含稀释储备 ${value}）`, rateBasis: (basis: string) => `（${basis}）`, bridge: "股权桥接", nonOperating: "非经营资产", claims: "债务及其他索偿",
  scenarios: "情景", probability: "概率", perShareValue: "每股", terminalShare: "终值占比", growth: "收入增长", margin: "营业利润率", drivers: "五年平均",
  sensitivities: "基准价值的敏感性", implied: "现价隐含的预期", impliedText: (implied: string, base: string) => `收入每年恒定增长 ${implied} 即可复现参考收盘价；基准情景平均为 ${base}。`, impliedNotConverged: "参考收盘价超出模型增长区间能复现的范围。",
  limitations: "模型局限", inputs: "模型输入", triggers: "触发信号", invalidation: "失效条件", showModel: "展开模型输入", hideModel: "收起模型输入",
  summary: "结论", thesis: "论证", expectationsGap: "预期差", catalysts: "催化", counterEvidence: "反证", nextChecks: "下一验证点", modelNotes: "模型说明",
  evidence: "支持证据", counter: "反证", gaps: "缺口", nextCheck: "下一验证点", diagnostics: "诊断指标", sources: "来源", source: "来源", openSource: "打开申报原文", snapshot: "报告写成时读取的快照", close: "关闭",
  history: "各因子历史", years: (n: number) => `${n} 年`, median: "中位数", rangeLabel: "区间",
  expectedValue: "情景加权值", expectedNote: "按悲观、基准、管理层与乐观四个情景的概率加权；标题的基准价值按下方权重将现金流模型与远期倍数加权。",
  methods: "估值方法", methodLow: "低（同业 25 分位）", methodBase: "基准（同业中位）", methodHigh: "高（同业 75 分位）", weightCol: "权重", notApplied: "未采用", why: "理由",
  dcfValue: "现金流折现值", weightedValue: "加权价值", management: "管理层", probabilities: "情景概率", managementScenarioNote: "由代码按管理层引用的目标、在基准情景的折现率、股数、桥接与期限上算出；按其判断的概率加权，从不作为基准。",
  yearlyForecast: "基准情景逐年预测", forecastYear: (year: number) => `第 ${year} 年`, revenueCol: "收入", nopatCol: "税后经营利润", capexCol: "资本开支", depreciationCol: "折旧摊销", workingCapitalCol: "营运资本变动", fcffCol: "企业自由现金流", reinvestmentCol: "再投资", adjustmentCol: "调整",
  explicitCapitalPlan: "按逐年资本计划计算：企业自由现金流 = 税后经营利润 + 折旧摊销 − 资本开支 − 营运资本变动，另加表中列示的调整；不再重复扣减按销售资本比估算的再投资或额外建设资本开支。",
  salesCapitalPlan: "再投资按收入变化估算，并包含额外建设支出。企业自由现金流 = 税后经营利润 − 再投资，另加表中列示的调整。",
  revenuePath: "收入路径", marginPath: "利润率路径", capexPath: "资本开支路径", rateSources: "折现率来源",
  peers: "可比公司", peerBasisLabel: "依据", peerQuartiles: (p25: string, median: string, p75: string) => `25 分位 ${p25} · 中位 ${median} · 75 分位 ${p75}`, peerNone: "没有可用的同业倍数；仅有现金流模型。",
  checks: "模型校验", checkStatus: "状态", checkDetail: "说明",
  managementTargets: "管理层目标与基准情景", yearCol: "年份", fiscalYear: (fy: number) => `${fy} 财年`, targetCol: "目标", baseCol: "基准情景", gapCol: "差距", targetSources: "目标来源",
  consensus: "卖方共识", consensusMean: "目标均值", consensusRange: "区间", analysts: (n: number) => `${n} 位分析师`, consensusUnavailable: "无可用市场共识", asOf: (date: string) => `截至 ${date}`,
  pricePosition: "股价相对 12 个月合理价值", fairRange: "12 个月合理价值区间", centralValue: "基准价值", keyAssumptions: "关键假设", stressScenarios: "情景与压力测试", researchAssessment: "研究评价",
  below: "低于正常经营区间", within: "处于正常经营区间", above: "高于正常经营区间", unable: "暂无法判断",
  lowConfidence: "置信度低", methodDisagreement: "不同估值方法的结果分歧较大，因此当前价格比较的置信度低。",
  lowConfidenceReason: "部分关键证据或假设仍不确定，因此当前价格比较的置信度低。",
  priceConclusion: (position: string) => `当前股价${position}。`,
  normalRangeNote: "此区间对应正常经营假设。下方悲观与乐观情景分别检验更不利和更有利的结果，可以落在该区间之外；两者共用同一基准价值。",
  baseComposition: "基准价值的计算构成", compositionEquals: "=", compositionPlus: "+",
  reportSnapshot: (date: string) => `研究撰写于 ${date}，正文保留当时的判断；上方参考收盘价及价格比较单独更新。`,
  reportSnapshotPrice: (price: string, date: string) => `原文采用的历史价格：${price}（${date} 收盘）。`,
  impliedBasis: "隐含增长仅使用现金流法，与页面采用相同估值期限。",
  noPositiveRange: "模型尚不能支持正的股权价值区间。", equityShortfall: "负值表示模型中扣除优先索偿后的权益缺口，不是可交易的负股价。",
  noRange: "尚无有证据支持的合理价值区间。", noQuoteGuide: "暂无参考报价。", unusableQuote: "参考报价暂不适用于本次比较。", staleQuote: "参考报价已过期。", currencyMismatch: "报价与估值的币种不一致。", incompleteResearch: "研究材料尚不足以判断合理价值。", unresolvedEvidence: "关键估值假设仍缺少支持证据。", reportUpdating: "当前估值需要重新评估。",
});
const METHOD = labels({ dcf: "Discounted cash flow", ev_ebitda_forward: "EV/EBITDA, forward", pe_forward: "P/E, forward" }, { dcf: "现金流折现", ev_ebitda_forward: "远期 EV/EBITDA", pe_forward: "远期 P/E" });
const RATE_COMPONENT = labels({ riskFree: "Risk-free rate", beta: "Beta", equityRiskPremium: "Equity risk premium", costOfDebt: "Cost of debt", taxRate: "Tax rate", equityWeight: "Equity weight" }, { riskFree: "无风险利率", beta: "贝塔", equityRiskPremium: "股权风险溢价", costOfDebt: "债务成本", taxRate: "税率", equityWeight: "权益权重" });
const PRICE_TONE: Record<"below" | "within" | "above", string> = { below: "up", within: "neutral", above: "loss" };
function guideReason(reason: Extract<ValuationPriceGuide, { status: "unavailable" }>["reason"]): string {
  switch (reason) {
    case "no_range": return m.noRange;
    case "non_positive_range": return m.noPositiveRange;
    case "no_quote": return m.noQuoteGuide;
    case "unusable_quote": return m.unusableQuote;
    case "stale_quote": return m.staleQuote;
    case "currency_mismatch": return m.currencyMismatch;
    case "incomplete_research": return m.incompleteResearch;
    case "unresolved_evidence": return m.unresolvedEvidence;
    case "report_updating": return m.reportUpdating;
  }
}
const CONF = labels({ high: "High", medium: "Medium", low: "Low" }, { high: "高", medium: "中", low: "低" });
const DIM = labels({ businessQuality: "Business quality", growthExecution: "Growth delivery", valuationSafety: "Valuation safety", mispricingCatalysts: "Mispricing and catalysts", financialResilience: "Financial resilience" }, { businessQuality: "生意质量", growthExecution: "增长兑现", valuationSafety: "估值安全", mispricingCatalysts: "错杀与催化", financialResilience: "财务韧性" });
/** The template's anchors in each locale: English is the contract's own text, the one the researcher scored against. */
type AnchorKey = `${(typeof VALUATION_DIMENSIONS)[number]}.${(typeof SCORE_ANCHOR_LEVELS)[number]}`;
const ANCHOR = labels<AnchorKey>(Object.fromEntries(VALUATION_DIMENSIONS.flatMap(key => SCORE_ANCHOR_LEVELS.map((level, i) => [`${key}.${level}`, DIMENSION_TEMPLATE[key].anchors[i]]))) as Record<AnchorKey, string>, {
  "businessQuality.2": "客户价值或商业模式明显受损", "businessQuality.4": "产品可替代，定价权弱", "businessQuality.6": "模式成立，客户价值稳定，优势平常", "businessQuality.8": "留存、转换成本或其他优势跨期可见", "businessQuality.10": "优势经多来源、多周期验证，所有重大反方意见已回应（罕见）",
  "growthExecution.2": "核心需求与每股经济性恶化，计划落空", "growthExecution.4": "增长乏力，或靠并购、提价、会计取得", "growthExecution.6": "核心增长与计划大体兑现，现金转化可解释", "growthExecution.8": "有机增长、利润、现金与经营指标一致", "growthExecution.10": "跨期兑现且单位经济改善，来源可核（不以单一高基数比较判定）",
  "valuationSafety.2": "合理情景下没有支撑", "valuationSafety.4": "基准价值缺乏缓冲，依赖乐观假设", "valuationSafety.6": "价格低于有支撑的基准价值，但压力情景仍会受伤", "valuationSafety.8": "折价明确，关键假设可核，压力下仍有支撑", "valuationSafety.10": "多种方法与压力测试一致（罕见）",
  "mispricingCatalysts.2": "永久性损害已确认，论点被推翻", "mispricingCatalysts.4": "只有回撤、低倍数或叙事", "mispricingCatalysts.6": "有合理的变体观点与可跟踪的催化，但市场定价证据少", "mispricingCatalysts.8": "预期（或价格隐含路径）与基准情景的差距可核，催化可量化且有窗口", "mispricingCatalysts.10": "差距、未定价程度与路径均有独立证据（已公告的事件不算未定价）",
  "financialResilience.2": "持续经营、再融资或资本结构风险已证实", "financialResilience.4": "债务、再融资或投资压力，缓冲薄", "financialResilience.6": "现金、债务与投资大体匹配，风险有界", "financialResilience.8": "缓冲可承受压力，稀释与承诺透明", "financialResilience.10": "跨周期强健，资本配置与权益主张全部核实（不以净现金单独判定）",
});
const CONF_RULE = labels(CONFIDENCE_RULES, { high: "关键事实均为一手，跨期可比，矛盾已解释", medium: "事实有据，但前瞻假设或市场定价不确定", low: "重要来源、口径或覆盖缺口未闭合" });
const MODEL_TYPE = labels({ fcff: "Free cash flow to the firm (driver-based)", fcfe: "Free cash flow to equity", revenue_fcfe: "Revenue-driven equity cash flow", residual_income: "Residual income", earnings_multiple: "Guided earnings multiple", reported_earnings_multiple: "Reported earnings multiple", proforma_earnings_multiple: "Pro forma earnings multiple", asset_nav: "Net asset value", affo_multiple: "AFFO multiple", affo_dcf: "AFFO discounted cash flow" }, { fcff: "企业自由现金流（驱动因子）", fcfe: "股权自由现金流", revenue_fcfe: "收入驱动股权现金流", residual_income: "剩余收益", earnings_multiple: "指引盈利倍数", reported_earnings_multiple: "已报盈利倍数", proforma_earnings_multiple: "备考盈利倍数", asset_nav: "资产净值", affo_multiple: "AFFO 倍数", affo_dcf: "AFFO 现金流折现" });
const FACTOR = labels({ revenueGrowth: "Revenue growth", operatingMargin: "Operating margin", netMargin: "Net margin", fcfMargin: "Free cash flow margin", capexToRevenue: "Capex to revenue", sbcToRevenue: "Stock compensation to revenue", returnOnEquity: "Return on equity", discountRate: "Discount rate", salesToCapital: "Sales to capital", terminalGrowth: "Terminal growth", capex: "Capital expenditure", terminalRoic: "Terminal ROIC", roe: "Return on equity", terminalRoe: "Terminal ROE", multiple: "Multiple", assetPrices: "Asset prices", afterSbcEquityCashMargin: "Equity cash margin" }, { revenueGrowth: "收入增长", operatingMargin: "营业利润率", netMargin: "净利率", fcfMargin: "自由现金流利润率", capexToRevenue: "资本开支占收入", sbcToRevenue: "股权激励占收入", returnOnEquity: "净资产收益率", discountRate: "折现率", salesToCapital: "销售资本比", terminalGrowth: "终值增长", capex: "资本开支", terminalRoic: "终值投入资本回报率", roe: "净资产收益率", terminalRoe: "终值净资产收益率", multiple: "倍数", assetPrices: "资产价格", afterSbcEquityCashMargin: "股权现金利润率" });

const pct = (v: number | null | undefined, digits = 1) => v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "" : "−"}${(Math.abs(v) * 100).toFixed(digits)}%`;
const signedPct = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${(Math.abs(v) * 100).toFixed(1)}%`;
const day = (iso: string) => iso.slice(0, 10);
/** A figure the model produced; one it could not is left out rather than shown as a dash. */
const has = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
const isEvidenceId = (id: string) => /^e[0-9a-f]{10}$/.test(id);

/** Footnote numbers and source names for the evidence the report cites, in reading order. */
type Footnotes = { order: Map<string, number>; names: Map<string, string> };
const FootnotesContext = createContext<Footnotes>({ order: new Map(), names: new Map() });

function sourceName(e: ValuationEvidence): string {
  const leaf = pathLeaf(e.path);
  return leaf && leaf !== e.title ? `${e.title} · ${leaf}` : e.title;
}

/** One or more citations as superscript footnote numbers; each opens its source's snapshot. */
function Cites({ ids, onCite }: { ids: string[]; onCite: (id: string) => void }) {
  const { order, names } = useContext(FootnotesContext);
  return <sup className="val-refs">
    {ids.map((id, i) => {
      const n = order.get(id);
      return <Fragment key={`${id}-${i}`}>{i > 0 && ","}<Button variant="unstyled" type="button" className="val-ref" title={names.get(id)} aria-label={m.citedAs(String(n ?? "?"))} onClick={() => onCite(id)}>{n ?? "?"}</Button></Fragment>;
    })}
  </sup>;
}

/** Legacy report wording is presented without implementation identifiers; figures and citations are untouched. */
function readerText(text: string): string {
  const zh = /[\u3400-\u9fff]/.test(text);
  return text
    .replace(/\bdebtDueCoverage\b/g, zh ? "短期到期债务覆盖倍数" : "short-term debt coverage")
    .replace(/\bcashRunway(?:Years|Months)?\b/g, key => zh ? `现金可支撑时长${key.endsWith("Years") ? "（年）" : key.endsWith("Months") ? "（月）" : ""}` : `cash runway${key.endsWith("Years") ? " (years)" : key.endsWith("Months") ? " (months)" : ""}`)
    .replace(/事实集中/g, "现有财务资料中").replace(/验证集中/g, "已核实资料中")
    .replace(/研究阶段在该维度记录之前结束[。.]?/g, "该项评估尚未完成。")
    .replace(/Not assessed: the research phase ended before this dimension was recorded\./g, "This part of the assessment is not yet complete.");
}

const hasCompleteScores = (report: ValuationPublication) => report.reportStatus === "ready"
  && report.weightedScore != null && Number.isFinite(report.weightedScore)
  && VALUATION_DIMENSIONS.every(key => report.dimensions.some(d => d.key === key && d.score != null && Number.isFinite(d.score)));

function baseMethods(report: ValuationPublication) {
  const valuation = report.model?.scenarios.base.valuation;
  return valuation ? VALUATION_METHODS.flatMap(key => {
    const value = valuation.methods[key], weight = valuation.weights[key];
    return value != null && weight > 0 ? [{ key, value, weight }] : [];
  }) : [];
}

function methodsDisagree(report: ValuationPublication): boolean {
  const values = baseMethods(report).map(method => method.value);
  if (values.length < 2) return false;
  const low = Math.min(...values), high = Math.max(...values);
  return low <= 0 ? high > 0 : high / low > 3;
}

function ResearchSnapshot({ report }: { report: ValuationPublication }) {
  const locale = useLocale();
  return <p className="val-note val-research-note">{m.reportSnapshot(day(report.generatedAt))} {report.quote && m.reportSnapshotPrice(perShare(report.quote.price, report.quote.currency, locale), report.quote.priceDate)}</p>;
}

/** Generated prose with its evidence citations turned into footnote numbers. */
function Prose({ text, onCite, as: Tag = "p" }: { text: string; onCite: (id: string) => void; as?: "p" | "li" | "span" }) {
  return <Tag lang={langOf(text)}>{proseParts(readerText(text)).map((part, i) => part.kind === "text" ? part.text : <Cites key={i} ids={part.ids} onCite={onCite} />)}</Tag>;
}

/** A long section: paragraphs, with the report's run-in capitalised headings lifted out as headings. */
function ProseBlocks({ text, onCite }: { text: string; onCite: (id: string) => void }) {
  return <>{proseBlocks(text).map((block, i) => <Fragment key={i}>
    {block.heading && <h5 className="val-runhead" lang={langOf(block.heading)}>{block.heading}</h5>}
    {block.text && <Prose text={block.text} onCite={onCite} />}
  </Fragment>)}</>;
}

/** Reports written before valuation.v11 carried the model's judgements under a JUDGEMENTS heading in the notes; the page keeps only the notes. */
const legacyNotes = (notes: string) => notes.split(/\n*JUDGEMENTS\. /)[0]!.trim();


/** The head: ticker and name; the composite score, the reference close and where it sits against the normal range. */
function Head({ report, guide }: { report: ValuationPublication; guide: ValuationPriceGuide }) {
  const locale = useLocale();
  const disagreement = methodsDisagree(report);
  const lowConfidence = report.confidence === "low" || disagreement;
  return <header className="val-head">
    <div className="val-identity">
      <h2 className="val-ticker">{report.ticker}</h2>
      <span className="val-company" lang="en">{report.companyName}</span>
    </div>
    <div className="val-headline">
      {hasCompleteScores(report) && <><span className="val-headline-label">{m.compositeScore}</span>
      <span className="val-composite"><strong>{report.weightedScore!.toFixed(1)}</strong><small>{m.outOfTen}</small></span></>}
      <span className="val-quote">{guide.quote ? <><b>{perShare(guide.quote.price, guide.quote.currency, locale)}</b><small>{guide.quote.priceDate}</small></> : <small>{m.noQuote}</small>}</span>
      <span className="val-position" data-tone={guide.status === "available" && !lowConfidence ? PRICE_TONE[guide.position] : "neutral"}>{guide.status === "available" ? m[guide.position] : m.unable}{lowConfidence && ` · ${m.lowConfidence}`}</span>
    </div>
    <p className="val-summary">{guide.status === "available" ? m.priceConclusion(m[guide.position]) : guideReason(guide.reason)} {lowConfidence && (disagreement ? m.methodDisagreement : m.lowConfidenceReason)}</p>
  </header>;
}

/** The five dimensions: the fixed radar beside one row per dimension, each with its judgement in full; the template folded under them. */
function Scores({ report, onCite }: { report: ValuationPublication; onCite: (id: string) => void }) {
  const complete = hasCompleteScores(report);
  return <section className="val-block val-scores" data-incomplete={!complete || undefined} aria-label={complete ? m.scores : m.partialResearch}>
    <ResearchSnapshot report={report} />
    {complete && <Radar report={report} label={key => DIM[key]} compact />}
    <div className="val-score-rows">
      <span className="val-score-caption">{complete ? m.scores : m.partialResearch} · {m.researched(day(report.researchAsOf))}{report.confidence !== "medium" && ` · ${m.confidence} ${CONF[report.confidence]}`}</span>
      <ol className="val-dims" aria-label={m.dimensions}>
        {report.dimensions.map(d => <li key={d.key} className="val-dim">
          <span className="val-dim-name">{DIM[d.key]}{complete && <small>{pct(DIMENSION_WEIGHTS[d.key], 0)}</small>}{d.confidence !== "medium" && <small>{m.confidence} {CONF[d.confidence]}</small>}</span>
          {complete && <span className="val-dim-score">{d.score!.toFixed(1)}<small>/10</small></span>}
          <div className="val-dim-judgement">
            <Prose text={d.rationale} onCite={onCite} />
            {d.gaps.length > 0 && <p className="val-note"><b>{m.gaps}</b> {d.gaps.map((g, i) => <span key={i} lang={langOf(g)}>{readerText(g)}{i < d.gaps.length - 1 ? "; " : ""}</span>)}</p>}
          </div>
        </li>)}
      </ol>
      <details className="val-fold val-template">
        <summary>{m.template}</summary>
        <div className="val-fold-body">
          <p className="val-note">{m.templateNote}</p>
          {VALUATION_DIMENSIONS.map(key => <div key={key} className="val-template-dim">
            <h5>{DIM[key]} <small>{m.weight(pct(DIMENSION_WEIGHTS[key], 0))} · {DIMENSION_TEMPLATE[key].phase === "assumptions" ? m.phaseAssumptions : m.phaseResearch}</small></h5>
            <dl className="val-anchors">{SCORE_ANCHOR_LEVELS.map(level => <div key={level}><dt>{level}</dt><dd>{ANCHOR[`${key}.${level}`]}</dd></div>)}</dl>
          </div>)}
          <dl className="val-anchors val-anchors--conf">
            {CONFIDENCES.map(level => <div key={level}><dt>{m.confidence} {CONF[level]}</dt><dd>{CONF_RULE[level]}</dd></div>)}
          </dl>
          <p className="val-note">{m.compositeRule}</p>
        </div>
      </details>
    </div>
  </section>;
}

/** The valuation as the live page shows it: the normal range with its reasons and key assumptions, then the scenarios, the model and its inputs folded under them. */
function FairValue({ report, guide, onCite }: { report: ValuationPublication; guide: ValuationPriceGuide; onCite: (id: string) => void }) {
  const locale = useLocale();
  const fair = report.model?.fairValueRange;
  const supported = fair?.status === "available" && (guide.status === "available" || guide.reason === "no_quote" || guide.reason === "unusable_quote" || guide.reason === "stale_quote" || guide.reason === "currency_mismatch");
  const assumptions = supported ? report.model?.scenarios.base.assumptions : null;
  const methods = baseMethods(report);
  return <section className="val-block val-fair" aria-label={m.pricePosition}>
    <h3>{m.fairRange}</h3>
    <p className="val-fair-value">{supported ? `${perShare(fair.low, report.currency, locale)} – ${perShare(fair.high, report.currency, locale)}` : "—"}</p>
    <dl className="val-stats">
      <div><dt>{m.price}</dt><dd>{guide.quote ? <>{perShare(guide.quote.price, guide.quote.currency, locale)}<small>{m.priceDate(guide.quote.priceDate)}</small></> : m.noQuote}</dd></div>
      {supported && <div><dt>{m.centralValue}</dt><dd>{perShare(fair.base, report.currency, locale)}</dd></div>}
    </dl>
    {supported && <p className="val-note">{m.normalRangeNote}</p>}
    {supported && methods.length > 0 && <div className="val-composition">
      <h4>{m.baseComposition}</h4>
      <p className="val-formula"><strong>{perShare(fair.base, report.currency, locale)}</strong><span>{m.compositionEquals}</span>{methods.map((method, index) => <Fragment key={method.key}>
        {index > 0 && <span>{m.compositionPlus}</span>}<span className="val-formula-term">{METHOD[method.key]} {perShare(method.value, report.currency, locale)} × {pct(method.weight, 0)}</span>
      </Fragment>)}</p>
    </div>}
    {report.model?.forward && <p className="val-list-line">{m.horizonNote(report.model.forward.months, pct(report.model.discountRate.value))}</p>}
    {guide.status === "unavailable" && <p className="val-list-line">{guideReason(guide.reason)}</p>}
    {fair?.status === "unavailable" && fair.reason && <Prose text={fair.reason} onCite={onCite} />}
    {supported && <>
      <p><Prose as="span" text={fair.rationale} onCite={onCite} /> {fair.evidenceIds.length > 0 && <Cites ids={fair.evidenceIds.filter(isEvidenceId)} onCite={onCite} />}</p>
      {assumptions && <div className="val-why-list"><h4>{m.keyAssumptions}</h4>
        {(["revenue", "margin", "capex"] as const).map(key => <p key={key} className="val-why"><b>{m[key === "revenue" ? "revenuePath" : key === "margin" ? "marginPath" : "capexPath"]}</b><Prose as="span" text={assumptions[key].rationale} onCite={onCite} /> <Cites ids={assumptions[key].evidenceIds.filter(isEvidenceId)} onCite={onCite} /></p>)}
      </div>}
    </>}
  </section>;
}

function RangeBar({ report }: { report: ValuationPublication }) {
  const locale = useLocale();
  const model = report.model;
  if (!model) return null;
  const { range } = model;
  const values = [range.low, range.base, range.high, range.expected ?? range.base, range.price ?? range.base].filter(v => Number.isFinite(v));
  const lo = Math.min(...values, 0), hi = Math.max(...values) * 1.08 || 1;
  const x = (v: number) => `${((v - lo) / (hi - lo) * 100).toFixed(2)}%`;
  const money = (v: number) => perShare(v, model.currency, locale);
  const marks: Array<[string, number, string]> = [[m.bear, range.low, "bear"], [m.base, range.base, "base"], [m.bull, range.high, "bull"]];
  // The expected value sits on its own mark unless it all but coincides with another, which then carries both names.
  if (range.expected != null) {
    const near = marks.find(([, v]) => Math.abs(v - range.expected!) <= (hi - lo) * 0.02);
    if (near) near[0] = `${near[0]} · ${m.expected}`; else marks.push([m.expected, range.expected, "expected"]);
  }
  return <div className="val-range" role="img" aria-label={[m.range, ...marks.map(([label, v]) => `${label} ${money(v)}`), ...(range.price != null ? [`${m.price} ${money(range.price)}`] : [])].join(" · ")}>
    <div className="val-range-track">
      <span className="val-range-band" style={{ left: x(range.low), width: `calc(${x(range.high)} - ${x(range.low)})` }} />
      {marks.map(([label, v, kind]) => <span key={kind} className="val-range-mark" data-kind={kind} style={{ left: x(v) }}><i /><b>{money(v)}</b><small>{label}</small></span>)}
      {range.price != null && <span className="val-range-mark val-range-price" style={{ left: x(range.price) }}><i /><b>{money(range.price)}</b><small>{m.price}</small></span>}
    </div>
  </div>;
}

function Sensitivities({ report }: { report: ValuationPublication }) {
  const locale = useLocale();
  const model = report.model;
  if (!model?.sensitivities.length) return null;
  const max = Math.max(...model.sensitivities.map(s => Math.abs(s.changePercent)), 1);
  return <ol className="val-sens" aria-label={m.sensitivities}>
    {model.sensitivities.map(s => <li key={s.factor}>
      <span className="val-sens-label">{FACTOR[s.factor as keyof typeof FACTOR] ?? s.factor} <small>{s.step}</small></span>
      <span className="val-sens-bar"><i data-sign={s.changePercent >= 0 ? "up" : "down"} style={{ width: `${Math.abs(s.changePercent) / max * 100}%` }} /></span>
      <b>{s.changePercent >= 0 ? "+" : "−"}{Math.abs(s.changePercent).toFixed(1)}% · {perShare(s.perShare, model.currency, locale)}</b>
    </li>)}
  </ol>;
}

const avg = (list: number[]) => list.reduce((a, b) => a + b, 0) / Math.max(list.length, 1);

function YearlyForecast({ report }: { report: ValuationPublication }) {
  const locale = useLocale();
  const scenario = report.model?.scenarios.base;
  if (!scenario || scenario.drivers.modelType !== "fcff" || !scenario.result.yearly.length) return null;
  const { path } = scenario.drivers;
  const explicit = !!path.capitalPlan;
  const adjusted = path.normalization?.some(value => value !== 0);
  const money = (value: number | null | undefined) => value == null ? "—" : compactMoney(value, report.currency, locale);
  return <details className="val-fold val-yearly">
    <summary>{m.yearlyForecast}</summary>
    <div className="val-fold-body">
      <p className="val-list-line">{explicit ? m.explicitCapitalPlan : m.salesCapitalPlan}</p>
      <table className="val-table val-table--yearly" tabIndex={0} aria-label={m.yearlyForecast}><thead><tr><th>{m.yearCol}</th><th>{m.revenueCol}</th><th>{m.nopatCol}</th>
        {explicit ? <><th>{m.capexCol}</th><th>{m.depreciationCol}</th><th>{m.workingCapitalCol}</th></> : <th>{m.reinvestmentCol}</th>}
        {adjusted && <th>{m.adjustmentCol}</th>}<th>{m.fcffCol}</th>
      </tr></thead><tbody>
        {scenario.result.yearly.map(row => <tr key={row.year}><th>{m.forecastYear(row.year)}</th><td>{money(row.revenue)}</td><td>{money(row.nopat)}</td>
          {explicit ? <><td>{money(row.capex)}</td><td>{money(row.depreciation)}</td><td>{money(row.workingCapitalChange)}</td></> : <td>{money(row.reinvestment)}</td>}
          {adjusted && <td>{money(path.normalization?.[row.year - 1])}</td>}<td>{money(row.cashFlow)}</td>
        </tr>)}
      </tbody></table>
    </div>
  </details>;
}

function Model({ report, onCite }: { report: ValuationPublication; onCite: (id: string) => void }) {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const model = report.model;
  if (!model) return null;
  const rate = model.discountRate;
  const rows: Array<[keyof typeof m & ("bear" | "base" | "management" | "bull"), ScenarioEntry]> = [["bear", model.scenarios.bear], ["base", model.scenarios.base], ...(model.managementScenario ? [["management", model.managementScenario] as ["management", ScenarioEntry]] : []), ["bull", model.scenarios.bull]];
  const weighted = rows.some(([, s]) => s.valuation);
  return <section className="val-block">
    <h3>{m.model}</h3>
    <p className="val-model-line">{MODEL_TYPE[model.modelType]} · {m.discountRate} {pct(rate.value)}{m.rateBasis(rate.basis === "wacc" ? m.wacc : m.costOfEquity)} · {m.shares} {compactShares(model.shares.economic, locale)}{model.shares.dilutionReserve ? m.dilution(compactShares(model.shares.dilutionReserve, locale)) : ""}</p>
    <table className="val-table"><thead><tr><th>{m.scenarios}</th><th>{weighted ? m.dcfValue : m.perShareValue}</th>{weighted && <th>{m.weightedValue}</th>}<th>{m.probability}</th><th>{m.growth}</th><th>{m.margin}</th><th>{m.terminalShare}</th></tr></thead><tbody>
      {rows.map(([key, s]) => { const d = s.drivers as { path?: { revenueGrowth?: number[]; operatingMargin?: number[] } };
        return <tr key={key}><th>{m[key]}</th><td>{perShare(s.result.perShare, model.currency, locale)}</td>{weighted && <td>{s.valuation ? perShare(s.valuation.perShare, model.currency, locale) : "—"}</td>}<td>{s.probability != null ? pct(s.probability, 0) : "—"}</td><td>{d.path?.revenueGrowth ? pct(avg(d.path.revenueGrowth)) : "—"}</td><td>{d.path?.operatingMargin ? pct(avg(d.path.operatingMargin)) : "—"}</td><td>{s.result.terminalShare != null ? pct(s.result.terminalShare, 0) : "—"}</td></tr>; })}
    </tbody></table>
    <YearlyForecast report={report} />
    {model.scenarioProbabilities && <div className="val-why-list"><h5>{m.probabilities}</h5>
      {EXTENDED_SCENARIO_KEYS.map(key => { const p = model.scenarioProbabilities![key]; return <p key={key} className="val-why"><b>{m[key]} {pct(p.probability, 0)}</b> <Prose as="span" text={p.rationale} onCite={onCite} /> {p.evidenceIds.length > 0 && <Cites ids={p.evidenceIds.filter(isEvidenceId)} onCite={onCite} />}</p>; })}
    </div>}
    {model.implied && <p className="val-implied"><b>{m.implied}</b> {model.implied.converged ? m.impliedText(pct(model.implied.implied), pct(model.implied.baseAverage)) : m.impliedNotConverged} {m.impliedBasis}</p>}
    <h4>{m.sensitivities}</h4>
    <Sensitivities report={report} />
    <Button variant="unstyled" type="button" className="val-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}>{open ? m.hideModel : m.showModel}</Button>
    {open && <div className="val-model-detail">
      <ResearchSnapshot report={report} />
      {rows.map(([key, s]) => <div key={key} className="val-scenario">
        <h5>{m[key]}</h5>
        {key === "management" && <p className="val-list-line">{m.managementScenarioNote}</p>}
        <Prose text={s.narrative} onCite={onCite} />
        {s.assumptions && <p className="val-chips"><span><b>{m.revenuePath}</b> <Prose as="span" text={s.assumptions.revenue.rationale} onCite={onCite} /><Cites ids={s.assumptions.revenue.evidenceIds.filter(isEvidenceId)} onCite={onCite} /></span><span><b>{m.marginPath}</b> <Prose as="span" text={s.assumptions.margin.rationale} onCite={onCite} /><Cites ids={s.assumptions.margin.evidenceIds.filter(isEvidenceId)} onCite={onCite} /></span><span><b>{m.capexPath}</b> <Prose as="span" text={s.assumptions.capex.rationale} onCite={onCite} /><Cites ids={s.assumptions.capex.evidenceIds.filter(isEvidenceId)} onCite={onCite} /></span></p>}
        {s.triggers.length > 0 && <p className="val-list-line"><b>{m.triggers}</b> {s.triggers.map((t, i) => <span key={i} lang={langOf(t)}>{t}{i < s.triggers.length - 1 ? "; " : ""}</span>)}</p>}
        {s.invalidation.length > 0 && <p className="val-list-line"><b>{m.invalidation}</b> {s.invalidation.map((t, i) => <span key={i} lang={langOf(t)}>{t}{i < s.invalidation.length - 1 ? "; " : ""}</span>)}</p>}
        {key === "management" && model.managementScenario && model.managementScenario.sources.length > 0 && <p className="val-list-line"><b>{m.targetSources}</b> {model.managementScenario.sources.map((src, i) => <span key={src.id} lang="en"><a href={src.url} target="_blank" rel="noreferrer noopener">{src.title}</a> ({src.date}){i < model.managementScenario!.sources.length - 1 ? "; " : ""}</span>)}</p>}
      </div>)}
      <p className="val-list-line"><b>{m.bridge}</b> {m.nonOperating} {compactMoney(model.bridge.nonOperatingAssets, model.currency, locale)} · {m.claims} {compactMoney(model.bridge.debtAndClaims, model.currency, locale)}</p>
      <p className="val-list-line" lang={langOf(rate.rationale)}><b>{m.discountRate}</b> {rate.rationale}</p>
      {rate.sources && <p className="val-chips"><b>{m.rateSources}</b>{DISCOUNT_RATE_COMPONENTS.map(key => <span key={key}><b>{RATE_COMPONENT[key]}</b> <span lang="en">{rate.sources![key].source}</span><Cites ids={rate.sources![key].evidenceIds.filter(isEvidenceId)} onCite={onCite} /></span>)}</p>}
      {model.limitations.length > 0 && <p className="val-list-line"><b>{m.limitations}</b> {model.limitations.map((t, i) => <span key={i} lang={langOf(t)}>{t} </span>)}</p>}
      <table className="val-table val-table--facts"><thead><tr><th>{m.inputs}</th><th></th><th></th></tr></thead><tbody>
        {report.facts.map(f => <tr key={f.id}><th lang="en">{f.label}</th><td>{f.unit === "ratio" ? pct(f.value) : f.unit === "shares" ? compactShares(f.value, locale) : compactMoney(f.value, f.currency, locale)}</td><td><small>{f.periodEnd ?? ""} · {f.basis}</small></td></tr>)}
      </tbody></table>
    </div>}
  </section>;
}

/** The recorded reasons the live model block does not already print: each method's weight, management's targets against the base, the consensus. */
function ValueSource({ report, onCite }: { report: ValuationPublication; onCite: (id: string) => void }) {
  const model = report.model;
  if (!model || (!model.methodWeights && !model.managementComparison && !model.consensusNote)) return null;
  const cites = (ids: string[]) => ids.filter(isEvidenceId).length > 0 ? <Cites ids={ids.filter(isEvidenceId)} onCite={onCite} /> : null;
  return <>
    <h4>{m.valueSource}</h4>
    {model.methodWeights && VALUATION_METHODS.map(key => { const w = model.methodWeights![key]; return <p key={key} className="val-why"><b>{METHOD[key]} {w.weight > 0 ? pct(w.weight, 0) : m.notApplied}</b><Prose as="span" text={w.rationale} onCite={onCite} />{cites(w.evidenceIds)}</p>; })}
    {model.managementComparison && <p className="val-why"><b>{m.managementTargets}</b><Prose as="span" text={model.managementComparison.explanation} onCite={onCite} />{cites(model.managementComparison.evidenceIds)}</p>}
    {model.consensusNote && <p className="val-why"><b>{m.consensus}</b>{model.consensusNote.status === "unavailable" ? <span lang={model.consensusNote.reason ? langOf(model.consensusNote.reason) : undefined}>{model.consensusNote.reason ?? m.consensusUnavailable}</span> : <span lang="en">{model.consensusNote.source}</span>}</p>}
  </>;
}

/** The written report in the system's own sections: conclusion, thesis, expectations gap, the recorded value sources, catalysts, next checks, counter-evidence, model notes. */
function Report({ report, onCite }: { report: ValuationPublication; onCite: (id: string) => void }) {
  const s = report.sections;
  const notes = legacyNotes(s.modelNotes);
  const lists: Array<[label: string, items: string[]]> = [[m.catalysts, s.catalysts], [m.nextChecks, s.nextChecks], [m.counterEvidence, s.counterEvidence]];
  if (!s.summary && !s.thesis && !s.expectationsGap && !notes && !lists.some(([, items]) => items.length) && !report.model?.methodWeights && !report.model?.managementComparison && !report.model?.consensusNote) return null;
  return <section className="val-block val-report">
    <h3>{m.report}<SourceLanguage of={[s.summary, s.thesis]} /></h3>
    <ResearchSnapshot report={report} />
    <div className="val-prose">
      {s.summary && <><h4>{m.summary}</h4><ProseBlocks text={s.summary} onCite={onCite} /></>}
      {s.thesis && <><h4>{m.thesis}</h4><ProseBlocks text={s.thesis} onCite={onCite} /></>}
      {s.expectationsGap && <><h4>{m.expectationsGap}</h4><ProseBlocks text={s.expectationsGap} onCite={onCite} /></>}
      <ValueSource report={report} onCite={onCite} />
      {lists.filter(([, items]) => items.length > 0).map(([label, items]) => <Fragment key={label}>
        <h4>{label}</h4>
        <ul className="val-list" aria-label={label}>{items.map((t, i) => <Prose key={i} as="li" text={t} onCite={onCite} />)}</ul>
      </Fragment>)}
      {notes && <><h4>{m.modelNotes}</h4><ProseBlocks text={notes} onCite={onCite} /></>}
    </div>
  </section>;
}

function Sources({ report, open, onOpen, onClose }: { report: ValuationPublication; open: string | null; onOpen: (id: string) => void; onClose: () => void }) {
  const { order } = useContext(FootnotesContext);
  const dialog = useRef<HTMLDialogElement>(null);
  const shown = report.evidence.find(e => e.evidenceId === open) ?? null;
  const listed = [...report.evidence].sort((a, b) => (order.get(a.evidenceId) ?? Infinity) - (order.get(b.evidenceId) ?? Infinity));
  useEffect(() => { const d = dialog.current; if (!d) return; if (shown && !d.open) d.showModal(); else if (!shown && d.open) d.close(); }, [shown]);
  return <section className="val-block val-sources-block">
    <details className="val-fold">
      <summary>{m.sourcesCount(listed.length)} · {m.generated(day(report.generatedAt))}</summary>
      <ol className="val-sources">
        {listed.map(e => <li key={e.evidenceId}><Button variant="unstyled" type="button" className="val-source" onClick={() => onOpen(e.evidenceId)}><b>{order.get(e.evidenceId) ?? "—"}</b><span lang="en">{sourceName(e)}</span><small>{e.publishedAt ? day(e.publishedAt) : ""}</small></Button></li>)}
      </ol>
    </details>
    <dialog ref={dialog} className="val-dialog" onClose={onClose} aria-label={m.source}>
      {shown && <div className="val-dialog-body">
        <header><h3 lang="en">{shown.title}</h3><Button variant="unstyled" type="button" className="icon-button" aria-label={m.close} onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg></Button></header>
        <p className="val-dialog-meta">{shown.path && <span lang="en">{shown.path}</span>}{shown.publishedAt && <span>{day(shown.publishedAt)}</span>}<span>{m.snapshot}</span></p>
        <blockquote lang="en">{shown.excerpt}</blockquote>
        {shown.url && <a href={shown.url} target="_blank" rel="noreferrer noopener" onClick={() => track("source_click", { ticker: report.ticker })}>{m.openSource}</a>}
      </div>}
    </dialog>
  </section>;
}

/** The newest attempt against the shown report: a run in progress, or one that ended without publishing and why. */
function Status({ valuation }: { valuation: ValuationResponse }) {
  const attempt = valuation.latestAttempt, report = valuation.report;
  if (report && valuation.outdated) return <p className="val-banner" data-tone="info">{m.updating}</p>;
  if (report && attempt && attempt.updatedAt > report.generatedAt && ["failed", "empty", "superseded", "cancelled"].includes(attempt.status)) {
    const codes = new Set(attempt.gaps.map(g => g.code));
    const reason = attempt.status === "failed" ? m.attemptFailed : codes.has("unresolved_counter_evidence") ? m.attemptCounterEvidence : codes.has("research_budget_exhausted") ? m.attemptIncomplete : codes.has("review_incomplete") ? m.attemptReview : m.attemptInsufficient;
    return <p className="val-banner" data-tone="warn"><b>{m.attemptNotPublished(day(attempt.updatedAt))}</b> {reason} {m.retained(day(report.researchAsOf))}</p>;
  }
  if (report?.reportStatus === "insufficient") return <p className="val-banner" data-tone="warn"><b>{m.insufficient}</b> {m.insufficientNote}</p>;
  return null;
}

/** The recorded reasons the value-source section prints, in its order, with their evidence ids. */
function valueSourceTexts(model: ValuationPublication["model"]): string[] {
  if (!model) return [];
  const ids = (list: string[]) => list.filter(isEvidenceId).map(id => `[${id}]`).join("");
  const fair = model.fairValueRange, a = model.scenarios.base.assumptions;
  return [
    fair?.status === "available" ? `${fair.rationale} ${ids(fair.evidenceIds)}` : "",
    ...(a ? [a.revenue, a.margin, a.capex].map(x => `${x.rationale} ${ids(x.evidenceIds)}`) : []),
    ...VALUATION_METHODS.map(k => model.methodWeights ? `${model.methodWeights[k].rationale} ${ids(model.methodWeights[k].evidenceIds)}` : ""),
    ...EXTENDED_SCENARIO_KEYS.map(k => model.scenarioProbabilities ? `${model.scenarioProbabilities[k].rationale} ${ids(model.scenarioProbabilities[k].evidenceIds)}` : ""),
    model.managementComparison ? `${model.managementComparison.explanation} ${ids(model.managementComparison.evidenceIds)}` : "",
  ].filter(Boolean);
}

/** Footnotes numbered as the page reads: the dimensions' judgements, the written report with its value sources, then the folded inputs. */
function footnotesOf(report: ValuationPublication): Footnotes {
  const s = report.sections;
  const fair = report.model?.fairValueRange;
  const rate = report.model?.discountRate;
  const texts = [
    fair?.status === "unavailable" ? fair.reason : "",
    ...report.dimensions.flatMap(d => [d.rationale, ...d.supportingEvidenceIds, ...d.counterEvidenceIds]),
    s.summary, s.thesis, s.expectationsGap, ...valueSourceTexts(report.model), ...s.catalysts, ...s.nextChecks, ...s.counterEvidence,
    legacyNotes(s.modelNotes),
    ...(rate?.sources ? DISCOUNT_RATE_COMPONENTS.flatMap(k => rate.sources![k].evidenceIds) : []),
  ].filter(Boolean);
  return { order: citationOrder(texts, report.evidence.map(e => e.evidenceId)), names: new Map(report.evidence.map(e => [e.evidenceId, sourceName(e)])) };
}

export function ValuationPanel({ ticker, valuation }: { ticker: string; valuation: ValuationResponse }) {
  useEffect(() => { markContent("company"); }, []);
  const [open, setOpen] = useState<string | null>(null);
  // Another company starts with no source open.
  const [shownTicker, setShownTicker] = useState(ticker);
  if (shownTicker !== ticker) { setShownTicker(ticker); setOpen(null); }
  // One report per period: the current publication, never a picked older version.
  const locale = useLocale();
  const storedReport = valuation.report;
  const guide: ValuationPriceGuide = valuation.priceGuide && valuation.priceGuide.reportVersionId === storedReport?.versionId ? valuation.priceGuide : { status: "unavailable", reportVersionId: storedReport?.versionId ?? null, quote: null, reason: storedReport?.model?.fairValueRange?.status === "available" ? "no_quote" : "no_range" };
  const price = guide.status === "available" ? guide.quote.price : null;
  const model = useMemo(() => storedReport?.model ? modelAtReferencePrice(storedReport.model, price) : null, [storedReport?.model, price]);
  const report = storedReport ? { ...storedReport, model } : null;
  const range = report?.model?.range;
  const footnotes = useMemo(() => storedReport ? footnotesOf(storedReport) : null, [storedReport]);
  if (!report || !footnotes) {
    const failed = valuation.availability === "failed";
    return <section className="lens val-panel val-panel--empty" aria-label={m.title}>
      <div className="lens-empty val-empty"><h2>{failed ? m.failed : m.preparing}</h2><p>{failed ? m.failedNote : m.preparingNote}</p>{!failed && <i className="lens-loading" />}</div>
    </section>;
  }
  return <FootnotesContext.Provider value={footnotes}><section className="lens val-panel" aria-label={m.title}>
    <div className="lens-doc val-doc">
      <Head report={report} guide={guide} />
      <Status valuation={valuation} />
      <FairValue report={report} guide={guide} onCite={setOpen} />
      {report.model && <section className="val-block"><details className="val-fold val-stress" open>
        <summary>{m.stressScenarios}</summary>
        <div className="val-fold-body">
        <h3>{m.range}</h3>
        <RangeBar report={report} />
        {range && range.low < 0 && <p className="val-list-line">{m.equityShortfall}</p>}
        <dl className="val-stats">
          <div><dt>{m.price}</dt><dd>{guide.quote ? <>{perShare(guide.quote.price, guide.quote.currency, locale)}<small>{m.priceDate(guide.quote.priceDate)}</small></> : m.noQuote}</dd></div>
          {has(range?.expected) && <div><dt>{m.expectedValue}</dt><dd>{perShare(range!.expected!, report.model!.currency, locale)}</dd></div>}
          {has(range?.marginOfSafety) && <div><dt>{m.marginOfSafety}</dt><dd data-sign={range!.marginOfSafety! >= 0 ? "up" : "down"}>{pct(range!.marginOfSafety)}</dd></div>}
          {has(range?.baseUpside) && <div><dt>{m.baseUpside}</dt><dd>{signedPct(range!.baseUpside)}</dd></div>}
          {has(range?.expectedUpside) && <div><dt>{m.expectedUpside}</dt><dd>{signedPct(range!.expectedUpside)}</dd></div>}
          {has(range?.downsideCoverage) && <div><dt>{m.downside}</dt><dd>{signedPct(range!.downsideCoverage)}</dd></div>}
        </dl>
        {has(range?.expected) && report.model!.scenarioProbabilities && <p className="val-list-line">{m.expectedNote}</p>}
        <Model report={report} onCite={setOpen} />
        </div>
      </details></section>}
      <Scores report={report} onCite={setOpen} />
      <Report report={report} onCite={setOpen} />
      <Sources report={report} open={open} onOpen={setOpen} onClose={() => setOpen(null)} />
    </div>
  </section></FootnotesContext.Provider>;
}
