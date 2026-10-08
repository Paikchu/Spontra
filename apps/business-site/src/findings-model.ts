import type { BusinessFlowQuarter, FlowMetric, PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { CapitalMetric, FindingLens, FindingRef, FindingSpan, FindingsPublication } from "@/shared/analysis-contract/findings";
import type { PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";
import type { GuidancePublication } from "@/shared/analysis-contract/guidance";
import type { RevenueHistory } from "@/shared/analysis-contract/revenue-history";
import { refLabel, resolveRef, shiftPeriod, verifyFindings, type FindingData, type FindingFundamentals, type ResolvedValue, type VerifiedFinding } from "@/shared/analysis-runtime/findings";

export type { VerifiedFinding };

export const KIND_LABEL: Record<VerifiedFinding["kind"], string> = { risk: "风险", strength: "亮点", shift: "转变", watch: "跟踪" };
export const VIEW_LABEL = { profit: "利润", cash: "现金流", balance: "资产负债" } as const;

export function findingData(flow: PublicBusinessFlow, history: RevenueHistory | null, capital: PublicCapitalStructure | null, fundamentals: FindingFundamentals | null, guidance: GuidancePublication | null): FindingData {
  return { quarters: flow.quarters, history, capital, fundamentals, guidance };
}

/** Findings the page can stand behind, most severe first. */
export function verifiedFindings(publication: FindingsPublication | null, data: FindingData): VerifiedFinding[] {
  return publication ? verifyFindings(publication, data).verified : [];
}

/** Sankey node names a finding lights on the profit statement: its businesses, and the statement lines it names. */
export function anchorNodeNames(f: VerifiedFinding, quarter: BusinessFlowQuarter | undefined, items: Array<{ id: string; key: string }>): Set<string> {
  const names = new Set<string>();
  for (const id of f.anchors.nodeIds) { const item = items.find(i => i.id === id); if (item) names.add("segment:" + item.key); }
  for (const metric of f.anchors.metrics) {
    // Operating-expense lines are drawn as their disclosed components when the quarter has them.
    const group = metric === "research" || metric === "sales" || metric === "administration" ? metric : metric === "operatingExpenses" ? "direct" : null;
    const components = group ? quarter?.expenseComponents?.filter(c => c.group === group) ?? [] : [];
    if (components.length) components.forEach(c => names.add("expense:" + c.id));
    else if (metric === "other" && quarter?.otherComponents?.length) quarter.otherComponents.forEach(c => names.add("other:" + c.id));
    else names.add(metric);
  }
  return names;
}

/** Pool item keys a finding lights on the cash-flow or balance-sheet pool (see capital-model's item keys). */
export function anchorPoolKeys(f: VerifiedFinding): Set<string> {
  const keys = new Set<string>();
  const add = (...list: string[]) => list.forEach(k => keys.add(k));
  for (const metric of f.anchors.capital ?? []) {
    switch (metric as CapitalMetric) {
      case "operatingCashFlow": add("operating", "operating-burn"); break;
      case "capex": add("capex", "capex-out"); break;
      case "freeCashFlow": add("operating", "operating-burn", "capex", "capex-out"); break;
      case "financing": add("debt-issued", "debt-issued-out", "debt-repaid", "debt-repaid-out", "equity", "equity-out", "buybacks", "buybacks-out", "dividends", "dividends-out", "lease", "lease-out"); break;
      case "debtIssued": add("debt-issued", "debt-issued-out"); break;
      case "debtRepaid": add("debt-repaid", "debt-repaid-out"); break;
      case "equityIssued": add("equity", "equity-out"); break;
      case "buybacks": add("buybacks", "buybacks-out"); break;
      case "dividends": add("dividends", "dividends-out"); break;
      case "debt": add("debt"); break;
      case "cash": add("cash", "cash-added", "cash-used"); break;
      case "equity": add("paid-in", "retained", "equity-other"); break;
      case "totalAssets": add("productive", "lease-assets", "cash", "receivables", "inventory", "intangibles", "investments", "assets-other"); break;
    }
  }
  return keys;
}

/** The first finding each Sankey node belongs to, for the overview badges. */
export function badgesByNode(findings: VerifiedFinding[], quarter: BusinessFlowQuarter | undefined, items: Array<{ id: string; key: string }>): Map<string, VerifiedFinding> {
  const map = new Map<string, VerifiedFinding>();
  for (const f of findings) for (const name of anchorNodeNames(f, quarter, items)) if (!map.has(name)) map.set(name, f);
  return map;
}

/* ---------- Lens models ---------- */

export type LensSeries = { ref: FindingRef; label: string; unit: ResolvedValue["unit"]; values: Array<ResolvedValue | null> };
export type LensColumns = { periods: string[]; span: FindingSpan; series: LensSeries[]; rates: Array<number | null>; rateLabel: string | null };
export type LensShares = { periods: string[]; nodes: Array<{ id: string; label: string }>; shares: number[][]; totals: Array<number | null> };

/** Period ends drawn by a lens: the last eight quarters, or the last four fiscal years, ending at the finding's report. */
export function lensPeriods(periodEnd: string, span: FindingSpan, count = span === "quarter" ? 8 : 4): string[] {
  const step = span === "quarter" ? -3 : -12;
  return Array.from({ length: count }, (_, i) => shiftPeriod(periodEnd, step * (count - 1 - i)));
}

export function lensColumns(lens: Extract<FindingLens, { type: "trend" | "compare_bars" }>, periodEnd: string, data: FindingData): LensColumns {
  const periods = lensPeriods(periodEnd, lens.span);
  const series = lens.refs.map(ref => {
    const values = periods.map(end => resolveRef(data, ref, end, lens.span));
    return { ref, label: refLabel(data, ref), unit: values.find(v => v)?.unit ?? "USD", values };
  });
  const rate = lens.type === "trend" ? lens.rate ?? null : null;
  const first = series[0];
  // Growth of the first series: against a year earlier, or the previous period; the base is resolved outside the drawn window.
  const rates = periods.map((end, i) => {
    if (!rate || !first.values[i]) return null;
    const months = rate === "yoy" ? -12 : lens.span === "quarter" ? -3 : -12;
    const base = resolveRef(data, first.ref, shiftPeriod(end, months), lens.span);
    return base && base.value > 0 ? (first.values[i]!.value / base.value - 1) * 100 : null;
  });
  return { periods, span: lens.span, series, rates, rateLabel: rate ? `${first.label}${rate === "yoy" ? "同比" : "环比"}` : null };
}

export function lensShares(lens: Extract<FindingLens, { type: "share_area" }>, periodEnd: string, data: FindingData): LensShares {
  const periods = lensPeriods(periodEnd, "quarter", 12).filter(end => data.history?.quarters.some(q => Math.abs(Date.parse(q.periodEnd) - Date.parse(end)) <= 20 * 86_400_000));
  const nodes = lens.nodeIds.map(id => ({ id, label: refLabel(data, { nodeId: id }) }));
  const totals = periods.map(end => resolveRef(data, { metric: "revenue" }, end, "quarter")?.value ?? null);
  const shares = periods.map((end, i) => nodes.map(n => { const v = resolveRef(data, { nodeId: n.id }, end, "quarter"); return v && totals[i] ? v.value / totals[i]! : NaN; }));
  return { periods, nodes, shares, totals };
}

export const metricLabel = (metric: FlowMetric, data: FindingData) => refLabel(data, { metric });
