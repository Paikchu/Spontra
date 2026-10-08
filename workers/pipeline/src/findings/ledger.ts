import type { BusinessFlowQuarter, FlowMetric } from "../../../../shared/analysis-contract/business-flow.ts";
import type { CapitalMetric, FindingBaseRef, FindingRef, FindingSpan } from "../../../../shared/analysis-contract/findings.ts";
import type { ExplainerSource } from "../../../../shared/analysis-contract/business-explainer.ts";
import { CAPITAL_METRICS, refLabel, resolveEvidence, shiftPeriod, type FindingData, type ResolvedEvidence } from "../../../../shared/analysis-runtime/findings.ts";

/**
 * The figures a findings writer may speak about: every reference the verifier can resolve, already
 * resolved, in the units Chinese prose uses. The model picks rows and repeats their numbers; it never
 * computes. A number not on the ledger cannot survive verification, so the ledger is also the budget.
 */
export type LedgerRow = { ref: FindingRef; periodEnd: string; span: FindingSpan; label: string; value: string; yoy: string | null; qoq: string | null };
export type Ledger = {
  periodEnd: string;
  rows: LedgerRow[];
  /** Disclosed businesses of the report, as `nodeId` references and anchors. */
  nodes: Array<{ nodeId: string; name: string; parentId: string | null }>;
  guidance: Array<{ guidanceId: string; text: string; periodEnd: string | null; horizon: string }>;
  sources: ExplainerSource[];
};

const FLOW: FlowMetric[] = ["revenue", "cost", "gross", "operating", "other", "pretax", "tax", "net", "operatingExpenses", "research", "sales", "administration"];
/** Two years of quarters: enough to see seasonality, a turn, and whether the year-ago comparison flatters or hides. */
const QUARTERS = 8;
/**
 * The ratios an analytical review runs: margins, expense intensity, accrual quality (cash against
 * profit), capital intensity, working-capital and leverage proxies. Each is one figure over another at
 * the same period, so the verifier can re-derive it and the model cannot invent it.
 */
type RatioForm = "percent" | "multiple";
const RATIOS: Array<[RatioForm, FindingBaseRef, FindingBaseRef]> = [
  ["percent", { metric: "gross" }, { metric: "revenue" }],
  ["percent", { metric: "operating" }, { metric: "revenue" }],
  ["percent", { metric: "net" }, { metric: "revenue" }],
  ["percent", { metric: "research" }, { metric: "revenue" }],
  ["percent", { metric: "sales" }, { metric: "revenue" }],
  ["percent", { metric: "administration" }, { metric: "revenue" }],
  ["percent", { metric: "tax" }, { metric: "pretax" }],
  ["multiple", { capital: "operatingCashFlow" }, { metric: "net" }],
  ["percent", { capital: "capex" }, { metric: "revenue" }],
  ["multiple", { capital: "capex" }, { fundamental: "depreciation_and_amortization" }],
  ["percent", { fundamental: "stock_based_compensation" }, { metric: "revenue" }],
  ["percent", { fundamental: "accounts_receivable" }, { metric: "revenue" }],
  ["percent", { fundamental: "inventory" }, { metric: "revenue" }],
  ["multiple", { capital: "debt" }, { capital: "equity" }],
  ["multiple", { capital: "cash" }, { capital: "debt" }],
  ["multiple", { capital: "rpo" }, { metric: "revenue" }],
];

function money(value: number, currency: string | null): string {
  const abs = Math.abs(value), sign = value < 0 ? "-" : "";
  const unit = currency && currency !== "USD" ? ` ${currency}` : " 美元";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)} 万亿${unit}`;
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(1)} 亿${unit}`;
  return `${sign}${(abs / 1e6).toFixed(1)} 百万${unit}`;
}
function formatValue(r: ResolvedEvidence["current"], form: RatioForm = "multiple"): string {
  if (r.range && r.range.low !== r.range.high) return r.unit === "USD" ? `${money(r.range.low, r.currency)} 至 ${money(r.range.high, r.currency)}` : `${r.range.low}% 至 ${r.range.high}%`;
  if (r.unit === "USD") return money(r.value, r.currency);
  if (r.unit === "percent") return `${Number(r.value.toFixed(1))}%`;
  if (r.unit === "per_share") return `$${r.value.toFixed(2)}`;
  // A margin or an intensity reads as a percentage; a coverage or turnover ratio reads as a multiple.
  return form === "percent" ? `${(r.value * 100).toFixed(1)}%` : `${Number(r.value.toFixed(2))} 倍`;
}
const change = (r: ResolvedEvidence | null) => !r || r.delta == null ? null : r.current.unit === "percent" || r.current.unit === "ratio" ? `${r.delta > 0 ? "+" : ""}${r.delta.toFixed(1)} 点` : `${r.delta > 0 ? "+" : ""}${r.delta.toFixed(1)}%`;

