import { publicFlowSchema } from "@/src/domains/financials/runtime/schema.ts";
import { type BusinessFlowQuarter, type FlowAmount, type FlowMetric, type PublicBusinessFlow } from "@/src/domains/financials/business-flow-contract.ts";
import type { PublicFundamentalsResponse, FundamentalMetricKey } from "@/src/domains/financials/fundamentals-contract.ts";
import { edgarSearchUrl } from "@/src/domains/sec-archive/sec-sources.ts";

export function numeric(amount: FlowAmount | null | undefined): number | null {
  if (typeof amount?.value !== "string" || amount.value.trim() === "") return null;
  const value = Number(amount.value);
  return Number.isFinite(value) ? value : null;
}

const metricMap: Partial<Record<FlowMetric, FundamentalMetricKey>> = { revenue: "total_revenue", gross: "gross_profit", operating: "operating_income", net: "net_income", research: "research_and_development" };

export function adaptFundamentals(data: PublicFundamentalsResponse | null, ticker: string): PublicBusinessFlow {
  if (!data || data.ticker !== ticker || !Array.isArray(data.periods) || !Array.isArray(data.series)) return { schemaVersion: "business-flow.v1", ticker, fetchedAt: null, quarters: [] };
  const quarters = data.periods.filter(p => p && p.periodType === "3M" && typeof p.periodEnd === "string" && Number.isFinite(Date.parse(p.periodEnd))).map(period => {
    const figures: BusinessFlowQuarter["figures"] = {};
    const sources: BusinessFlowQuarter["sources"] = [];
    for (const [target, key] of Object.entries(metricMap)) {
      const series = data.series.find(s => s && Array.isArray(s.points) && s.metricKey === key && s.unitFamily === "currency" && s.currency === period.currency && s.unit === period.currency);
      const point = series?.points.find(p => p && p.periodEnd === period.periodEnd);
      if (!series || !point) continue;
      if (point.sourceAccession && !sources.some(s => s.id === point.sourceAccession)) sources.push({ id: point.sourceAccession, title: `SEC filing ${point.sourceAccession}`, url: edgarSearchUrl(point.sourceAccession), publishedAt: point.sourceFiledAt });
      figures[target as FlowMetric] = { value: point.valueDecimal, basis: series.basis, definition: `${data.catalogVersion}:${key}`, comparabilityKey: point.revision != null ? `${data.source}:${key}:revision-${point.revision}` : null, sourceIds: point.sourceAccession ? [point.sourceAccession] : [], formula: point.derivationFormula };
    }
    // Differences are only formed from figures in the same filing/revision. No YTD subtraction.
    for (const [target, left, right] of [["cost", "revenue", "gross"], ["operatingExpenses", "gross", "operating"]] as const) {
      const a = figures[left], b = figures[right];
      const av = numeric(a), bv = numeric(b);
      const sharedFiling = a?.sourceIds.length && a.sourceIds.join() === b?.sourceIds.join();
      const leftPoint = data.series.find(s => s && Array.isArray(s.points) && s.metricKey === metricMap[left])?.points.find(p => p && p.periodEnd === period.periodEnd);
      const rightPoint = data.series.find(s => s && Array.isArray(s.points) && s.metricKey === metricMap[right])?.points.find(p => p && p.periodEnd === period.periodEnd);
      const sharedRevision = leftPoint?.revision != null && leftPoint.revision === rightPoint?.revision;
      if (av != null && bv != null && (sharedFiling || sharedRevision)) figures[target] = { value: String(av - bv), basis: "derived", definition: `${left}-${right}`, comparabilityKey: a?.comparabilityKey && b?.comparabilityKey ? `${a.comparabilityKey}|${b.comparabilityKey}` : null, sourceIds: a?.sourceIds ?? [], formula: `${left} − ${right}` };
    }
    return { id: period.periodEnd, label: `Three months ended ${period.periodEnd}`, periodStart: null, periodEnd: period.periodEnd, periodType: "3M" as const, currency: period.currency, scale: 1, basisLabel: `${data.source === "sec_xbrl" ? "SEC XBRL" : "Yahoo Finance"} · Three-month quarterly data · Recast comparability not verified`, reportedAt: null, figures, segments: [], segmentsComplete: false, sources };
  });
  return { schemaVersion: "business-flow.v1", ticker, fetchedAt: data.fetchedAt, quarters };
}

export function selectFlow(published: PublicBusinessFlow | undefined, fundamentals: PublicFundamentalsResponse | null, ticker: string): PublicBusinessFlow {
  const parsed = publicFlowSchema.safeParse(published);
  return parsed.success && parsed.data.ticker === ticker && parsed.data.quarters.length ? parsed.data : adaptFundamentals(fundamentals, ticker);
}
