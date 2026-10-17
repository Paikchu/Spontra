import type { BusinessFlowQuarter, FlowAmount, FlowMetric, RevenueBreakdownNode } from "@/shared/analysis-contract/business-flow";

const sourceId = "nvda-fy2027-q2-10q";
const source = { id: sourceId, title: "NVIDIA FY2027 Q2 10-Q · Revenue, segments and market platforms (pages 3, 22–24)", url: "https://investor.nvidia.com/files/doc_financials/2027/NVDA-2027-Q2-10Q-Final-including-exhibits.pdf", publishedAt: "2026-08-27" };
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
    disclosure: "FY2027 Q2 revenue by market platform; not a parent or child of the financial segments. Product-level revenue is not disclosed.", sourceIds: [sourceId],
  });
  const breakdown = { id: "nvda-market-platform-fy27", label: "Market platforms", kind: "end_market" as const,
    definitionKey: "NVDA:market-platform:FY27-Q2-recast", periodStart: "2026-04-27", periodEnd: q.periodEnd, currency: q.currency, scale: q.scale, complete: true,
    nodes: [node("data-center", "Data Center", 89023, null, "Accelerated computing, networking and AI infrastructure for data centers.", ["Compute and networking platforms", "AI infrastructure"], true),
      node("hyperscale", "Hyperscale", 48710, "data-center", "The Hyperscale category in the market platform disclosure.", []),
      node("acie", "AI Clouds, Industrial, & Enterprise", 40313, "data-center", "The AI Clouds, Industrial, & Enterprise category in the market platform disclosure.", []),
      node("edge", "Edge Computing", 7198, null, "The Edge Computing category in the market platform disclosure.", [])] };
  const disclosedFigures = { ...q.figures };
  for (const [key, value] of Object.entries(figures)) {
    if (disclosedFigures[key as FlowMetric]?.value == null) disclosedFigures[key as FlowMetric] = amount(value, `consolidated:${key}`);
  }
  // SG&A is combined in this filing; never manufacture separate sales/admin amounts.
  const segments = q.segments.length ? q.segments : [
    { ...node("compute", "Compute & Networking", 88299, null, "Financial segment: data center compute, networking and automotive platforms.", ["Compute and networking platforms", "Automotive platforms"]), revenue: amount(88299, "financial-segment:compute"), disclosure: "Financial segment revenue; not the parent of the Data Center market platform." },
    { ...node("graphics", "Graphics", 7922, null, "Financial segment: gaming and workstation graphics.", ["Gaming GPUs", "Professional workstation graphics"]), revenue: amount(7922, "financial-segment:graphics"), disclosure: "Financial segment revenue, a different classification from the market platforms." },
  ];
  return { ...q, basisLabel: q.basisLabel.includes("NVIDIA FY2027 Q2 10-Q") ? q.basisLabel : `${q.basisLabel} · Revenue breakdown and missing items supplemented from the NVIDIA FY2027 Q2 10-Q`, periodStart: "2026-04-27", reportedAt: q.reportedAt ?? source.publishedAt, figures: disclosedFigures,
    segments, segmentsComplete: q.segments.length ? q.segmentsComplete : true,
    sources: q.sources.some(s => s.id === sourceId) ? q.sources : [...q.sources, source],
    revenueBreakdowns: q.revenueBreakdowns?.some(d => d.id === breakdown.id) ? q.revenueBreakdowns : [...q.revenueBreakdowns ?? [], breakdown] };
}