/** Every business the report discloses, in any non-geographic, non-customer partition. */
export function ledgerNodes(quarter: BusinessFlowQuarter | undefined): Ledger["nodes"] {
  const nodes = new Map<string, Ledger["nodes"][number]>();
  const add = (nodeId: string, name: string, parentId: string | null) => { if (!nodes.has(nodeId)) nodes.set(nodeId, { nodeId, name, parentId }); };
  for (const segment of quarter?.segments ?? []) {
    add(segment.id, segment.name, null);
    for (const child of segment.children ?? []) add(child.id, child.name, segment.id);
  }
  for (const breakdown of quarter?.revenueBreakdowns ?? []) {
    if (breakdown.kind === "geography" || breakdown.kind === "customer") continue;
    for (const node of breakdown.nodes) add(node.id, node.name, node.parentId);
  }
  return [...nodes.values()].slice(0, 24);
}

export function buildLedger(data: FindingData, periodEnd: string, sources: ExplainerSource[]): Ledger {
  const rows: LedgerRow[] = [];
  const quarterEnds = Array.from({ length: QUARTERS }, (_, i) => shiftPeriod(periodEnd, -3 * i));
  const yearEnds = [periodEnd, shiftPeriod(periodEnd, -12)];
  const push = (ref: FindingRef, end: string, span: FindingSpan, form: RatioForm = "multiple") => {
    const yoy = resolveEvidence(data, { ref, periodEnd: end, span, compare: "yoy" });
    const qoq = span === "quarter" ? resolveEvidence(data, { ref, periodEnd: end, span, compare: "qoq" }) : null;
    const plain = yoy ?? qoq ?? resolveEvidence(data, { ref, periodEnd: end, span });
    if (!plain) return;
    rows.push({ ref, periodEnd: plain.current.periodEnd, span, label: plain.label, value: formatValue(plain.current, form), yoy: change(yoy), qoq: change(qoq) });
  };
  const series = (ref: FindingRef, spans: FindingSpan[] = ["quarter", "fiscal_year"], form: RatioForm = "multiple") => {
    if (spans.includes("quarter")) for (const end of quarterEnds) push(ref, end, "quarter", form);
    if (spans.includes("fiscal_year")) for (const end of yearEnds) push(ref, end, "fiscal_year", form);
  };
  const newest = data.quarters.find(q => q.periodEnd === periodEnd) ?? [...data.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  for (const metric of FLOW) series({ metric });
  const nodes = ledgerNodes(newest);
  for (const node of nodes.slice(0, 12)) series({ nodeId: node.nodeId });
  for (const [form, numerator, denominator] of RATIOS) series({ ratio: { numerator, denominator } }, ["quarter", "fiscal_year"], form);
  for (const capital of CAPITAL_METRICS as readonly CapitalMetric[]) {
    const instant = ["totalAssets", "debt", "cash", "equity", "rpo", "rpoNext12MonthsShare"].includes(capital);
    // Instants have no span; flows are shown as the quarter and the fiscal year.
    if (instant) for (const end of quarterEnds.slice(0, 2)) push({ capital }, end, "quarter");
    else series({ capital });
  }
  for (const key of ["diluted_eps", "free_cash_flow", "stock_based_compensation", "depreciation_and_amortization", "cash_and_cash_equivalents", "long_term_debt"] as const) series({ fundamental: key }, ["quarter"]);
  if (rows.some(r => "nodeId" in r.ref && r.ref.nodeId === nodes[0]?.nodeId) && rows.some(r => "capital" in r.ref && r.ref.capital === "capex")) {
    for (const node of nodes.filter(n => !n.parentId).slice(0, 4)) push({ ratio: { numerator: { nodeId: node.nodeId }, denominator: { capital: "capex" } } }, periodEnd, "fiscal_year");
  }
  const guidance = (data.guidance?.items ?? []).filter(i => !i.periodEnd || i.periodEnd >= shiftPeriod(periodEnd, -12)).slice(0, 40)
    .map(i => ({ guidanceId: i.id, text: i.text, periodEnd: i.periodEnd, horizon: i.horizon }));
  return { periodEnd, rows: rows.slice(0, 640), nodes, guidance, sources };
}

export const ledgerRefLabel = (data: FindingData, ref: FindingRef) => refLabel(data, ref);
