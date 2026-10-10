import type { BusinessFlowQuarter, PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { CapitalMetric, FindingLens, FindingRef, FindingSpan, FindingsPublication } from "@/shared/analysis-contract/findings";
import type { PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";
import type { GuidancePublication } from "@/shared/analysis-contract/guidance";
import type { RevenueHistory } from "@/shared/analysis-contract/revenue-history";
import { refLabel, resolveRef, rpoNextYearShare, shiftPeriod, verifyFindings, type FindingData, type FindingFundamentals, type ResolvedValue, type VerifiedFinding } from "@/shared/analysis-runtime/findings";
import type { RpoDisclosure } from "@/shared/analysis-contract/capital-structure";

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
  // A writer may name the same reference for each comparison it makes; the chart draws it once.
  const refs = [...new Map(lens.refs.map(ref => [JSON.stringify(ref), ref])).values()];
  const series = refs.map(ref => {
    const values = periods.map(end => resolveRef(data, ref, end, lens.span));
    return { ref, label: refLabel(data, ref), unit: values.find(v => v)?.unit ?? "USD", values };
  });
  // Leading periods no series can answer are left out, so a short history does not open with empty slots.
  const first = series[0];
  const lead = periods.findIndex((_, i) => series.some(s => s.values[i]));
  if (lead > 0) { periods.splice(0, lead); for (const s of series) s.values.splice(0, lead); }
  const rate = lens.type === "trend" ? lens.rate ?? null : null;
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

/** One rung of the conversion ladder: the share (and amount, when tagged) expected within a span of months after the period end. */
export type LadderStep = { from: number; to: number | null; share: number | null; amount: number | null };
export type LensLadder = { columns: LensColumns; latest: { asOf: string; total: number; currency: string; nextYear: number | null; steps: LadderStep[]; remainder: number | null } | null };

const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

/** RPO over the recent quarters, and for the finding's report how it is expected to convert over time, as the issuer tagged it. */
export function lensLadder(periodEnd: string, data: FindingData): LensLadder {
  const columns = lensColumns({ type: "trend", refs: [{ capital: "rpo" }], span: "quarter", rate: "yoy" }, periodEnd, data);
  const rpo: RpoDisclosure | null | undefined = data.capital?.quarters.find(q => Math.abs(Date.parse(q.periodEnd) - Date.parse(periodEnd)) <= 20 * 86_400_000)?.rpo;
  if (!rpo) return { columns, latest: null };
  const total = Number(rpo.total);
  const steps = rpo.buckets.map((b): LadderStep => {
    // A bucket starts the month after the period end unless its start says otherwise; its end is its tagged length later.
    const from = b.start ? Math.max(0, monthsBetween(rpo.asOf, b.start) - 1) : 0;
    const share = b.share != null ? Number(b.share) * 100 : b.amount != null && total ? Number(b.amount) / total * 100 : null;
    return { from, to: b.months == null ? null : from + b.months, share, amount: b.amount != null ? Number(b.amount) : share != null ? total * share / 100 : null };
  }).sort((a, b) => a.from - b.from);
  const covered = steps.every(s => s.share != null) ? steps.reduce((sum, s) => sum + s.share!, 0) : null;
  return { columns, latest: { asOf: rpo.asOf, total, currency: rpo.currency, nextYear: rpoNextYearShare(rpo), steps, remainder: covered != null && covered < 99.5 ? 100 - covered : null } };
}
