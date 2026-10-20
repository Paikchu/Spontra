import type { BusinessFlowQuarter, FlowMetric } from "../../../../shared/analysis-contract/business-flow.ts";
import type { CapitalMetric, FindingBaseRef, FindingRef, FindingSpan, FindingView } from "../../../../shared/analysis-contract/findings.ts";
import type { ExplainerSource } from "../../../../shared/analysis-contract/business-explainer.ts";
import { CAPITAL_INSTANTS, CAPITAL_METRICS, refLabel, resolveEvidence, shiftPeriod, type FindingData, type ResolvedEvidence } from "../../../../shared/analysis-runtime/findings.ts";
import { ratioForm, refView } from "../../../../shared/analysis-runtime/highlights.ts";
import { assessStatements, formatMetric, METRIC_DEFS } from "../../../../shared/analysis-runtime/statement-analysis.ts";
import type { DerivedMetric } from "../../../../shared/analysis-contract/findings.ts";

/**
 * The figures a findings writer may speak about: every reference the verifier can resolve, already
 * resolved, written the way the English findings quote them ("$55.7 billion", "12.3%", "+1.5 pp", "2.6x"). The
 * model picks rows and repeats their numbers; it never computes. A number not on the ledger cannot survive
 * verification, so the ledger is also the budget.
 */
export type LedgerRow = { ref: FindingRef; periodEnd: string; span: FindingSpan; label: string; value: string; yoy: string | null; qoq: string | null };
/**
 * A rule of the three-statement checkup (docs/three-statement-analysis-design.md) the report trips, as the page shows it
 * beside the findings: the metric, its value written as the page writes it, the rule as a formula, and the quarter the
 * run began. `ref` is the metric's reference, whose ledger rows carry the numbers a finding may quote.
 */
export type LedgerFlag = { rule: string; level: "alert" | "watch" | "note"; metric: string; value: string; threshold: string; since: string; ref: FindingRef; span: FindingSpan };
export type Ledger = {
  periodEnd: string;
  rows: LedgerRow[];
  /** Disclosed businesses of the report, as `nodeId` references and anchors. */
  nodes: Array<{ nodeId: string; name: string; parentId: string | null }>;
  guidance: Array<{ guidanceId: string; text: string; periodEnd: string | null; horizon: string }>;
  sources: ExplainerSource[];
  /** The checkup's flags at the report, alerts first. */
  flags: LedgerFlag[];
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
  // Capital intensity, funding and obligations: what the analyst lines of inquiry read first (docs/analyst-agent-design.md).
  ["multiple", { capital: "capex" }, { capital: "depreciation" }],
  ["percent", { capital: "stockCompensation" }, { metric: "revenue" }],
  ["percent", { capital: "interestPaid" }, { capital: "operatingCashFlow" }],
  ["multiple", { capital: "currentAssets" }, { capital: "currentLiabilities" }],
  ["multiple", { capital: "leases" }, { capital: "debt" }],
  ["percent", { capital: "customerAdvances" }, { metric: "revenue" }],
  ["multiple", { capital: "productive" }, { metric: "revenue" }],
  // The checkup's returns, leverage and funding (docs/three-statement-analysis-design.md), over its derived figures.
  ["percent", { metric: "net" }, { derived: "averageEquity" }],
  ["percent", { derived: "nopat" }, { derived: "averageInvestedCapital" }],
  ["multiple", { metric: "revenue" }, { derived: "averageAssets" }],
  ["multiple", { derived: "netDebt" }, { derived: "ebitda" }],
  ["percent", { derived: "netExternalFunding" }, { capital: "capex" }],
  ["percent", { capital: "freeCashFlow" }, { metric: "revenue" }],
];
/**
 * Derived figures the writer may cite: flows over the quarter and the four quarters, instants at the report and the
 * quarter before. Cash runway is left out: it is a count of months, which the ledger has no way to write.
 */
