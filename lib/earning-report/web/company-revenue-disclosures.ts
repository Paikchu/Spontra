import type { BusinessFlowQuarter, FlowAmount, FlowMetric, RevenueBreakdownNode } from "@/shared/analysis-contract/business-flow";

const sourceId = "nvda-fy2027-q2-10q";
const source = { id: sourceId, title: "NVIDIA FY2027 Q2 10-Q · 收入、财务分部与市场平台（第 3、22–24 页）", url: "https://investor.nvidia.com/files/doc_financials/2027/NVDA-2027-Q2-10Q-Final-including-exhibits.pdf", publishedAt: "2026-08-27" };
// Reviewed public filing values, in USD millions. Never a ticker-wide default or an estimate.
const figures: Partial<Record<FlowMetric, number>> = { revenue: 96221, cost: 24079, gross: 72142, research: 7054, operatingExpenses: 8408, operating: 63734, other: 7773, pretax: 71507, tax: 11819, net: 59688 };

/** Attach only to the exact quarter when every available financial amount agrees with the filing. */
export function enrichDisclosedRevenue(ticker: string, q: BusinessFlowQuarter): BusinessFlowQuarter {
  if (ticker !== "NVDA" || q.periodType !== "3M" || q.periodEnd !== "2026-07-26" || q.currency !== "USD" ||
      (q.periodStart != null && q.periodStart !== "2026-04-27") || !Number.isFinite(q.scale) || q.scale <= 0) return q;
  if (q.figures.revenue?.value == null || !Number.isFinite(Number(q.figures.revenue.value)) || Math.abs(Number(q.figures.revenue.value) * q.scale / 1e6 - figures.revenue!) > 1e-6) return q;
  for (const [key, expected] of Object.entries(figures)) {
    const value = q.figures[key as FlowMetric]?.value;
    if (value != null && (!Number.isFinite(Number(value)) || Math.abs(Number(value) * q.scale / 1e6 - expected) > 1e-6)) return q;
  }
  if (q.sources.some(s => s.id === sourceId && s.url !== source.url)) return q;
  const amount = (value: number, definition: string): FlowAmount => ({ value: String(value * 1e6 / q.scale), basis: "reported", definition,
    comparabilityKey: null, sourceIds: [sourceId] });
  const node = (id: string, name: string, value: number, parentId: string | null, description: string, products: string[], childrenComplete = false): RevenueBreakdownNode => ({
    id, name, revenue: amount(value, `market-platform:${id}`), parentId, childrenComplete, description, products, customers: null, monetization: null,
    disclosure: "FY2027 Q2 市场平台收入口径；不与财务分部建立金额父子关系。产品单独营收未披露。", sourceIds: [sourceId],
  });
  const breakdown = { id: "nvda-market-platform-fy27", label: "市场平台", kind: "end_market" as const,
    definitionKey: "NVDA:market-platform:FY27-Q2-recast", periodStart: "2026-04-27", periodEnd: q.periodEnd, currency: q.currency, scale: q.scale, complete: true,
    nodes: [node("data-center", "数据中心", 89023, null, "数据中心加速计算、网络与 AI 基础设施。", ["计算与网络平台", "AI 基础设施"], true),
      node("hyperscale", "超大规模云客户", 48710, "data-center", "市场平台披露中的 Hyperscale 类别。", []),
      node("acie", "AI 云、工业与企业", 40313, "data-center", "市场平台披露中的 AI Clouds, Industrial, & Enterprise 类别。", []),
      node("edge", "边缘计算", 7198, null, "市场平台披露中的 Edge Computing 类别。", [])] };
  const disclosedFigures = { ...q.figures };
  for (const [key, value] of Object.entries(figures)) {
    if (disclosedFigures[key as FlowMetric]?.value == null) disclosedFigures[key as FlowMetric] = amount(value, `consolidated:${key}`);
  }
  // SG&A is combined in this filing; never manufacture separate sales/admin amounts.
  const segments = q.segments.length ? q.segments : [
    { ...node("compute", "计算与网络", 88299, null, "财务分部：数据中心计算、网络及汽车平台。", ["计算与网络平台", "汽车平台"]), revenue: amount(88299, "financial-segment:compute"), disclosure: "财务分部收入；不是数据中心市场平台的父节点。" },
    { ...node("graphics", "图形", 7922, null, "财务分部：游戏与工作站图形。", ["游戏显卡", "专业工作站图形"]), revenue: amount(7922, "financial-segment:graphics"), disclosure: "财务分部收入，与市场平台属于不同分类。" },
  ];
  return { ...q, basisLabel: q.basisLabel.includes("NVIDIA FY2027 Q2 10-Q") ? q.basisLabel : `${q.basisLabel} · 收入细分及缺失财务项补充自 NVIDIA FY2027 Q2 10-Q`, periodStart: "2026-04-27", reportedAt: q.reportedAt ?? source.publishedAt, figures: disclosedFigures,
    segments, segmentsComplete: q.segments.length ? q.segmentsComplete : true,
    sources: q.sources.some(s => s.id === sourceId) ? q.sources : [...q.sources, source],
    revenueBreakdowns: q.revenueBreakdowns?.some(d => d.id === breakdown.id) ? q.revenueBreakdowns : [...q.revenueBreakdowns ?? [], breakdown] };
}
