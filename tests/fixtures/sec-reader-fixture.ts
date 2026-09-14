import type { SecFilingWithSummary, SecNodeResult } from "../../shared/analysis-contract/report.ts";
import type { SecReaderReport } from "../../shared/analysis-contract/sec-reader.ts";

/** Synthetic issuer; values test mechanisms, not any public company's results. */
export const readerNodes: SecNodeResult[] = [{ id: "demand", title: "需求与投入回报", status: "complete", findings: [],
  narrative: "需求增长需要用回款和投资回报验证。", evidenceIds: ["ev:demand"],
  evidence: [{ start: 10, end: 90, score: 80, reasons: [], excerpt: "Customer demand increased, while capacity investments preceded revenue recognition." }] }];

export function readerFixture(): SecReaderReport {
  return { version: "sec-reader.v1", changes: [{ topic: "增长开始需要更多资本", kind: "changed", prior: "上年同期资本开支为 8 亿美元。", current: "本期资本开支增加到 12 亿美元。", implication: "观察重点转向新增产能能否转成有利润的收入。", evidenceIds: ["ev:demand"], priorEvidenceIds: ["xbrl:prior"] }],
    sections: [
      { id: "sec-reader-1", title: "需求增长，现金回收还需等待", role: "earnings_cash", visual: { layout: "essay", rationale: "解释现金口径", noChartReason: "没有可比历史序列" }, paragraphs: ["本期需求增长与资本投入同时发生。客户承诺带来了未来交付机会，但资金投入先于收入确认，公司需要在扩张速度与流动性之间作出选择。", "经营现金流为 9 亿美元，总资本开支为 12 亿美元，两者之差为 −3 亿美元。管理层净资本开支口径下则为 +2 亿美元；差异来自调整项，不能将正值直接理解为融资压力已经消失。"], takeaway: "订单需要变成回款，增长才可能减轻资金压力。", nodeIds: ["demand"], evidenceIds: ["ev:demand"] },
      { id: "sec-reader-2", title: "这个价格，需要怎样的兑现", role: "valuation", visual: { layout: "spotlight", rationale: "突出估值边界", noChartReason: "缺少盈利序列" }, paragraphs: ["价格快照为示例收盘价 120 美元。仅凭业务增长，无法说明这一价格具有吸引力；还需要判断未来可持续盈利能覆盖怎样的估值。", "本报告缺少可比的四季每股收益和完整债务，因此不能补算 P/E 或企业价值。后续应观察回款改善能否持续，以及资本开支占收入的比重是否降低。"], takeaway: "价格判断仍然取决于盈利兑现和缺失数据的补齐。", nodeIds: ["demand"], evidenceIds: ["ev:demand"] },
      { id: "sec-reader-3", title: "最强的反面解释：需求没有变成回报", role: "bear_case", visual: { layout: "comparison", rationale: "并列两种风险机制", paragraphLabels: ["客户回款", "资产寿命"], noChartReason: "没有客户集中度或寿命序列" }, paragraphs: ["最值得警惕的情景是订单集中在少数客户，而客户付款能力不足。现有证据没有提供集中度和最低采购条款，不能把合同规模直接看成未来现金。", "投入还会通过折旧影响后续利润。如果设备在会计寿命结束前需要替换，现金回报和账面利润可能同时承压；资产范围与投用节奏未知，不能断言明年费用必然增加到某个数值。"], takeaway: "现金转化和资产实际寿命是这条增长逻辑的两项关键检验。", nodeIds: ["demand"], evidenceIds: ["ev:demand"] },
    ], watch: [{ condition: "如果收入继续增长，但经营现金流连续两季无法覆盖总资本开支（分析观察条件）", deadline: "未来两个季度", consequence: "则应撤回增长能够自行支持扩张的判断，重新评估融资依赖。", evidenceIds: ["ev:demand"] }],
    limitations: [{ issue: "客户集中度尚不可核验", impact: "无法评估单一客户对订单兑现和资金来源的影响。" }] };
}

export function readerFilingFixture(): SecFilingWithSummary {
  const reader = readerFixture();
  return { ticker: "DEMO", cik: "0000000001", cikNumber: 1, companyName: "示例公司 · 测试数据", form: "10-Q", filingDate: "2026-08-10", reportDate: "2026-06-30", accessionNumber: "demo-quarter", primaryDocument: "demo.htm", description: "合成测试报告", items: "", documentUrl: "https://example.com/filing", indexUrl: "https://example.com/filing",
    summary: { readerVersion: "sec-reader.v1", ticker: "DEMO", form: "10-Q", filingDate: "2026-08-10", accessionNumber: "demo-quarter", headline: "增长更快了，投资判断转向现金兑现", bullets: [{ label: "增长与现金", detail: "需求扩张需要先投入资本，两种现金流口径显示不同的资金压力。", importance: "high" }], analystView: "如果新增产能不能带来持续回款，增长本身还不足以支持更高估值。", report: "这是完整文章的导出文本。", nodes: readerNodes, source: "deepseek", generatedAt: "2026-08-14T12:00:00Z" },
    analysis: { ticker: "DEMO", periodId: "DEMO:2026-06-30:quarter", reportVersion: "sec-analysis.v3:demo", headline: "增长更快了，投资判断转向现金兑现", reader,
      keyMetrics: [{ metricKey: "revenue", currentValue: "2000000000", unit: "USD", currency: "USD", yoy: "+20.0%", status: "verified", evidenceIds: ["ev:demand"] }], changes: { qoq: [], yoy: [], guidance: [], risks: [] },
      dataQuality: { coverage: 0.6, verificationStatus: "partial", analysisStatus: "partial", warnings: ["内部诊断：xbrl:private-debug-id"], managerCoverageScore: 1 },
      financialLens: { missingMetrics: ["debt", "gross_margin"], limitations: ["缺少本期可核验的债务总额，杠杆全貌不可见。", "缺少可核验的公司整体毛利率，分部利润率不能替代。"], cashBridge: { currency: "USD", period: "2026-06-30 · 单季", operatingCashFlow: 9e8, grossCapex: 12e8, standardFCF: -3e8, managementNetCapex: 7e8, adjustedFCF: 2e8, adjustment: 5e8, evidenceIds: ["ev:demand"] }, depreciation: { currency: "USD", annualizedCapex: 48e8, usefulLifeYears: 5, annualExpenseIllustration: 9.6e8, currentAnnualizedDepreciation: 8e8, currentAnnualizedOperatingIncome: 16e8, assumptions: ["所有投入采用同一寿命与零残值，仅为量级测试。", "实际折旧从资产投用开始，不等于下一年新增费用。"], evidenceIds: ["ev:demand"] } },
      marketSnapshot: { status: "available", asOf: "2026-08-14T12:00:00Z", source: "合成行情，仅供测试", sourceUrl: "https://example.com/quote", currency: "USD", price: 120, priceDate: "2026-08-13", reaction: { from: "2026-08-07", to: "2026-08-13", sessions: 3, changePercent: -2.3 }, limitations: ["合成数据不代表实际股价。"] },
    } };
}
