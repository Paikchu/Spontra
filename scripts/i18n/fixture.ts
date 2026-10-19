/**
 * One synthetic company with every publication the business site reads, so the pages can be rendered without
 * the API. Figures are made up and only need to be internally consistent; names and generated text are English,
 * as the API delivers them.
 */
import type { BusinessFlowQuarter, FlowAmount, PublicBusinessFlow } from "../../shared/analysis-contract/business-flow.ts";
import type { BusinessExplainer } from "../../shared/analysis-contract/business-explainer.ts";
import type { BusinessTree } from "../../shared/analysis-contract/business-tree.ts";
import type { CapitalQuarter, PublicCapitalStructure } from "../../shared/analysis-contract/capital-structure.ts";
import type { CompleteFlowPublication } from "../../shared/analysis-contract/complete-business-flow.ts";
import type { CompanyEvent, EventsPublication } from "../../shared/analysis-contract/events.ts";
import type { PublicFilingDigest, PublicFilingDigestPage } from "../../shared/analysis-contract/filings.ts";
import type { AnalysisFinding, FindingsPublication } from "../../shared/analysis-contract/findings.ts";
import type { GuidanceItem, GuidancePublication } from "../../shared/analysis-contract/guidance.ts";
import type { RevenueHistory } from "../../shared/analysis-contract/revenue-history.ts";

