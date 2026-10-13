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

const CASH_FLOWS: CapitalMetric[] = ["operatingCashFlow", "capex", "freeCashFlow", "financing", "debtIssued", "debtRepaid", "equityIssued", "buybacks", "dividends", "acquisitions", "investmentsNet", "leasePrincipal", "depreciation", "stockCompensation", "interestPaid", "taxesPaid", "unpaidCapex", "leaseAssetsObtained"];
const FUNDAMENTAL_VIEW: Record<string, FindingView> = { income_statement: "profit", per_share: "profit", cash_flow: "cash", balance_sheet: "balance" };

/** The statement a figure belongs to; a ratio belongs to its numerator's. Guidance belongs to none. */
export function refView(ref: FindingRef): FindingView | null {
  if ("ratio" in ref) return "guidanceId" in ref.ratio.denominator ? null : refView(ref.ratio.numerator);
  if ("metric" in ref || "nodeId" in ref) return "profit";
  if ("capital" in ref) return CASH_FLOWS.includes(ref.capital) ? "cash" : "balance";
  if ("fundamental" in ref) return FUNDAMENTAL_VIEW[(FUNDAMENTAL_METRIC_CATALOG as Record<string, { category: string }>)[ref.fundamental]?.category ?? ""] ?? null;
  if ("peer" in ref) return refView(ref.peer.ref);
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

/** A change as a tile writes it: "+12.3%" for an amount, "+1.5 pp" for a rate or a margin, "+0.25×" for a multiple. */
export function formatChange(delta: number, r: ResolvedEvidence): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "", abs = Math.abs(delta);
  if (r.current.unit === "percent") return `${sign}${abs.toFixed(1)} pp`;
  if (r.current.unit === "ratio") return ratioForm(r.evidence.ref) === "percent" ? `${sign}${(abs * 100).toFixed(1)} pp` : `${sign}${abs.toFixed(2)}×`;
  return `${sign}${abs.toFixed(abs >= 100 ? 0 : 1)}%`;
}
export const highlightChange = (r: ResolvedEvidence): string | null => r.delta == null ? null : formatChange(r.delta, r);

/**
 * Words that dramatise a movement or praise it instead of naming the figure. The tile's number and its change carry
 * the news, so a title using one falls back to the figure's plain name.
 */
const EMPHASIS = new RegExp(String.raw`\b(?:(?:climb|jump|surge|soar|skyrocket|rocket|leap|vault|spike|balloon|swell|explode|boom|plunge|plummet|tumble|slump|sink|crater|tank|collapse|rise|fall|grow|accelerate|decelerate|outrun|outpace|eclipse|stay|remain|hold|keep|continue|turn|hit|reach|top|pass)(?:s|es|d|ed|ing)?|slip(?:s|ped|ping)?|slide[sd]?|sliding|dip(?:s|ped|ping)?|rose|risen|rising|fell|fallen|grew|grown|accelerating|decelerating|sank|sunk|leapt|strong|stronger|robust|stellar|impressive|massive|huge|dramatic|remarkable|record|sharp|sharply|steep|solid|healthy|blowout|unprecedented|soaring|booming)\b`, "i");

/** The figure's own name, and "growth" or "change" when the large number is its change. */
export function plainTitle(r: ResolvedEvidence, show: StatementHighlight["show"]): string {
  if (show !== "change") return r.label.slice(0, 40);
  return `${r.label} ${r.current.unit === "USD" ? "growth" : "change"}`.slice(0, 40);
}

export type VerifiedHighlight = StatementHighlight & { resolved: ResolvedEvidence };
export type VerifiedReportHighlights = { periodEnd: string } & Record<FindingView, VerifiedHighlight[]>;
export type WithheldHighlight = { view: FindingView; index: number; reasons: string[] };

/**
 * Keeps the tiles the data can stand behind: the figure belongs to the view, resolves at the report's quarter (with
 * its comparison when one is asked for, and a measurable change when the change is the large number), and is not
 * repeated within the view. A title that states a number or dramatises the move is replaced by the figure's plain name.
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
      const resolved = resolveEvidence(data, { ref: h.ref, periodEnd: highlights.periodEnd, span: "quarter", ...(h.compare ? { compare: h.compare } : {}) });
      if (!resolved) reasons.push(h.compare ? `figure or its ${h.compare} comparison unresolved` : "figure unresolved");
      if (h.show === "change" && resolved && resolved.delta == null) reasons.push("change shown without a measurable change");
      seen.add(key);
      if (reasons.length || !resolved) withheld.push({ view, index, reasons });
      else {
        // A multiple (debt to equity, capex to depreciation) reads by its level; its change in turns says little on its own.
        const multiple = h.show === "change" && resolved.current.unit === "ratio" && ratioForm(h.ref) === "multiple";
        const show = multiple ? "value" : h.show, named = multiple ? h.title.replace(/\s+(?:change|growth)$/i, "") : h.title;
        verified[view].push({ ...h, ...(show ? { show } : {}), title: proseNumbers(named).length || EMPHASIS.test(named) ? plainTitle(resolved, show) : named, resolved });
      }
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
