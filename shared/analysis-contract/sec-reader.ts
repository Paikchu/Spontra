export type { SecReaderReport, SecReaderVisual } from "../analysis-runtime/sec-reader-schema.ts";

export const SEC_READER_VISUAL_CATALOG = {
  essay: "Continuous narrative: suits explaining a complex mechanism; the conclusion follows the prose.",
  spotlight: "Highlight sidebar: prose set beside one core judgment; suits an investment implication or a key risk.",
  comparison: "Two-column contrast: 2 or 4 blocks paired as adjacent couples, each with a paragraphLabels entry; suits supporting vs. contrary evidence or two business mechanisms. Never pair unrelated paragraphs to fake a contrast.",
  chart_focus: "Chart-led analysis: state the question and the explanation first, then place the chart and its limits in content; use a compact side chart for a two-period comparison and a wide chart for a multi-period trend.",
  rules: [
    "Every section must output visual: choose the layout for the business question and write a rationale; do not rotate templates by section number. Use at least two layouts across the report when they fit.",
    "In every section review availableCharts and availableFigures: when directly relevant comparable data exists, choose a chart or figure; otherwise write a specific noChartReason. Do not drop every chart without a reason.",
    "A chart may only reference availableCharts.metricKey; use line for trends and bar for cross-period size comparisons. The title states the question being observed; the caption explains what the chart shows and what it cannot prove. Never generate data points, HTML or CSS.",
    "comparison paragraphLabels map one-to-one to the markdown prose blocks; other layouts do not need them. Charts may go with any layout: at most one chart per section and at most two charts and figures combined, never showing the same metric twice. In v2, place charts in content right after the discussion they support; do not configure the chart again in visual.",
    "availableFigures are graphic components the system precomputed from verified XBRL (Key figures, Revenue and YoY growth, Margin ladder, Revenue to net income, Where each $100 of revenue goes, Net income to free cash flow, Cash and long-term debt, Share count). Judge from each item's answers whether it directly answers the section's question; if it does, place the figure after the discussion that explains it. A figure and a chart must not express the same metric. Each figureKey may be used at most once in the report; skip it when it does not fit.",
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
export const SEC_REPORT_STYLE_RULES = `Write in plain, objective, concise equity-research English that a general investor can follow. All reader-facing text is English; keep company, product and segment names and verbatim source quotations exactly as the filing writes them. Section titles name the subject of the analysis or an evidence-backed conclusion, specific to the business or financial question; do not force them into generic column names.
Titles avoid rhetorical questions, conversational hooks, suspense and slogans: never write titles like "What changed this quarter", "Where did the money go" or "What to watch next". "Operating cash flow versus earnings" is acceptable; write a conclusion-style title such as "Receivables growth slows cash collection" only when the evidence is sufficient.
Prose states facts, explains mechanisms and gives judgments directly. Remove repetitive narrator-style transitions and empty evaluation; do not mechanically add "this means" or "it is worth noting", and do not add first person, emotion or digressions to sound natural. Keep the causal links, contrasts and term definitions the argument needs.
Style edits must never change facts, numbers, fiscal periods, units, accounting basis, citations, or the direction or strength of a judgment. Keep qualifiers such as "may", "management expects" and "cannot yet be confirmed", and do not add causal claims the evidence does not support. Quotations from source documents stay verbatim.`;

export const SEC_READER_SCHEMA = {
  version: "sec-reader.v2",
  contentBlocks: {
    common: "{blockId:stable English identifier unique across the report,type,evidenceIds:[current-period evidence IDs],groupId?:ID of a related text-and-media group,layout?:inline|aside|wrap|wide}",
    markdown: "{...common,type:markdown,markdown:one complete prose paragraph, at most 4000 characters}",
    chart: "{...common,type:chart,metricKey:a metric from availableCharts,mark:line|bar,title,caption}",
    figure: "{...common,type:figure,figureKey:a figureKey from availableFigures,title,caption}: the system draws the graphic and its values; only choose the component and write its title and caption.",
    image: "{...common,type:image,assetId:an ID from availableAssets,alt,caption}",
    math: "{...common,type:math,latex,displayMode:true|false,explanation,assumption?:analytical assumption}",
    table: "{...common,type:table,headers:[string],rows:[[string]],caption,density?:compact|comfortable,columnKinds?:[label|number|text]}: column kinds follow the order of headers; label is the row name, number is a short comparable value, text is a wrapping explanation.",
    callout: "{...common,type:callout,tone:neutral|positive|negative|caution,title?:string,text}",
    evidence: "{...common,type:evidence,title?:string}",
  },
  contentExample: [
    { blockId: "cash-definition", type: "markdown", markdown: "Write the complete paragraph here", evidenceIds: ["replace with a real ID from allowedEvidenceIds"], groupId: "cash-discussion" },
    { blockId: "cash-explanation", type: "markdown", markdown: "Write the next explanatory paragraph here", evidenceIds: ["replace with a real ID from allowedEvidenceIds"], groupId: "cash-discussion" },
  ],
  visualCatalog: SEC_READER_VISUAL_CATALOG,
  changes: "[{topic,kind:new|changed|continuing|not_comparable,prior,current,implication,evidenceIds,priorEvidenceIds}]",
  sections: "[{id:stable English topic ID,title,role:business|earnings_cash|valuation|bear_case|outlook,content:[ordered blocks defined in contentBlocks],takeaway,nodeIds:[string],evidenceIds:[string],visual:{layout:essay|spotlight|comparison|chart_focus,rationale,paragraphLabels?:[string],noChartReason?:string}}]",
  watch: "[{condition,deadline,consequence,evidenceIds}]",
  limitations: "[{issue,impact}]",
  rules: [
    SEC_REPORT_STYLE_RULES,
    "Output version=sec-reader.v2 and write one complete article that reads on its own and builds its argument step by step: usually 3–8 sections, at most 16, each with 2–4 markdown prose blocks (at most 8). Titles are written for this company's real questions. It is not a concatenation of analysis nodes and not a summary.",
    "Every content element must be a JSON object, never a string or stringified JSON; prose goes in the object's markdown field and must come with blockId/type/evidenceIds. contentExample only shows the object shape: never copy its text or placeholder citations. content is the only body text, ordered as the reader reads it, interleaving prose and media. paragraphs is projected by the system; do not write a second copy of the prose. Related text and media share one groupId and sit next to each other, e.g. opening markdown → chart(layout=wrap) → explanatory markdown, all three with the same groupId. Small comparison charts may use wrap and complex charts wide; layout never changes content order.",
    "Every block needs a stable blockId unique across the report, e.g. cash-definition or capex-comparison; keep the original blockId when revising text or moving a block. Never derive IDs from a hash of the paragraph content. Charts may only reference availableCharts and figures only availableFigures; never invent points or data. Images may only reference availableAssets (no image blocks when it is empty); never output URLs, base64, HTML or inline SVG.",
    "A figure title names what is observed or an evidence-backed conclusion; its caption says what the figure shows and what it cannot prove (see limits). Numbers in a caption must match availableFigures.data.",
    "Every fact and number in captions, formulas, tables and callouts must be supported by evidenceIds just like the prose. A formula comes with an explanation and lists its assumption separately. Tables keep a consistent column count and must not contain speculative financial values. Do not wrap dollar amounts in single-dollar math markup.",
    "When there are many comparable values on the same basis across periods, businesses or scenarios, prefer a standalone table block next to the related discussion; a few key numbers and the causal explanation stay in prose. You decide rows, columns, titles, column kinds and compact/comfortable density for the analytical question; never output HTML/CSS. Usually keep 2–6 columns; split a wide table into several meaningful small tables on a shared basis instead of forcing subscription KPIs, long explanations and financial figures into one table. The caption states unit, period, basis and any material source differences; write \"not disclosed\" for a missing value, never zero. number columns hold only short values; long explanations go in text columns and stay readable. Every cell and every cross-period comparison needs evidence; if it cannot be verified, do not build the table.",
    "sections must include a standalone bear_case and a standalone valuation section; choose the rest by importance. High-materiality nodes must be integrated into the relevant sections; low-materiality nodes stay in the supporting material.",
    "Each section's takeaway is one concise, objective sentence stating the section's analytical conclusion and its investment implication. Define jargon at first use; never use the review process or evidence IDs as body text.",
    "changes picks 1–5 important changes and states the prior position, the current position and how the judgment changed. priorEvidenceIds may only use the historical source financial evidence provided, or ev: passages of this filing that state the prior-period position (e.g. 'as of December 31, 2024 …'); without comparable evidence use not_comparable, and do not equate a finding in this filing with a first occurrence.",
    "watch gives 1–4 observable conditions, the time to check each, and the judgment that must be overturned or revised if it triggers. A numeric threshold without a source is labeled an analytical assumption, never presented as management guidance.",
    "evidenceIds may only cite allowedEvidenceIds. Market blocks use marketSnapshot.evidenceId (when present); that ID supports only the price, date, valuation fields and market reaction of the same frozen snapshot. It is not an SEC source and cannot support operating or financial facts. Without a valid market ID, do not invent a current share price or valuation. nodeIds may only cite completed nodes. chartMetricKey may only use availableCharts and must directly serve the section's question.",
    "Take financial numbers from facts and financialLens, and market and valuation data only from marketSnapshot; state the limitation when data is missing. Preserve currency, period, basis and approximation markers.",
  ],
} as const;
