export type { SecReaderReport, SecReaderVisual, SecReaderContentBlock, SecReaderAsset } from "../analysis-runtime/sec-reader-schema.ts";

export const SEC_READER_VISUAL_CATALOG = {
  essay: "连续叙事：适合解释复杂机制，正文后给出结论。",
  spotlight: "重点侧栏：正文与一句核心判断并列，适合投资含义或关键风险。",
  comparison: "双栏对照：2或4段按相邻两段配对，分别给paragraphLabels，适合支持/反证或两种业务机制。不得把无关段落凑成对照。",
  chart_focus: "图文分析：先提出问题和解释，再在content中展示chart及局限；两期比较用紧凑侧图，多期趋势可用宽图。",
  rules: [
    "每节必须输出visual，先按业务问题选择layout并写rationale，不按章节序号轮换模板。适合时使用至少两种版式。",
    "每节审视availableCharts：有直接相关的可比数据时主动选择chart；否则填写具体noChartReason。不要无理由省略全部图表。",
    "chart只能引用availableCharts.metricKey，趋势用line、跨期规模比较用bar；title表达观察问题，caption解释图能说明什么及不能证明什么。禁止生成数据点或HTML/CSS。",
    "comparison的paragraphLabels与markdown正文块一一对应；其他模板不需要。图表可搭配任何模板，每节最多一张，不重复展示同一指标；v2将图表放在content的相关论述之后，不再在visual重复配置chart。",
  ],
} as const;

