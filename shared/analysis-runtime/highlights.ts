import { FUNDAMENTAL_METRIC_CATALOG } from "../analysis-contract/fundamental-metric-catalog.ts";
import type { FlowMetric } from "../analysis-contract/business-flow.ts";
import type { CapitalMetric, FindingBaseRef, FindingRef, FindingView, FindingsPublication, ReportHighlights, StatementHighlight } from "../analysis-contract/findings.ts";
import { proseNumbers, resolveEvidence, type FindingData, type ResolvedEvidence } from "./findings.ts";

/**
 * Headline figures per statement view. The model picks which figures lead each view and names the change; every
 * number on the tile is resolved here from the data the page draws, and a tile that does not resolve is not shown.
 */

export const HIGHLIGHT_VIEWS = ["profit", "cash", "balance"] as const satisfies readonly FindingView[];
/** Tiles per view the writer is asked for; a view with fewer than `MIN_HIGHLIGHTS` verified keeps its fixed tiles. */
export const HIGHLIGHT_COUNT = 3, MIN_HIGHLIGHTS = 2;

const CASH_FLOWS: CapitalMetric[] = ["operatingCashFlow", "capex", "freeCashFlow", "financing", "debtIssued", "debtRepaid", "equityIssued", "buybacks", "dividends"];
const FUNDAMENTAL_VIEW: Record<string, FindingView> = { income_statement: "profit", per_share: "profit", cash_flow: "cash", balance_sheet: "balance" };

/** The statement a figure belongs to; a ratio belongs to its numerator's. Guidance belongs to none. */
export function refView(ref: FindingRef): FindingView | null {
  if ("ratio" in ref) return "guidanceId" in ref.ratio.denominator ? null : refView(ref.ratio.numerator);
  if ("metric" in ref || "nodeId" in ref) return "profit";
  if ("capital" in ref) return CASH_FLOWS.includes(ref.capital) ? "cash" : "balance";
  if ("fundamental" in ref) return FUNDAMENTAL_VIEW[(FUNDAMENTAL_METRIC_CATALOG as Record<string, { category: string }>)[ref.fundamental]?.category ?? ""] ?? null;
  return null;
}

/** A margin or an intensity reads as a percentage; coverage, leverage and backlog multiples read as "2.6x". */
export function ratioForm(ref: FindingRef): "percent" | "multiple" {
  if (!("ratio" in ref)) return "multiple";
  const { numerator, denominator } = ref.ratio;
  return "metric" in denominator && (denominator.metric === "revenue" || denominator.metric === "pretax") && !("capital" in numerator && numerator.capital === "rpo") ? "percent" : "multiple";
}

const HIGHER_METRICS: FlowMetric[] = ["revenue", "gross", "operating", "pretax", "net"];
const HIGHER_CAPITAL: CapitalMetric[] = ["operatingCashFlow", "freeCashFlow", "cash", "equity", "rpo", "rpoNext12MonthsShare"];
const higherBase = (ref: FindingBaseRef) => "nodeId" in ref || "metric" in ref && HIGHER_METRICS.includes(ref.metric) || "capital" in ref && HIGHER_CAPITAL.includes(ref.capital)
  || "fundamental" in ref && ["total_revenue", "gross_profit", "operating_income", "net_income", "diluted_eps", "operating_cash_flow", "free_cash_flow", "cash_and_cash_equivalents", "stockholders_equity", "remaining_performance_obligation"].includes(ref.fundamental);
/** Figures whose rise reads as good news without a judgment: revenue, profit, margins, cash generated, cash held. Costs, capex and debt read neither way. */
export function higherIsBetter(ref: FindingRef): boolean {
  if (!("ratio" in ref)) return higherBase(ref);
  const { numerator, denominator } = ref.ratio;
  if ("metric" in denominator && denominator.metric === "revenue") return "metric" in numerator && ["gross", "operating", "net"].includes(numerator.metric) || "capital" in numerator && numerator.capital === "rpo";
  return "capital" in numerator && (numerator.capital === "operatingCashFlow" && "metric" in denominator && denominator.metric === "net" || numerator.capital === "cash" && "capital" in denominator && denominator.capital === "debt");
}

/** The change as the tile's note writes it: "+12.3%" for an amount, "+1.5 pp" for a rate or a margin, "+0.25x" for a multiple. */
export function highlightChange(r: ResolvedEvidence): string | null {
  if (r.delta == null) return null;
  const sign = r.delta > 0 ? "+" : r.delta < 0 ? "−" : "", abs = Math.abs(r.delta);
  if (r.current.unit === "percent") return `${sign}${abs.toFixed(1)} pp`;
  if (r.current.unit === "ratio") return ratioForm(r.evidence.ref) === "percent" ? `${sign}${(abs * 100).toFixed(1)} pp` : `${sign}${abs.toFixed(2)}x`;
  return `${sign}${abs.toFixed(abs >= 100 ? 0 : 1)}%`;
}

export type VerifiedHighlight = StatementHighlight & { resolved: ResolvedEvidence };
export type VerifiedReportHighlights = { periodEnd: string } & Record<FindingView, VerifiedHighlight[]>;
export type WithheldHighlight = { view: FindingView; index: number; reasons: string[] };

/**
 * Keeps the tiles the data can stand behind: the figure belongs to the view, resolves at the report's quarter (with
 * its comparison when one is asked for), is not repeated within the view, and the title states no number.
 */
export function verifyHighlights(highlights: ReportHighlights, data: FindingData): { verified: VerifiedReportHighlights; withheld: WithheldHighlight[] } {
  const verified: VerifiedReportHighlights = { periodEnd: highlights.periodEnd, profit: [], cash: [], balance: [] };
  const withheld: WithheldHighlight[] = [];
  for (const view of HIGHLIGHT_VIEWS) {
    const seen = new Set<string>();
    highlights[view].forEach((h, index) => {
      const reasons: string[] = [];
      const key = JSON.stringify(h.ref);
      if (refView(h.ref) !== view) reasons.push(`figure is not on the ${view} view`);
      if (seen.has(key)) reasons.push("figure repeated");
      if (proseNumbers(h.title).length) reasons.push("title states a number");
      const resolved = resolveEvidence(data, { ref: h.ref, periodEnd: highlights.periodEnd, span: "quarter", ...(h.compare ? { compare: h.compare } : {}) });
      if (!resolved) reasons.push(h.compare ? `figure or its ${h.compare} comparison unresolved` : "figure unresolved");
      seen.add(key);
      if (reasons.length || !resolved) withheld.push({ view, index, reasons });
      else verified[view].push({ ...h, resolved });
    });
  }
  return { verified, withheld };
}

const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 20 * 86_400_000;

/** The verified tiles a view shows for a report, or null when too few survive and the view keeps its fixed tiles. */
export function highlightsFor(publication: FindingsPublication | null, data: FindingData, periodEnd: string, view: FindingView): VerifiedHighlight[] | null {
  const report = publication?.highlights?.find(h => near(h.periodEnd, periodEnd));
  if (!report) return null;
  const tiles = verifyHighlights(report, data).verified[view].slice(0, HIGHLIGHT_COUNT);
  return tiles.length >= MIN_HIGHLIGHTS ? tiles : null;
}
