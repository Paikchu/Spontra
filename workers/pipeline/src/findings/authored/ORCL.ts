import type { FindingsPublication } from "../../../../../shared/analysis-contract/findings.ts";

/**
 * Findings written by hand from Oracle's FY2026 10-K and earnings releases, standing in until the
 * findings workflow writes them. Every number in the text is one the page re-derives from the
 * published statements; the reader withholds any finding whose numbers the data no longer support.
 */
const FY26 = "2026-05-31";
const amount = (ref: Parameters<typeof ev>[0], compare?: "yoy" | "qoq") => ev(ref, FY26, "fiscal_year", compare);
function ev(ref: FindingsPublication["findings"][number]["evidence"][number]["ref"], periodEnd: string, span: "quarter" | "fiscal_year", compare?: "yoy" | "qoq" | { guidanceId: string }, label?: string) {
  return { ref, periodEnd, span, ...(compare ? { compare } : {}), ...(label ? { label } : {}) };
}

export const ORCL_FINDINGS: FindingsPublication = {
  schemaVersion: "findings.v1",
  ticker: "ORCL",
  periodEnd: FY26,
  generatedAt: "2026-10-08T00:00:00.000Z",
  model: "authored",
  sources: [
    { id: "10k-fy26", title: "Oracle 10-K FY2026", url: "https://www.sec.gov/Archives/edgar/data/1341439/000119312526277521/orcl-20260531.htm", kind: "sec", publishedAt: "2026-06-22" },
    { id: "10k-fy25", title: "Oracle 10-K FY2025", url: "https://www.sec.gov/Archives/edgar/data/1341439/000095017025087926/orcl-20250531.htm", kind: "sec", publishedAt: "2025-06-18" },
    { id: "8k-q4-fy26", title: "Oracle Q4 FY2026 earnings release", url: "https://www.sec.gov/Archives/edgar/data/1341439/000119312526265848/orcl-ex99_1.htm", kind: "sec", publishedAt: "2026-06-10" },
    { id: "8k-q3-fy26", title: "Oracle Q3 FY2026 earnings release", url: "https://www.sec.gov/Archives/edgar/data/1341439/000119312526100148/orcl-ex99_1.htm", kind: "sec", publishedAt: "2026-03-10" },
    { id: "8k-q1-fy26", title: "Oracle Q1 FY2026 earnings release", url: "https://www.sec.gov/Archives/edgar/data/1341439/000119312525199175/orcl-ex99_1.htm", kind: "sec", publishedAt: "2025-09-09" },
  ],
  findings: [
    {
      id: "capex-fcf",
      kind: "risk",
      severity: 3,
      title: "Capex reaches $55.7 billion and free cash flow turns negative",
      judgment: {
        text: "FY2026 capex was $55.7 billion, above management's earlier guidance of $50 billion and 2.6x the FY2025 level. Operating cash flow reached a record $32.0 billion, up 54% year over year, yet free cash flow was still -$23.7 billion. Outside funding filled the gap: the company raised $46.1 billion in new debt over the year, and total assets grew 55% in one year, from $168.4 billion to $261.8 billion, mostly data center assets and leases. Cloud revenue per dollar of capex fell from $1.16 the year before to $0.61. Oracle is trading balance-sheet capacity for cloud revenue growth: if the pace at which AI cloud demand converts to revenue, or the financing environment, changes, the heavy capex becomes a financial burden.",
        sourceIds: ["10k-fy26", "8k-q3-fy26"],
      },
      evidence: [
        ev({ capital: "capex" }, FY26, "fiscal_year", { guidanceId: "capex|amount||annual|2026|||gaap|0001193125-26-100148" }, "FY2026 capex"),
        amount({ capital: "capex" }, "yoy"),
        amount({ capital: "operatingCashFlow" }, "yoy"),
        amount({ capital: "freeCashFlow" }),
        amount({ capital: "debtIssued" }),
        ev({ capital: "totalAssets" }, FY26, "quarter", "yoy", "Total assets"),
        ev({ ratio: { numerator: { nodeId: "cloud" }, denominator: { capital: "capex" } } }, FY26, "fiscal_year", "yoy", "Cloud revenue per dollar of capex"),
      ],
      anchors: { view: "cash", nodeIds: [], metrics: [], capital: ["capex", "operatingCashFlow", "freeCashFlow", "debtIssued"] },
      lens: { type: "compare_bars", refs: [{ capital: "operatingCashFlow" }, { capital: "capex" }, { capital: "freeCashFlow" }], span: "fiscal_year" },
      pairWith: "cloud-engine",
      watch: { ref: { ratio: { numerator: { nodeId: "cloud" }, denominator: { capital: "capex" } } }, condition: "Whether cloud revenue per dollar of capex stops falling in FY2027, and whether the roughly $40 billion of debt and equity financing management plans proceeds on schedule", horizon: "fiscal_year", compare: "yoy" },
    },
    {
      id: "cloud-engine",
      kind: "strength",
      severity: 3,
      title: "Cloud becomes the core engine",
      judgment: {
        text: "FY2026 cloud services revenue was $34.0 billion, up 39% year over year and now about half of total revenue; software revenue over the same period was $24.5 billion, down 1%. The business model is shifting from license sales to cloud subscriptions and consumption. Management had guided FY2026 OCI revenue to $18 billion, growth of 77%. Cloud infrastructure is now the only growth story, and its growth is accelerating quarter by quarter rather than slowing.",
        sourceIds: ["10k-fy26", "8k-q1-fy26"],
      },
      evidence: [
        amount({ nodeId: "cloud" }, "yoy"),
        amount({ nodeId: "software" }, "yoy"),
        ev({ nodeId: "CloudInfrastructure" }, FY26, "quarter", undefined, "Q4 FY2026 cloud infrastructure"),
        ev({ guidanceId: "segment_revenue|amount|oracle-cloud-infrastructure|annual|2026|||unspecified|0001193125-25-199175" }, FY26, "fiscal_year"),
        ev({ guidanceId: "segment_revenue|growth|oracle-cloud-infrastructure|annual|2026|||unspecified|0001193125-25-199175" }, FY26, "fiscal_year"),
      ],
      anchors: { view: "profit", nodeIds: ["cloud", "CloudInfrastructure", "CloudApplications"], metrics: [] },
      lens: { type: "share_area", nodeIds: ["cloud", "software", "HardwareRevenues", "SalesRevenueServicesNet"] },
      pairWith: "capex-fcf",
      watch: { ref: { nodeId: "cloud" }, condition: "Whether year-over-year cloud revenue growth keeps accelerating and lands within management's Q1 FY2027 guidance of 58% to 64% growth in total cloud revenue", horizon: "next_quarter", compare: { guidanceId: "segment_revenue|growth|total-cloud-revenue|quarter|2027|1||gaap|0001193125-26-265848" } },
    },
    {
      id: "rpo-backlog",
      kind: "shift",
      severity: 2,
      title: "RPO reaches $638 billion, giving strong long-range visibility",
      judgment: {
        text: "Remaining performance obligations grew from $137.8 billion a year earlier to $638 billion, up 363% year over year, driven mainly by multi-year contracts with large AI customers. About 12% is expected to be recognized as revenue in the next 12 months; the rest converts gradually after that. Long-range revenue visibility is very strong, but it depends heavily on a few large customers: if their demand timing shifts, the quality of the RPO will be tested.",
        sourceIds: ["10k-fy26"],
      },
      evidence: [
        ev({ capital: "rpo" }, FY26, "quarter", "yoy"),
        ev({ capital: "rpoNext12MonthsShare" }, FY26, "quarter"),
      ],
      anchors: { view: "profit", nodeIds: [], metrics: ["revenue"], capital: ["rpo"] },
      lens: { type: "ladder" },
      watch: { ref: { capital: "rpo" }, condition: "Whether RPO keeps growing and whether the share recognized within 12 months rises", horizon: "next_quarter", compare: "qoq" },
    },
    {
      id: "growth-acceleration",
      kind: "strength",
      severity: 2,
      title: "Revenue growth doubles and operating leverage kicks in",
      judgment: {
        text: "FY2026 total revenue was $67.4 billion, up 17% year over year from $57.4 billion in the prior fiscal year. Revenue in the fourth quarter alone was a record $19.2 billion, up 21% year over year. Net income for the year was $17.1 billion, and fourth-quarter net income was $4.3 billion, up 26% year over year. Revenue growth has risen from single digits to 17%, and profit is growing faster than revenue: operating leverage is kicking in.",
        sourceIds: ["10k-fy26", "10k-fy25"],
      },
      evidence: [
        amount({ metric: "revenue" }, "yoy"),
        ev({ metric: "revenue" }, "2025-05-31", "fiscal_year", undefined, "FY2025 total revenue"),
        ev({ metric: "revenue" }, FY26, "quarter", "yoy", "Q4 FY2026 revenue"),
        amount({ metric: "net" }),
        ev({ metric: "net" }, FY26, "quarter", "yoy", "Q4 FY2026 net income"),
      ],
      anchors: { view: "profit", nodeIds: [], metrics: ["revenue", "operating", "net"] },
      lens: { type: "trend", refs: [{ metric: "revenue" }, { metric: "net" }], span: "quarter", rate: "yoy" },
    },
    {
      id: "legacy-shrink",
      kind: "shift",
      severity: 1,
      title: "Legacy businesses shrink structurally",
      judgment: {
        text: "FY2026 software revenue was $24.5 billion, down 1% year over year. Hardware revenue was $3.1 billion, up 5%, but at that scale it is no longer a strategic focus; services revenue was $5.7 billion, up 10%, and plays a supporting role. The shrinkage of the legacy businesses is structural, not cyclical. Attention belongs on cloud growth, the pace of capacity delivery, and cloud unit economics.",
        sourceIds: ["10k-fy26"],
      },
      evidence: [
        amount({ nodeId: "software" }, "yoy"),
        amount({ nodeId: "HardwareRevenues" }, "yoy"),
        amount({ nodeId: "SalesRevenueServicesNet" }, "yoy"),
      ],
      anchors: { view: "profit", nodeIds: ["software", "HardwareRevenues", "SalesRevenueServicesNet"], metrics: [] },
      lens: { type: "trend", refs: [{ nodeId: "software" }], span: "quarter", rate: "yoy" },
    },
    {
      id: "fy27-outlook",
      kind: "watch",
      severity: 2,
      title: "FY2027: $90 billion of revenue, $40 billion of financing",
      judgment: {
        text: "Management guided FY2027 total revenue to at least $90 billion and plans to raise about $40 billion through debt and equity financing. Whether the sources of growth are durable, how the capex earns its return, and where the limits of risk in the financing structure lie are the three questions every coming quarter has to answer.",
        sourceIds: ["8k-q4-fy26"],
      },
      evidence: [
        ev({ guidanceId: "revenue|amount||annual|2027|||gaap|0001193125-26-265848" }, "2027-05-31", "fiscal_year"),
        ev({ guidanceId: "other|amount||annual|2027||debt-and-equity-financing|unspecified|0001193125-26-265848" }, "2027-05-31", "fiscal_year"),
        amount({ metric: "revenue" }, "yoy"),
      ],
      anchors: { view: "profit", nodeIds: [], metrics: ["revenue"] },
      lens: { type: "trend", refs: [{ metric: "revenue" }], span: "fiscal_year", rate: "yoy" },
      watch: { ref: { metric: "revenue" }, condition: "Whether Q1 FY2027 revenue lands within management's guidance of 27% to 29% year-over-year growth", horizon: "next_quarter", compare: { guidanceId: "revenue|growth||quarter|2027|1||gaap|0001193125-26-265848" } },
    },
  ],
};