const DERIVED_FLOWS: DerivedMetric[] = ["ebitda", "nopat", "nonCashCharges", "workingCapitalChange", "interestExpense", "netExternalFunding"];
const DERIVED_INSTANTS: DerivedMetric[] = ["netDebt", "investedCapital", "debtDueCoverage"];
const DERIVED_YEARLY: Array<[RatioForm, DerivedMetric]> = [["percent", "accruals"], ["percent", "incrementalReturn"]];

/** Up to two decimals under ten, one under a hundred (none for millions), trailing zeros dropped: "1.23", "55.7", "638.2", "350". */
const figure = (x: number, million: boolean) => String(Number(x.toFixed(x < 10 ? 2 : x < 100 || !million ? 1 : 0)));
/** "$55.7 billion", "$1.23 trillion", "$350 million", "-$23.7 billion"; another currency follows the amount: "4.2 billion EUR". */
function money(value: number, currency: string | null): string {
  const abs = Math.abs(value), sign = value < 0 ? "-" : "";
  const [scale, word] = abs >= 1e12 ? [1e12, "trillion"] : abs >= 1e9 ? [1e9, "billion"] : [1e6, "million"];
  const amount = `${figure(abs / scale, word === "million")} ${word}`;
  return currency && currency !== "USD" ? `${sign}${amount} ${currency}` : `${sign}$${amount}`;
}
const signed = (text: string, value: number) => `${value > 0 ? "+" : ""}${text}`;
function formatValue(r: ResolvedEvidence["current"], form: RatioForm = "multiple"): string {
  if (r.range && r.range.low !== r.range.high) return r.unit === "USD" ? `${money(r.range.low, r.currency)} to ${money(r.range.high, r.currency)}` : `${r.range.low}% to ${r.range.high}%`;
  if (r.unit === "USD") return money(r.value, r.currency);
  if (r.unit === "percent") return `${Number(r.value.toFixed(1))}%`;
  if (r.unit === "per_share") return `$${r.value.toFixed(2)}`;
  // A margin or an intensity reads as a percentage; a coverage or turnover ratio reads as a multiple.
  return form === "percent" ? `${Number((r.value * 100).toFixed(1))}%` : `${Number(r.value.toFixed(2))}x`;
}
/** A margin moves in percentage points ("+1.5 pp"), a multiple in turns ("+0.25x"), an amount in percent ("+12.3%"). */
const change = (r: ResolvedEvidence | null, form: RatioForm = "multiple") => !r || r.delta == null ? null
  : r.current.unit === "percent" ? signed(`${r.delta.toFixed(1)} pp`, r.delta)
  : r.current.unit === "ratio" ? (form === "percent" ? signed(`${(r.delta * 100).toFixed(1)} pp`, r.delta) : signed(`${r.delta.toFixed(2)}x`, r.delta))
  : signed(`${r.delta.toFixed(1)}%`, r.delta);

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
    rows.push({ ref, periodEnd: plain.current.periodEnd, span, label: plain.label, value: formatValue(plain.current, form), yoy: change(yoy, form), qoq: change(qoq, form) });
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
    const instant = (CAPITAL_INSTANTS as readonly CapitalMetric[]).includes(capital);
    // Instants have no span; flows are shown as the quarter and the fiscal year.
    if (instant) for (const end of quarterEnds.slice(0, 2)) push({ capital }, end, "quarter");
    else series({ capital });
  }
  for (const key of ["diluted_eps", "free_cash_flow", "stock_based_compensation", "depreciation_and_amortization", "cash_and_cash_equivalents", "long_term_debt"] as const) series({ fundamental: key }, ["quarter"]);
  for (const derived of DERIVED_FLOWS) series({ derived });
  for (const derived of DERIVED_INSTANTS) for (const end of quarterEnds.slice(0, 2)) push({ derived }, end, "quarter");
  for (const [form, derived] of DERIVED_YEARLY) series({ derived }, ["fiscal_year"], form);
  // Tagged schedules at the report: each rung of the debt, lease and purchase-obligation ladders, and their totals.
  for (const kind of ["debtMaturities", "leasePaymentsDue", "purchaseObligations"] as const) { for (const bucket of [0, 1, 2, 3, 4, 5, "total"] as const) push({ schedule: { kind, bucket } }, periodEnd, "quarter"); }
  if (rows.some(r => "nodeId" in r.ref && r.ref.nodeId === nodes[0]?.nodeId) && rows.some(r => "capital" in r.ref && r.ref.capital === "capex")) {
    for (const node of nodes.filter(n => !n.parentId).slice(0, 4)) push({ ratio: { numerator: { nodeId: node.nodeId }, denominator: { capital: "capex" } } }, periodEnd, "fiscal_year");
  }
  const guidance = (data.guidance?.items ?? []).filter(i => !i.periodEnd || i.periodEnd >= shiftPeriod(periodEnd, -12)).slice(0, 40)
    .map(i => ({ guidanceId: i.id, text: i.text, periodEnd: i.periodEnd, horizon: i.horizon }));
  const assessment = assessStatements(data, periodEnd);
  const flags: LedgerFlag[] = assessment.flags.map(f => {
    const def = METRIC_DEFS.get(f.metricId)!;
    return { rule: f.ruleId, level: f.level, metric: def.label[0], value: formatMetric(f.value, def.form), threshold: f.threshold, since: f.since, ref: def.ref, span: def.span };
  });
  return { periodEnd, rows: rows.slice(0, 760), nodes, guidance, sources, flags };
}