export type SecMarketSnapshot = {
  /** System-derived identity of this frozen market snapshot, never an SEC evidence ID. */
  evidenceId?: string;
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
    adjustments?: Array<{ label: string; value: number }>;
    arithmeticVerified?: boolean;
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

/** Shared editorial style for report synthesis, review and revision. */
export const SEC_REPORT_STYLE_RULES = `使用简洁、客观、易懂的中文研究报告语言。标题直接说明分析对象或有证据支持的结论，具体到业务与财务问题，不强制统一成空泛栏目名。
标题避免设问、对话式引导、悬念和口号，不写「这一季，判断变在哪里」「钱去了哪里」「接下来要盯什么」。可用「经营现金流与利润差异」；只有证据充分时才写「应收账款增长拖累现金回收」等结论式标题。
正文直接陈述事实、解释机制和说明判断，删除重复的旁白式过渡与空泛评价；不机械添加「这意味着」「值得注意的是」，不为自然感加入第一人称、情绪或题外话。保留必要的因果、转折和术语解释。
文风调整不得改变事实、数字、财季、单位、会计口径、引用和判断的方向或强度；保留「可能」「管理层预计」「尚不能确认」等限定，不增加未经证据支持的因果。原文引文保持逐字一致。`;

export const SEC_READER_SCHEMA = {
  version: "sec-reader.v2",
  contentBlocks: {
    common: "{blockId:稳定且全篇唯一的英文标识,type,evidenceIds:[本期证据ID],groupId?:相关图文分组ID,layout?:inline|aside|wrap|wide}",
    markdown: "{...common,type:markdown,markdown:一段完整正文}",
    chart: "{...common,type:chart,metricKey:availableCharts中的指标,mark:line|bar,title,caption}",
    image: "{...common,type:image,assetId:availableAssets中的ID,alt,caption}",
    math: "{...common,type:math,latex,displayMode:true|false,explanation,assumption?:分析假设}",
    table: "{...common,type:table,headers:[string],rows:[[string]],caption,density?:compact|comfortable,columnKinds?:[label|number|text]}：列类型顺序与headers一致；label为行名，number为可比较的短数值，text为可换行的说明。",
    callout: "{...common,type:callout,tone:neutral|positive|negative|caution,title?:string,text}",
    evidence: "{...common,type:evidence,title?:string}",
  },
  contentExample: [
    { blockId: "cash-definition", type: "markdown", markdown: "此处填写完整正文", evidenceIds: ["替换为allowedEvidenceIds中的真实ID"], groupId: "cash-discussion" },
    { blockId: "cash-explanation", type: "markdown", markdown: "此处填写下一段解释", evidenceIds: ["替换为allowedEvidenceIds中的真实ID"], groupId: "cash-discussion" },
  ],
  visualCatalog: SEC_READER_VISUAL_CATALOG,
  changes: "[{topic,kind:new|changed|continuing|not_comparable,prior,current,implication,evidenceIds,priorEvidenceIds}]",
  sections: "[{id:稳定英文主题ID,title,role:business|earnings_cash|valuation|bear_case|outlook,content:[contentBlocks中定义的有序块],takeaway,nodeIds:[string],evidenceIds:[string],visual:{layout:essay|spotlight|comparison|chart_focus,rationale,paragraphLabels?:[string],noChartReason?:string}}]",
  watch: "[{condition,deadline,consequence,evidenceIds}]",
  limitations: "[{issue,impact}]",
  rules: [
    SEC_REPORT_STYLE_RULES,
    "输出version=sec-reader.v2，写一篇可独立阅读、逻辑递进的完整文章；通常3–8节、最多16节，每节2–4个markdown正文块（最多8个），标题围绕本公司真正的问题自拟。不是节点拼接或摘要。",
    "content每个元素必须是JSON对象，不能是字符串或字符串化JSON；markdown正文写在对象的markdown字段，必须同时提供blockId/type/evidenceIds。contentExample只是对象结构示例，不能复制示例文字或占位引用。content为唯一正文，按读者阅读顺序穿插正文与媒体。paragraphs由系统投影，不要再写第二份正文。相关图文用相同groupId且连续排列，例如首段markdown→chart(layout=wrap)→解释markdown，三块共用groupId。小型比较图可选wrap，复杂图选wide；布局不改变内容顺序。",
    "每块必须有稳定且全篇唯一的blockId，例如cash-definition或capex-comparison；修订文字、移动块时保持原blockId。禁止按段落内容hash生成ID。图表只能引用availableCharts，不得自造points；图片只能引用availableAssets（为空时禁止image），不得输出URL、base64、HTML或内联SVG。",
    "图注、公式、表格、提示中的所有事实和数字同正文一样必须由evidenceIds支持；公式给出解释，假设单列assumption；表格列数一致，不能填入推测财务数值。美元金额不写单美元数学标记。",
    "当同口径的多个期间、业务或情景有较多可比较数值时，优先在相关论述旁使用独立table块；少量关键数字和因果解释仍写正文。由你按分析问题决定行列、标题、列类型及compact/comfortable密度，不输出HTML/CSS。通常控制在2–6列；宽表应按共同口径拆成多个有意义的小表，不把订阅KPI、长篇解释和财务数字硬塞进同一张表。caption写明单位、期间、口径和必要的来源差异；缺值写明未披露，不填零。number列只放短数值，长说明放text列并保持可读；每个单元格及跨期可比性均须有证据，无法核实则不要制表。",
    "sections必须包含独立bear_case和valuation；其余章节按重要性选择。高重要性节点必须在相关章节被整合，低重要性节点留在核查材料。",
    "每节takeaway用一句简洁、客观的话说明该节的分析结论及投资含义；术语首次出现时翻译，不以审阅流程或证据ID充当正文。",
    "changes挑选1–5个重要变化，明确前期、本期和判断变化。priorEvidenceIds只能使用给定的历史原始财务证据；无可比证据时填not_comparable，不把本次发现等同首次发生。",
    "watch给出1–4条可观察条件、检查时点和触发后需要推翻或修改的判断；数字阈值无来源时标为分析假设，不伪装成管理层指引。",
    "evidenceIds只能引用allowedEvidenceIds。行情块用marketSnapshot.evidenceId（如存在），该ID仅支持同一冻结快照中的价格、日期、估值字段和市场反应；它不是SEC原文，不能支持经营财务事实。缺少合法行情ID时不虚构当前股价或估值；nodeIds只能引用已完成节点。chartMetricKey只能选availableCharts且必须直接服务于本节问题。",
    "财务数字从facts及financialLens取，行情和估值只能从marketSnapshot取；无数据时明确限制。保留币种、期间、口径及约数标记。",
  ],
} as const;