export const TICKER = "ACME";
const ENDS = ["2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];
export const PERIOD = ENDS.at(-1)!;
const NEXT = "2026-09-30";
const SRC = "https://www.sec.gov/Archives/edgar/data/1/0001.htm";

const amount = (v: number, basis: FlowAmount["basis"] = "reported"): FlowAmount => ({ value: String(Math.round(v * 10) / 10), basis, definition: "", comparabilityKey: null, sourceIds: ["s1"] });

function quarter(end: string, i: number): BusinessFlowQuarter {
  const cloud = 4000 + i * 450, license = 2600 + i * 60, services = 900 - i * 10;
  const revenue = cloud + license + services;
  const cost = revenue * 0.34, gross = revenue - cost;
  const research = revenue * 0.17, sales = revenue * 0.2, admin = revenue * 0.06;
  const opex = research + sales + admin, operating = gross - opex;
  const other = -180 - i * 20, pretax = operating + other, tax = pretax * 0.17, net = pretax - tax;
  return {
    id: end, label: `Three months ended ${end}`, periodStart: null, periodEnd: end, periodType: "3M", currency: "USD", scale: 1e6,
    basisLabel: "As reported", reportedAt: new Date(Date.parse(end) + 40 * 86_400_000).toISOString().slice(0, 10),
    figures: {
      revenue: amount(revenue), cost: amount(cost), gross: amount(gross), research: amount(research), sales: amount(sales),
      administration: amount(admin), operatingExpenses: amount(opex), operating: amount(operating), other: amount(other),
      pretax: amount(pretax), tax: amount(tax), net: amount(net),
    },
    segments: [
      { id: "cloud", name: "Cloud Services", revenue: amount(cloud), description: "Infrastructure and platform services sold by subscription and usage.", products: ["Compute", "Storage", "Database Cloud"], customers: "Enterprises and public sector", monetization: "Subscription and consumption", disclosure: "Segment note", sourceIds: ["s1"],
        children: [{ id: "cloud-infra", name: "Infrastructure", revenue: amount(cloud * 0.6) }, { id: "cloud-apps", name: "Applications", revenue: amount(cloud * 0.4) }] },
      { id: "license", name: "License and Support", revenue: amount(license), description: "On-premise licenses and the support contracts attached to them.", products: ["Database", "Middleware"], customers: null, monetization: null, disclosure: "Segment note", sourceIds: ["s1"] },
      { id: "services", name: "Services", revenue: amount(services), description: "Consulting and education.", products: [], customers: null, monetization: null, disclosure: "Segment note", sourceIds: ["s1"] },
    ],
    segmentsComplete: true,
    expenseComponents: [
      { id: "rd", name: "Research and development", group: "research", amount: amount(research) },
      { id: "sm", name: "Sales and marketing", group: "sales", amount: amount(sales) },
      { id: "ga", name: "General and administrative", group: "administration", amount: amount(admin) },
    ],
    sources: [{ id: "s1", title: "10-Q", url: SRC, publishedAt: end }],
  };
}

const quarters = ENDS.map(quarter);
export const flow: PublicBusinessFlow = { schemaVersion: "business-flow.v1", ticker: TICKER, fetchedAt: "2026-08-10T00:00:00Z", quarters };

export const history: RevenueHistory = {
  schemaVersion: "revenue-history.v1", ticker: TICKER, updatedAt: "2026-08-10T00:00:00Z",
  quarters: quarters.map(q => ({
    periodStart: q.periodEnd, periodEnd: q.periodEnd, currency: "USD", scale: 1e6, revenue: q.figures.revenue!.value!, basis: "reported",
    segments: q.segments.map(s => ({ id: s.id, name: s.name, value: s.revenue!.value! })),
    source: { accession: "0001", url: SRC, filedAt: q.reportedAt!, form: "10-Q" },
  })),
};

const capSource = { accession: "0001", url: SRC, filedAt: "2026-07-30", form: "10-Q" };
function capitalQuarter(end: string, i: number): CapitalQuarter {
  const capex = (i === 7 ? 4.0e9 : 1.2e9 + i * 0.2e9);
  return {
    periodEnd: end,
    rpo: { asOf: end, currency: "USD", total: String(100e9 + i * 10e9), buckets: [{ start: null, months: 12, share: "0.4", amount: null }, { start: null, months: 24, share: "0.35", amount: null }], source: capSource },
    cashFlow: {
      periodStart: end, periodEnd: end, currency: "USD", basis: "reported",
      operating: { total: String(3.0e9 + i * 0.1e9), lines: [{ id: "ni", label: "Net income", concept: "x", group: "netIncome", value: "2000000000" }, { id: "nc", label: "Depreciation", concept: "x", group: "nonCash", value: "900000000" }] },
      investing: { total: String(-capex - 0.3e9), lines: [{ id: "capex", label: "Capital expenditures", concept: "x", group: "capex", value: String(-capex) }, { id: "acq", label: "Acquisitions", concept: "x", group: "acquisitions", value: "-300000000" }] },
      financing: { total: String(-1.1e9), lines: [{ id: "debt", label: "Proceeds from borrowings", concept: "x", group: "debtIssued", value: "2000000000" }, { id: "rep", label: "Repayments", concept: "x", group: "debtRepaid", value: "-1500000000" }, { id: "bb", label: "Repurchases", concept: "x", group: "buybacks", value: "-1000000000" }, { id: "div", label: "Dividends", concept: "x", group: "dividends", value: "-600000000" }] },
      fxEffect: "-20000000", netChange: "100000000", supplemental: [], sources: [capSource],
    },
    yearToDate: null,
    balanceSheet: {
      asOf: end, currency: "USD",
      assets: [
        { id: "cash", label: "Cash", concept: "x", group: "cash", value: "11000000000" }, { id: "ar", label: "Receivables", concept: "x", group: "receivables", value: "7000000000" },
        { id: "ppe", label: "Property", concept: "x", group: "productive", value: String(30e9 + i * 3e9) }, { id: "gw", label: "Goodwill", concept: "x", group: "intangibles", value: "60000000000" },
        { id: "oa", label: "Other", concept: "x", group: "other", value: "12000000000" },
      ],
      liabilities: [
        { id: "debt", label: "Notes", concept: "x", group: "debt", value: String(90e9 + i * 1e9) }, { id: "dr", label: "Deferred revenue", concept: "x", group: "customerAdvances", value: "9000000000" },
        { id: "ap", label: "Payables", concept: "x", group: "payables", value: "6000000000" },
      ],
      equity: [{ id: "pic", label: "Paid-in", concept: "x", group: "paidIn", value: "35000000000" }, { id: "re", label: "Retained", concept: "x", group: "retained", value: String(-20e9 + i * 1e9) }],
      totals: { assets: String(120e9 + i * 3e9), liabilities: String(105e9 + i * 1e9), equity: String(15e9 + i * 2e9), currentAssets: null, currentLiabilities: null },
      source: capSource,
    },
  };
}
export const capital: PublicCapitalStructure = { schemaVersion: "capital-structure.v1", ticker: TICKER, quarters: ENDS.map(capitalQuarter) };

const guide = (over: Partial<GuidanceItem> & Pick<GuidanceItem, "id" | "metric" | "measure">): GuidanceItem => ({
  segment: null, label: "Total revenue", basis: "gaap", horizon: "quarter", form: "range", fiscalYear: 2027, fiscalQuarter: 1, periodEnd: PERIOD,
  unit: "USD", low: null, high: null, direction: null, derived: null, actual: null, text: "Revenue is expected to grow 12% to 14%.", quote: "We expect revenue to grow 12% to 14%.",
  sourceIds: ["g1"], issuedAt: "2026-03-12", action: "raised", previous: { low: 7.0e9, high: 7.3e9, issuedAt: "2025-12-10" }, ...over,
});
export const guidance: GuidancePublication = {
  schemaVersion: "guidance.v1", ticker: TICKER, updatedAt: "2026-07-01T00:00:00Z",
  items: [
    guide({ id: "g-rev-q", metric: "revenue", measure: "amount", low: 7.6e9, high: 7.8e9 }),
    guide({ id: "g-rev-growth", metric: "revenue", measure: "growth", unit: "percent", low: 12, high: 14, derived: { low: 7.5e9, high: 7.7e9, basePeriodEnd: "2025-06-30", base: 6.7e9 }, previous: null, action: "reaffirmed" }),
    guide({ id: "g-gm", metric: "gross_margin", measure: "margin", unit: "percent", low: 65, high: 66, label: "Gross margin", action: "initiated", previous: null }),
    guide({ id: "g-next", metric: "revenue", measure: "amount", periodEnd: NEXT, fiscalQuarter: 2, low: 8.0e9, high: 8.3e9, issuedAt: "2026-07-30", action: "raised" }),
    guide({ id: "g-eps-next", metric: "eps", measure: "per_share", unit: "USD_per_share", periodEnd: NEXT, fiscalQuarter: 2, low: 1.42, high: 1.46, label: "Diluted EPS", basis: "non_gaap", issuedAt: "2026-07-30", action: "narrowed" }),
    guide({ id: "g-cloud-next", metric: "segment_revenue", measure: "growth", segment: "Cloud Services", unit: "percent", periodEnd: NEXT, fiscalQuarter: 2, low: 30, high: 34, label: "Cloud Services revenue", issuedAt: "2026-07-30", action: "updated" }),
    guide({ id: "g-capex-fy", metric: "capex", measure: "amount", horizon: "annual", periodEnd: "2027-05-31", fiscalQuarter: null, low: 15e9, high: 15e9, form: "point", label: "Capital expenditures", issuedAt: "2026-07-30", action: "raised" }),
    guide({ id: "g-op-qual", metric: "operating_margin", measure: "margin", unit: null, form: "qualitative", direction: "up", periodEnd: NEXT, fiscalQuarter: 2, label: "Operating margin", issuedAt: "2026-07-30", action: null, previous: null }),
  ],
  sources: [{ id: "g1", kind: "press_release", sourceKind: "sec", title: "Q4 FY2026 earnings release", url: SRC, publishedAt: "2026-07-30" }],
  coverage: [],
};

const finding = (f: Partial<AnalysisFinding> & Pick<AnalysisFinding, "id" | "kind" | "title" | "anchors" | "evidence" | "lens">): AnalysisFinding => ({
  severity: 3, judgment: { text: "Generated judgment that stays in English this phase.", sourceIds: ["s1"] }, ...f,
});
export const findings: FindingsPublication = {
  schemaVersion: "findings.v1", ticker: TICKER, periodEnd: PERIOD, generatedAt: "2026-08-01T00:00:00Z", model: "fixture",
  findings: [
    finding({ id: "capex", kind: "risk", title: "Capex outruns operating cash flow", judgment: { text: "Capex reached $4.0 billion in the quarter, above operating cash flow.", sourceIds: ["s1"] },
      evidence: [{ ref: { capital: "capex" }, periodEnd: PERIOD, span: "quarter", compare: "yoy" }, { ref: { capital: "operatingCashFlow" }, periodEnd: PERIOD, span: "quarter" }, { ref: { capital: "freeCashFlow" }, periodEnd: PERIOD, span: "quarter" }],
      anchors: { view: "cash", nodeIds: [], metrics: [], capital: ["capex"] },
      lens: { type: "compare_bars", refs: [{ capital: "operatingCashFlow" }, { capital: "capex" }, { capital: "freeCashFlow" }], span: "quarter" },
      watch: { ref: { capital: "capex" }, condition: "Capex below operating cash flow next quarter.", horizon: "next_quarter", compare: "yoy" } }),
    finding({ id: "cloud", kind: "strength", severity: 2, title: "Cloud carries growth",
      evidence: [{ ref: { nodeId: "cloud" }, periodEnd: PERIOD, span: "quarter", compare: "yoy" }, { ref: { metric: "revenue" }, periodEnd: PERIOD, span: "quarter", compare: { guidanceId: "g-rev-q" } }],
      anchors: { view: "profit", nodeIds: ["cloud"], metrics: ["revenue"] },
      lens: { type: "document", document: { rows: [
        { cells: [[{ kind: "chart", chart: { id: "c1", aspect: "wide", span: "quarter", periods: 8, series: [{ id: "cloud", ref: { nodeId: "cloud" } }, { id: "rate", ref: { nodeId: "cloud" }, transform: "yoy" }], marks: [{ type: "bar", series: ["cloud"] }, { type: "line", series: ["rate"], axis: "right" }], annotations: [{ series: "cloud", period: "latest", text: "{value}" }] } }], [{ kind: "judgment" }, { kind: "figures" }]] },
        { cells: [[{ kind: "chart", chart: { id: "c2", aspect: "wide", span: "fiscal_year", periods: 2, series: [{ id: "rev", ref: { metric: "revenue" } }, { id: "gm", ref: { ratio: { numerator: { metric: "gross" }, denominator: { metric: "revenue" } } } }], marks: [{ type: "bar", series: ["rev"] }, { type: "line", series: ["gm"], axis: "right" }] } }], [{ kind: "watch" }, { kind: "sources" }]] },
      ] } },
      watch: { ref: { nodeId: "cloud" }, condition: "Cloud growth above 25% next quarter.", horizon: "next_quarter", compare: "yoy" } }),
    finding({ id: "rpo", kind: "shift", severity: 2, title: "Backlog lengthens", pairWith: "capex",
      evidence: [{ ref: { capital: "rpo" }, periodEnd: PERIOD, span: "quarter", compare: "yoy" }, { ref: { rpoBucket: 0 }, periodEnd: PERIOD, span: "quarter" }],
      anchors: { view: "balance", nodeIds: [], metrics: [], capital: ["debt"] }, lens: { type: "ladder" } }),
    finding({ id: "margin", kind: "watch", severity: 1, title: "Gross margin dips",
      evidence: [{ ref: { ratio: { numerator: { metric: "gross" }, denominator: { metric: "revenue" } } }, periodEnd: PERIOD, span: "quarter", compare: "qoq" }],
      anchors: { view: "profit", nodeIds: [], metrics: ["gross"] },
      lens: { type: "trend", refs: [{ ratio: { numerator: { metric: "gross" }, denominator: { metric: "revenue" } } }], span: "quarter", rate: "qoq" } }),
  ],
  sources: [{ id: "s1", title: "10-Q", url: SRC, kind: "sec", publishedAt: null }],
  // A checkup note (docs/three-statement-analysis-design.md): generated text, with quotes from this and an earlier report.
  materials: [
    { id: "c:cash-conversion:m1", kind: "sec", title: `${TICKER} 10-Q ${PERIOD}`, url: SRC, publishedAt: "2026-08-05", passageId: "pfixturenote01", documentId: "d1", form: "10-Q", path: ["MD&A", "Cash flows"] },
    { id: "c:cash-conversion:m2", kind: "sec", title: `${TICKER} 10-K 2025-12-31`, url: SRC, publishedAt: "2026-02-20", passageId: "pfixturenote02", documentId: "d0", form: "10-K", path: ["MD&A", "Liquidity"] },
  ],
  checkup: { periodEnd: PERIOD, generatedAt: "2026-08-01T00:00:00Z", model: "fixture", notes: [{
    metricId: "cash-conversion", ruleIds: ["cash-above-profit"],
    paragraphs: [{ text: "Generated analysis that stays in English this phase: operating cash ran at 2.07x net income over the trailing four quarters, carried by non-cash charges that the earlier annual report already described as rising with the capacity build.", sourceIds: ["c:cash-conversion:m1", "c:cash-conversion:m2"] }],
    quotes: [
      { kind: "quote", materialId: "c:cash-conversion:m1", text: "Depreciation and amortization increased as new capacity was placed in service." },
      { kind: "quote", materialId: "c:cash-conversion:m2", text: "We expect depreciation to rise as we place additional capacity in service." },
    ],
  }] },
  highlights: [{ periodEnd: PERIOD,
    profit: [{ title: "Revenue", ref: { metric: "revenue" }, compare: "yoy" }, { title: "Operating margin", ref: { ratio: { numerator: { metric: "operating" }, denominator: { metric: "revenue" } } }, compare: "yoy", show: "change" }],
    cash: [{ title: "Free cash flow", ref: { capital: "freeCashFlow" }, compare: "yoy" }],
    balance: [{ title: "Debt", ref: { capital: "debt" }, compare: "qoq" }] }],
};

export const tree: BusinessTree = {
  schemaVersion: "business-tree.v1", ticker: TICKER, companyName: "Acme Corp", generatedAt: "2026-08-01T00:00:00Z", model: "fixture", fingerprint: "f", periodEnd: PERIOD,
  branches: [{ flowNodeId: "cloud", name: "Cloud Services", summary: { text: "Generated branch summary.", sourceIds: ["t1"] }, children: [
    { id: "infra", name: "Infrastructure", gloss: "Compute and storage", kind: "line", flowNodeId: "cloud-infra", summary: { text: "Generated line summary.", sourceIds: ["t1"] }, anchor: { text: "Quoted filing passage.", sourceIds: ["t1"] },
      revenue: [{ type: "consumption", label: "Pay per use", text: "Generated revenue text.", sourceIds: ["t1"] }, { type: "subscription", label: "Annual commit", text: "Generated.", sourceIds: ["t1"] }],
      children: [{ id: "compute", name: "Compute", gloss: null, kind: "product", flowNodeId: null, summary: null, anchor: null, revenue: [{ type: "consumption", label: "Hourly", text: "Generated.", sourceIds: ["t1"] }], children: [] }] },
  ] }],
  sources: [{ id: "t1", title: "10-K", url: SRC, kind: "sec", publishedAt: null }],
};

export const explainer: BusinessExplainer = {
  schemaVersion: "business-explainer.v1", ticker: TICKER, companyName: "Acme Corp", generatedAt: "2026-08-01T00:00:00Z", model: "fixture", fingerprint: "f",
  businesses: [{ nodeId: "cloud", name: "Cloud Services", summary: { text: "Generated summary of the business.", sourceIds: ["e1"] }, products: ["Compute"],
    offerings: [{ id: "o1", name: "Compute", line: "Infrastructure", description: { text: "Generated offering.", sourceIds: ["e1"] }, charging: { text: "Generated charging.", sourceIds: ["e1"] }, sourceIds: ["e1"] }],
    sections: [{ id: "x1", kind: "customers", title: "Who buys", layout: "list", items: [{ label: "Enterprises", claim: { text: "Generated.", sourceIds: ["e1"] } }] }] }],
  sources: [{ id: "e1", title: "10-K", url: SRC, kind: "sec", publishedAt: null }],
};

export const company: CompleteFlowPublication & { explainer: BusinessExplainer; guidance: GuidancePublication; tree: BusinessTree } = {
  schemaVersion: "complete-business-flow.v1", status: "ready", flow, reasons: [], outdated: false, lastAttemptAt: null, history, reports: null, explainer, guidance, tree,
};

const insider = (id: string, date: string, over: Partial<NonNullable<CompanyEvent["insider"]>>): CompanyEvent => ({
  id, ticker: TICKER, form: "4", filedAt: date, eventDate: date, items: [], class: "insider", description: "", edgarUrl: SRC, documentUrl: SRC, exhibits: [], summary: null,
  insider: { ownerCik: "9", ownerName: "Jane Q Officer", title: "Chief Financial Officer", isDirector: false, isOfficer: true, isTenPercentOwner: false, rule10b51: true, planAdoptedOn: "2025-11-02",
    securityTitle: "Common Stock", lines: [{ date, code: "S", acquiredDisposed: "D", shares: 120_000, price: 182.4, ownedAfter: 880_000, ownership: "D", derivative: false }],
    sold: { shares: 120_000, proceeds: 21_888_000, averagePrice: 182.4 }, bought: null, exercised: 0, heldAfter: 880_000, footnotes: ["Weighted average price."], ...over },
});
export const events: EventsPublication = {
  schemaVersion: "events.v1", ticker: TICKER, checkedAt: "2026-08-10T00:00:00Z", pendingInsider: 2,
  events: [
    insider("e-sale-1", "2026-08-05", {}),
    insider("e-sale-0", "2026-05-06", { lines: [{ date: "2026-05-06", code: "S", acquiredDisposed: "D", shares: 100_000, price: 160, ownedAfter: 1_000_000, ownership: "D", derivative: false }], sold: { shares: 100_000, proceeds: 16_000_000, averagePrice: 160 }, heldAfter: 1_000_000 }),
    insider("e-grant", "2026-07-15", { sold: null, lines: [{ date: "2026-07-15", code: "A", acquiredDisposed: "A", shares: 5000, price: 0, ownedAfter: 1_005_000, ownership: "D", derivative: false }] }),
    insider("e-buy", "2026-06-20", { ownerName: "John Director", isDirector: true, isOfficer: false, title: null, rule10b51: null, sold: null, bought: { shares: 10_000, cost: 1_650_000, averagePrice: 165 }, lines: [{ date: "2026-06-20", code: "P", acquiredDisposed: "A", shares: 10_000, price: 165, ownedAfter: 50_000, ownership: "D", derivative: false }], heldAfter: 50_000 }),
    { id: "e-8k", ticker: TICKER, form: "8-K", filedAt: "2026-07-30", eventDate: "2026-07-30", items: ["2.02", "9.01"], class: "earnings", description: "Results of Operations", edgarUrl: SRC, documentUrl: SRC,
      exhibits: [{ type: "EX-99.1", title: "Press release", url: SRC }],
      summary: { headline: "Generated event headline.", bullets: [{ label: "Revenue", detail: "Generated detail.", importance: "high" }], analystView: "Generated analyst view.", eventCategory: "earnings_update", generatedAt: "2026-07-30T00:00:00Z" }, insider: null },
    { id: "e-exec", ticker: TICKER, form: "8-K", filedAt: "2026-06-02", eventDate: "2026-06-01", items: ["5.02"], class: "executive", description: "8-K", edgarUrl: SRC, documentUrl: SRC, exhibits: [], summary: null, insider: null },
  ],
};

const digest = (over: Partial<PublicFilingDigest> & Pick<PublicFilingDigest, "accessionNumber" | "date">): PublicFilingDigest => ({
  form: "10-Q", filingDate: over.date, reportDate: PERIOD, periodEnd: PERIOD, periodLabel: "FY2026 Q4", sources: [], headline: "Generated report headline.",
  bullets: [{ label: "Cloud", detail: "Generated bullet.", importance: "high" }], analystView: "Generated analyst view.", report: "Generated report.", warnings: [], generatedAt: "2026-08-01T00:00:00Z",
  keyMetrics: [{ key: "revenue", label: "Revenue", value: "$7.7B", yoy: "+12.0%", qoq: "+3.1%", status: "verified" }, { key: "fcf", label: "Free cash flow", value: "−$0.9B", yoy: null, qoq: null, status: "derived" }],
  changes: [{ compare: "YoY", topic: "Capex", statement: "Generated change statement." }], risks: ["Generated risk."], guidance: ["Generated guidance line."],
  verification: "verified", analysisStatus: "complete", hasReport: true, snapshot: null, edgarUrl: SRC, documentUrl: SRC, ...over,
});
export const filings: PublicFilingDigestPage = {
  schemaVersion: "filing-digests.v1", ticker: TICKER, total: 2, checkedAt: "2026-08-10T00:00:00Z",
  filings: [
    digest({ accessionNumber: "0001-26-000002", date: "2026-07-30", sources: [{ form: "8-K", filingDate: "2026-07-30", accessionNumber: "e-8k", indexUrl: SRC }] }),
    digest({ accessionNumber: "0001-26-000001", date: "2026-04-30", periodEnd: "2026-03-31", reportDate: "2026-03-31", periodLabel: "FY2026 Q3", headline: "", analysisStatus: "processing", verification: null, hasReport: false, keyMetrics: [], changes: [], bullets: [] }),
  ],
};

/**
 * The Chinese the pipeline would serve for the fixture's generated prose, per resource, as the translator writes it:
 * figures in Chinese units, names kept. The page check renders the company with these applied.
 */
export const ZH_TABLES = {
  flow: {
    "Infrastructure and platform services sold by subscription and usage.": "按订阅和用量销售的基础设施与平台服务。",
    "Enterprises and public sector": "企业与公共部门", "Subscription and consumption": "订阅与按用量计费", "Segment note": "分部附注",
    "On-premise licenses and the support contracts attached to them.": "本地部署许可及配套支持合同。", "Consulting and education.": "咨询与培训。", "As reported": "按披露口径",
  },
  findings: {
    "Generated judgment that stays in English this phase.": "生成的判断。",
    "Generated analysis that stays in English this phase: operating cash ran at 2.07x net income over the trailing four quarters, carried by non-cash charges that the earlier annual report already described as rising with the capacity build.": "生成的分析：近 4 个季度经营现金流为净利润的 2.07 倍，主要来自非现金费用；上一份年报已说明这类费用会随产能扩建而上升。",
    "Capex reached $4.0 billion in the quarter, above operating cash flow.": "本季度资本开支达到 40亿美元，高于经营现金流。",
    "Capex outruns operating cash flow": "资本开支超过经营现金流", "Capex below operating cash flow next quarter.": "下季度资本开支低于经营现金流。",
    "Cloud carries growth": "云业务撑起增长", "Cloud growth above 25% next quarter.": "下季度云业务增速高于 25%。",
    "Backlog lengthens": "订单储备拉长", "Gross margin dips": "毛利率小幅下滑", "Revenue": "营收", "Operating margin": "营业利润率", "Free cash flow": "自由现金流", "Debt": "债务",
  },
  explainer: { "Generated summary of the business.": "生成的业务概述。", "Generated offering.": "生成的产品说明。", "Generated charging.": "生成的收费说明。", "Who buys": "客户是谁", "Enterprises": "企业", "Generated.": "生成内容。" },
  tree: { "Generated branch summary.": "生成的分支概述。", "Compute and storage": "计算与存储", "Generated line summary.": "生成的产品线概述。", "Pay per use": "按用量付费", "Generated revenue text.": "生成的收入说明。", "Annual commit": "年度承诺", "Generated.": "生成内容。", "Hourly": "按小时" },
  guidance: { "Total revenue": "总营收", "Revenue is expected to grow 12% to 14%.": "营收预计增长 12% 至 14%。", "Gross margin": "毛利率", "Diluted EPS": "稀释每股收益", "Cloud Services revenue": "Cloud Services 营收", "Capital expenditures": "资本开支", "Operating margin": "营业利润率" },
  events: { "Generated event headline.": "生成的事件标题。", "Revenue": "营收", "Generated detail.": "生成的细节。", "Generated analyst view.": "生成的分析观点。" },
} satisfies Record<string, Record<string, string>>;

/** The filing list as the site worker builds it from translated filings: the digests' generated fields in Chinese. */
export const filingsZh: PublicFilingDigestPage = { ...filings, filings: filings.filings.map(f => ({ ...f,
  headline: f.headline ? "生成的财报标题。" : "", analystView: "生成的分析观点。",
  bullets: f.bullets.map(b => ({ ...b, label: "云业务", detail: "生成的要点。" })),
  changes: f.changes.map(c => ({ ...c, topic: "资本开支", statement: "生成的变化说明。" })), risks: f.risks.map(() => "生成的风险。"), guidance: f.guidance.map(() => "生成的指引。"),
  keyMetrics: f.keyMetrics.map(k => ({ ...k, label: k.key === "revenue" ? "营收" : "自由现金流", value: k.key === "revenue" ? "77亿美元" : "−9亿美元" })) })) };

/** Every string the fixture carries: data the page may show as it is, so it never counts as untranslated text. */
export function fixtureStrings(): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") { out.add(v); for (const w of v.split(/[\s,.;:()]+/)) if (w) out.add(w); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk([company, capital, findings, events, filings]);
  return out;
}
