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
      title: "资本开支 557 亿，自由现金流转负",
      judgment: {
        text: "FY2026 资本开支 557 亿美元，超出管理层此前 500 亿美元的指引，是 FY2025 的 2.6 倍。经营现金流创纪录地达到 320 亿美元、同比增长 54%，但自由现金流仍为 -237 亿美元。缺口由外部资金填补：全年新增借款 461 亿美元，总资产一年内从 1684 亿美元增至 2618 亿美元，增幅 55%，主要是数据中心资产与租赁。每美元资本开支对应的云收入从上一年的 1.16 美元降到 0.61 美元。这是用资产负债表换云收入增速：若 AI 云需求的兑现节奏或融资环境变化，高额资本开支会变成财务负担。",
        sourceIds: ["10k-fy26", "8k-q3-fy26"],
      },
      evidence: [
        ev({ capital: "capex" }, FY26, "fiscal_year", { guidanceId: "capex|amount||annual|2026|||gaap|0001193125-26-100148" }, "FY2026 资本开支"),
        amount({ capital: "capex" }, "yoy"),
        amount({ capital: "operatingCashFlow" }, "yoy"),
        amount({ capital: "freeCashFlow" }),
        amount({ capital: "debtIssued" }),
        ev({ capital: "totalAssets" }, FY26, "quarter", "yoy", "总资产"),
        ev({ ratio: { numerator: { nodeId: "cloud" }, denominator: { capital: "capex" } } }, FY26, "fiscal_year", "yoy", "每美元资本开支对应的云收入"),
      ],
      anchors: { view: "cash", nodeIds: [], metrics: [], capital: ["capex", "operatingCashFlow", "freeCashFlow", "debtIssued"] },
      lens: { type: "compare_bars", refs: [{ capital: "operatingCashFlow" }, { capital: "capex" }, { capital: "freeCashFlow" }], span: "fiscal_year" },
      pairWith: "cloud-engine",
      watch: { ref: { ratio: { numerator: { nodeId: "cloud" }, denominator: { capital: "capex" } } }, condition: "FY2027 每美元资本开支对应的云收入是否止跌；管理层计划的约 400 亿美元债务和股权融资是否按计划推进", horizon: "fiscal_year", compare: "yoy" },
    },
    {
      id: "cloud-engine",
      kind: "strength",
      severity: 3,
      title: "云业务成为核心引擎",
      judgment: {
        text: "FY2026 云服务收入 340 亿美元，同比增长 39%，已占总收入约一半；同期软件收入 245 亿美元，同比下降 1%。公司的业务模型正从许可证销售切换到云订阅与消费。管理层此前指引 FY2026 OCI 收入 180 亿美元、增长 77%，云基础设施是当前唯一的增长叙事，且增速在逐季加速而非放缓。",
        sourceIds: ["10k-fy26", "8k-q1-fy26"],
      },
      evidence: [
        amount({ nodeId: "cloud" }, "yoy"),
        amount({ nodeId: "software" }, "yoy"),
        ev({ nodeId: "CloudInfrastructure" }, FY26, "quarter", undefined, "Q4 FY2026 云基础设施"),
        ev({ guidanceId: "segment_revenue|amount|oracle-cloud-infrastructure|annual|2026|||unspecified|0001193125-25-199175" }, FY26, "fiscal_year"),
        ev({ guidanceId: "segment_revenue|growth|oracle-cloud-infrastructure|annual|2026|||unspecified|0001193125-25-199175" }, FY26, "fiscal_year"),
      ],
      anchors: { view: "profit", nodeIds: ["cloud", "CloudInfrastructure", "CloudApplications"], metrics: [] },
      lens: { type: "share_area", nodeIds: ["cloud", "software", "HardwareRevenues", "SalesRevenueServicesNet"] },
      pairWith: "capex-fcf",
      watch: { ref: { nodeId: "cloud" }, condition: "云收入同比增速是否继续加速，并落在管理层给出的 FY2027 Q1 云业务总收入增长 58% 至 64% 的指引内", horizon: "next_quarter", compare: { guidanceId: "segment_revenue|growth|total-cloud-revenue|quarter|2027|1||gaap|0001193125-26-265848" } },
    },
    {
      id: "growth-acceleration",
      kind: "strength",
      severity: 2,
      title: "收入增速翻倍，经营杠杆释放",
      judgment: {
        text: "FY2026 总收入 674 亿美元，同比增长 17%，上一财年为 574 亿美元。第四季度单季收入 192 亿美元，同比增长 21%，创历史新高。全年净利润 171 亿美元，第四季度净利润 43 亿美元、同比增长 26%。收入增速从个位数升至 17%，利润增速高于收入增速，经营杠杆正在释放。",
        sourceIds: ["10k-fy26", "10k-fy25"],
      },
      evidence: [
        amount({ metric: "revenue" }, "yoy"),
        ev({ metric: "revenue" }, "2025-05-31", "fiscal_year", undefined, "FY2025 总收入"),
        ev({ metric: "revenue" }, FY26, "quarter", "yoy", "Q4 FY2026 收入"),
        amount({ metric: "net" }),
        ev({ metric: "net" }, FY26, "quarter", "yoy", "Q4 FY2026 净利润"),
      ],
      anchors: { view: "profit", nodeIds: [], metrics: ["revenue", "operating", "net"] },
      lens: { type: "trend", refs: [{ metric: "revenue" }, { metric: "net" }], span: "quarter", rate: "yoy" },
    },
    {
      id: "legacy-shrink",
      kind: "shift",
      severity: 1,
      title: "传统业务结构性收缩",
      judgment: {
        text: "FY2026 软件收入 245 亿美元，同比下降 1%；硬件收入 31 亿美元，同比增长 5%，规模已不是战略重心；服务收入 57 亿美元，同比增长 10%，属于辅助性收入。传统业务的收缩是结构性的，不是周期性的，注意力应放在云业务的增速、产能交付节奏和单位经济模型上。",
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
      title: "FY2027：900 亿收入、400 亿融资",
      judgment: {
        text: "管理层指引 FY2027 全年总收入至少 900 亿美元，并计划通过债务和股权融资筹集约 400 亿美元。增长的来源是否可持续、资本开支的回报逻辑、融资结构的风险边界，是接下来每个季度都要回答的三个问题。",
        sourceIds: ["8k-q4-fy26"],
      },
      evidence: [
        ev({ guidanceId: "revenue|amount||annual|2027|||gaap|0001193125-26-265848" }, "2027-05-31", "fiscal_year"),
        ev({ guidanceId: "other|amount||annual|2027||debt-and-equity-financing|unspecified|0001193125-26-265848" }, "2027-05-31", "fiscal_year"),
        amount({ metric: "revenue" }, "yoy"),
      ],
      anchors: { view: "profit", nodeIds: [], metrics: ["revenue"] },
      lens: { type: "trend", refs: [{ metric: "revenue" }], span: "fiscal_year", rate: "yoy" },
      watch: { ref: { metric: "revenue" }, condition: "FY2027 Q1 收入是否落在管理层指引的同比增长 27% 至 29% 内", horizon: "next_quarter", compare: { guidanceId: "revenue|growth||quarter|2027|1||gaap|0001193125-26-265848" } },
    },
  ],
};
