/** Model selects editorial templates; all styling and chart values remain system-owned. */
export type SecReaderVisual = {
  layout: "essay" | "spotlight" | "comparison" | "chart_focus";
  rationale: string;
  paragraphLabels?: string[];
  chart?: { metricKey: string; mark: "line" | "bar"; title: string; caption: string };
  noChartReason?: string;
};

export const SEC_READER_VISUAL_CATALOG = {
  essay: "连续叙事：适合解释复杂机制，正文后给出结论。",
  spotlight: "重点侧栏：正文与一句核心判断并列，适合投资含义或关键风险。",
  comparison: "双栏对照：2或4段按相邻两段配对，分别给paragraphLabels，适合支持/反证或两种业务机制。不得把无关段落凑成对照。",
  chart_focus: "图文分析：先提出问题和解释，再展示宽幅图表及局限，适合规模与跨期变化；必须提供chart。",
  rules: [
    "每节必须输出visual，先按业务问题选择layout并写rationale，不按章节序号轮换模板。适合时使用至少两种版式。",
    "每节审视availableCharts：有直接相关的可比数据时主动选择chart；否则填写具体noChartReason。不要无理由省略全部图表。",
    "chart只能引用availableCharts.metricKey，趋势用line、跨期规模比较用bar；title表达观察问题，caption解释图能说明什么及不能证明什么。禁止生成数据点或HTML/CSS。",
    "comparison的paragraphLabels与paragraphs一一对应；其他模板不需要。图表可搭配任何模板，每节最多一张，不重复展示同一指标。",
  ],
} as const;

/** Reader-facing research, separate from the analyst work papers. Optional on historical reports. */
export type SecReaderReport = {
  version: "sec-reader.v1";
  /** Diagnostic only; presentation repairs never replace substantive analysis. */
  presentationWarnings?: string[];
  changes: Array<{
    topic: string;
    kind: "new" | "changed" | "continuing" | "not_comparable";
    prior: string;
    current: string;
    implication: string;
    evidenceIds: string[];
    priorEvidenceIds: string[];
  }>;
  sections: Array<{
    id: string;
    title: string;
    role: "business" | "earnings_cash" | "valuation" | "bear_case" | "outlook";
    paragraphs: string[];
    takeaway: string;
    nodeIds: string[];
    evidenceIds: string[];
    chartMetricKey?: string;
    visual?: SecReaderVisual;
  }>;
  watch: Array<{ condition: string; deadline: string; consequence: string; evidenceIds: string[] }>;
  limitations: Array<{ issue: string; impact: string }>;
};

export type SecMarketSnapshot = {
  status: "available" | "unavailable";
  asOf: string;
  source: string;
  sourceUrl: string;
  currency?: string;
  price?: number;
  priceDate?: string;
  trailingPE?: number;
  trailingEPS?: number;
  earningsPeriodEnd?: string;
  reaction?: { from: string; to: string; sessions: number; changePercent: number };
  limitations: string[];
};

export type SecFinancialLens = {
  cashFlowItems?: Array<{
    metricKey: string; value: string; unit: string; periodEnd?: string; periodScope?: string; definition?: string;
    classification: "operating" | "investing" | "financing" | "non_cash" | "unknown";
    includedInOperatingCashFlow: "yes" | "no" | "unknown";
    obligation: string; sourceQuote?: string; evidenceIds: string[];
    evidenceStatus: "quoted" | "unverified";
  }>;
  missingMetrics: string[];
  limitations: string[];
  cashBridge?: {
    currency: string;
    period: string;
    operatingCashFlow: number;
    grossCapex: number;
    standardFCF: number;
    managementNetCapex?: number;
    adjustedFCF?: number;
    adjustment?: number;
    reconciliationStatus?: "unverified";
    evidenceIds: string[];
  };
  depreciation?: {
    currency: string;
    annualizedCapex: number;
    usefulLifeYears: number;
    annualExpenseIllustration: number;
    currentAnnualizedDepreciation?: number;
    currentAnnualizedOperatingIncome?: number;
    assumptions: string[];
    evidenceIds: string[];
  };
};

export const SEC_READER_SCHEMA = {
  visualCatalog: SEC_READER_VISUAL_CATALOG,
  changes: "[{topic,kind:new|changed|continuing|not_comparable,prior,current,implication,evidenceIds,priorEvidenceIds}]",
  sections: "[{title,role:business|earnings_cash|valuation|bear_case|outlook,paragraphs:[string],takeaway,nodeIds:[string],evidenceIds:[string],visual:{layout:essay|spotlight|comparison|chart_focus,rationale,paragraphLabels?:[string],chart?:{metricKey,mark:line|bar,title,caption},noChartReason?:string}}]",
  watch: "[{condition,deadline,consequence,evidenceIds}]",
  limitations: "[{issue,impact}]",
  rules: [
    "写一篇可独立阅读、逻辑递进的完整文章；3–8节，每节2–4段，标题围绕本公司真正的问题自拟。不是节点拼接或摘要。",
    "sections必须包含独立bear_case和valuation；其余章节按重要性选择。高重要性节点必须在相关章节被整合，低重要性节点留在核查材料。",
    "每节takeaway用一句普通人能读懂的话解释这意味着什么；术语首次出现时翻译，不以审阅流程或证据ID充当正文。",
    "changes挑选1–5个重要变化，明确以前、本期和判断变化。priorEvidenceIds只能使用给定的历史原始财务证据；无可比证据时填not_comparable，不把本次发现等同首次发生。",
    "watch给出1–4条可观察条件、检查时点和触发后需要推翻或修改的判断；数字阈值无来源时标为分析假设，不伪装成管理层指引。",
    "evidenceIds只能引用本期提供的证据；nodeIds只能引用已完成节点。chartMetricKey只能选availableCharts且必须直接服务于本节问题。",
    "财务数字从facts及financialLens取，行情和估值只能从marketSnapshot取；无数据时明确限制。保留币种、期间、口径及约数标记。",
  ],
} as const;
