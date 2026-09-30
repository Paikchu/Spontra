import type { BusinessFlowQuarter, FlowAmount, FlowMetric, PublicBusinessFlow } from "../../shared/analysis-contract/business-flow";

// Test-only verified example, deliberately excluded from the production UI/import graph.
const make = (values: number[], index: number): BusinessFlowQuarter => {
  const keys: FlowMetric[] = ["revenue", "cost", "gross", "research", "sales", "administration", "operating", "other", "pretax", "tax", "net"];
  const amount = (value: number, definition: string): FlowAmount => ({ value: String(value), basis: "reported", definition, comparabilityKey: "MSFT:FY26-original", sourceIds: [`q${index}`] });
  const figures = Object.fromEntries(keys.map((key, i) => [key, amount(values[i], key)]));
  figures.operatingExpenses = { ...amount(values[3] + values[4] + values[5], "research+sales+administration"), basis: "derived", formula: "研发 + 销售营销 + 行政" };
  const segments = index === 4 ? [37847, 39306, 12854] : [35013, 34681, 13192];
  return { id: `FY26-Q${index}`, label: `FY26 Q${index} · 测试 fixture`, periodStart: index === 4 ? "2026-04-01" : "2026-01-01", periodEnd: index === 4 ? "2026-06-30" : "2026-03-31", periodType: "3M", currency: "USD", scale: 1_000_000, basisLabel: "FY26 原披露 · 非 FY27 分部重列 · 测试 fixture", reportedAt: null, figures, segmentsComplete: true,
    segments: ["生产力与业务流程", "智能云", "更多个人计算"].map((name, i) => ({ id: `segment-${i}`, name, revenue: amount(segments[i], `segment-${i}`), description: "测试业务说明，用于验证原位置展开与收起。", products: i === 0 ? ["Microsoft 365", "Dynamics", "LinkedIn"] : i === 1 ? ["Azure", "服务器产品"] : ["Windows", "Xbox", "搜索广告"], customers: "企业与个人用户（测试展示）", monetization: "订阅、许可与服务（测试展示）", disclosure: "FY26 原披露。产品独立营收未披露，产品仅显示归属。", sourceIds: [`q${index}`] })),
    sources: [{ id: `q${index}`, title: `微软 FY26 Q${index} 原始披露`, url: index === 4 ? "https://www.microsoft.com/en-us/investor/earnings/fy-2026-q4/press-release-webcast" : "https://www.microsoft.com/en-us/investor/earnings/fy-2026-q3/income-statements" }] };
};
export const businessFlowFixture: PublicBusinessFlow = { schemaVersion: "business-flow.v1", ticker: "MSFT", fetchedAt: "2026-09-30T00:00:00Z", quarters: [make([90007,29525,60482,9997,7595,2287,40603,3444,44047,8281,35766],4), make([82886,26828,56058,8915,6814,1931,38398,942,39340,7562,31778],3)] };