/**
 * The newest quarter against the five before it, one row per figure, grouped by the statement view it belongs to: what
 * a highlights writer reads to tell which figures broke from their trend. Values are written as the ledger writes them;
 * the change columns are the newest quarter's.
 */
export type HighlightRow = { ref: FindingRef; view: FindingView; label: string; quarters: Array<{ periodEnd: string; value: string }>; yoy: string | null; qoq: string | null };
const HIGHLIGHT_QUARTERS = 6;

export function buildHighlightTable(data: FindingData, periodEnd: string): HighlightRow[] {
  const ends = Array.from({ length: HIGHLIGHT_QUARTERS }, (_, i) => shiftPeriod(periodEnd, -3 * (HIGHLIGHT_QUARTERS - 1 - i)));
  const rows: HighlightRow[] = [];
  const add = (ref: FindingRef) => {
    const view = refView(ref);
    if (!view) return;
    const form = ratioForm(ref);
    const yoy = resolveEvidence(data, { ref, periodEnd, span: "quarter", compare: "yoy" });
    const qoq = resolveEvidence(data, { ref, periodEnd, span: "quarter", compare: "qoq" });
    const quarters = ends.flatMap(end => { const r = resolveEvidence(data, { ref, periodEnd: end, span: "quarter" }); return r ? [{ periodEnd: r.current.periodEnd, value: formatValue(r.current, form) }] : []; });
    // Only figures the newest report discloses can lead it.
    const newest = quarters.at(-1);
    if (!newest || Math.abs(Date.parse(newest.periodEnd) - Date.parse(periodEnd)) > 20 * 86_400_000) return;
    rows.push({ ref, view, label: (yoy ?? qoq)?.label ?? refLabel(data, ref), quarters, yoy: change(yoy, form), qoq: change(qoq, form) });
  };
  const newest = data.quarters.find(q => q.periodEnd === periodEnd) ?? [...data.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  for (const metric of FLOW) add({ metric });
  for (const node of ledgerNodes(newest).slice(0, 12)) add({ nodeId: node.nodeId });
  for (const [, numerator, denominator] of RATIOS) add({ ratio: { numerator, denominator } });
  for (const capital of CAPITAL_METRICS as readonly CapitalMetric[]) add({ capital });
  for (const key of ["diluted_eps", "stock_based_compensation", "depreciation_and_amortization", "accounts_receivable", "inventory"] as const) add({ fundamental: key });
  return rows;
}
