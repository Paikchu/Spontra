import type { FlowMetric } from "@/shared/analysis-contract/business-flow";
import type { CapitalMetric, DerivedMetric, FindingBaseRef, FindingRef, FindingView, FindingsPublication } from "@/shared/analysis-contract/findings";
import { resolveEvidence, type FindingData, type ResolvedEvidence } from "@/shared/analysis-runtime/findings";
import { HIGHLIGHT_COUNT, MIN_HIGHLIGHTS, higherIsBetter, ratioForm, verifyHighlights, type VerifiedHighlight } from "@/shared/analysis-runtime/highlights";
import type { Locale } from "@/shared/analysis-runtime/locale";

/**
 * The stage's headline tiles read as news, good or bad. A figure moves the right way or the wrong way for its owner:
 * revenue, profit, margins and cash up are good; costs, expenses, debt and cost intensity down are good. The model's
 * picks lead; when none of them is bad news while the quarter carries some, the most material adverse move takes the
 * last tile, so the row never reads as a list of wins only. Everything here is read from the data the page draws.
 */

export type HeroTone = "good" | "bad";

const LOWER_METRICS: FlowMetric[] = ["cost", "research", "sales", "administration", "operatingExpenses"];
const LOWER_CAPITAL: CapitalMetric[] = ["debt"];
const LOWER_DERIVED: DerivedMetric[] = ["netDebt", "interestExpense", "stockCompensationExpense"];
const LOWER_FUNDAMENTALS = ["research_and_development", "long_term_debt", "stock_based_compensation"];
const lowerBase = (ref: FindingBaseRef) => "metric" in ref && LOWER_METRICS.includes(ref.metric) || "capital" in ref && LOWER_CAPITAL.includes(ref.capital)
  || "derived" in ref && LOWER_DERIVED.includes(ref.derived) || "fundamental" in ref && LOWER_FUNDAMENTALS.includes(ref.fundamental);

/** Which way the figure moves to be good news: up, down, or neither (capex, financing, assets read neither way). */
export function goodWhen(ref: FindingRef): "up" | "down" | null {
  if (higherIsBetter(ref)) return "up";
  if (!("ratio" in ref)) return lowerBase(ref) ? "down" : null;
  const { numerator, denominator } = ref.ratio;
  if (!lowerBase(numerator)) return null;
  // A cost per dollar of revenue, and leverage against equity or earnings, read better lower.
  return "metric" in denominator && denominator.metric === "revenue" || "capital" in denominator && denominator.capital === "equity" || "derived" in denominator && denominator.derived === "ebitda" ? "down" : null;
}

/** The change as the tile writes it, in its own unit; zero when it rounds away. A sign change of an amount moves by its difference. */
function move(r: ResolvedEvidence): number {
  if (!r.compare) return 0;
  if (r.delta == null) return r.current.unit === "USD" ? Math.sign(r.current.value - r.compare.value) : 0;
  const shown = r.current.unit === "ratio" && ratioForm(r.evidence.ref) === "percent" ? r.delta * 100 : r.delta;
  return Math.abs(shown) < (r.current.unit === "ratio" && ratioForm(r.evidence.ref) === "multiple" ? 0.005 : 0.05) ? 0 : shown;
}

/**
 * Good or bad news by the figure's direction; none for a figure that reads neither way or did not move. A level with
 * no comparison is bad news only below zero where higher is better: a loss, cash burned.
 */
export function heroTone(ref: FindingRef, r: ResolvedEvidence): HeroTone | undefined {
  const good = goodWhen(ref);
  if (good === "up" && !r.compare && r.current.unit === "USD" && r.current.value < 0) return "bad";
  const shift = move(r);
  if (!good || !shift) return undefined;
  return (shift > 0) === (good === "up") ? "good" : "bad";
}

/** How notable a move is, against a 5% change of an amount, a point of a rate, a tenth of a multiple's level; a sign change always is. */
function weight(r: ResolvedEvidence): number {
  const shift = Math.abs(move(r));
  if (!shift || !r.compare) return 0;
  if (r.current.unit === "USD") return r.delta == null ? Infinity : shift / 5;
  if (r.current.unit === "ratio" && ratioForm(r.evidence.ref) === "multiple") return shift / Math.max(Math.abs(r.compare.value), 1e-9) / 0.1;
  return shift;
}

const ratio = (numerator: FindingBaseRef, denominator: FindingBaseRef): FindingRef => ({ ratio: { numerator, denominator } });
const REVENUE: FindingBaseRef = { metric: "revenue" };
/** The figures every company's view is checked for an adverse move, besides the model's picks. */
const WATCH: Record<FindingView, FindingRef[]> = {
  profit: [REVENUE, { metric: "gross" }, { metric: "operating" }, { metric: "net" }, ratio({ metric: "gross" }, REVENUE), ratio({ metric: "operating" }, REVENUE), ratio({ metric: "net" }, REVENUE), ratio({ metric: "operatingExpenses" }, REVENUE)],
  cash: [{ capital: "operatingCashFlow" }, { capital: "freeCashFlow" }],
  balance: [{ capital: "cash" }, { capital: "equity" }, { capital: "debt" }, { capital: "rpo" }],
};

export type HeroTile = VerifiedHighlight & { tone?: HeroTone };

const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 20 * 86_400_000;

/**
 * The tiles a view shows for a report, toned good or bad; null when too few of the model's picks verify and the view
 * keeps its fixed tiles. With no bad news among the picks, the worst material adverse move (5% on an amount, a point
 * on a margin) replaces the last pick, or joins as the third tile when only two verified.
 */
export function heroTiles(publication: FindingsPublication | null, data: FindingData, periodEnd: string, view: FindingView, locale: Locale = "en"): HeroTile[] | null {
  const report = publication?.highlights?.find(h => near(h.periodEnd, periodEnd));
  if (!report) return null;
  const picked = verifyHighlights(report, data, locale).verified[view];
  if (picked.length < MIN_HIGHLIGHTS) return null;
  const toned = (t: VerifiedHighlight): HeroTile => ({ ...t, tone: heroTone(t.ref, t.resolved) });
  const tiles = picked.slice(0, HIGHLIGHT_COUNT).map(toned);
  if (tiles.some(t => t.tone === "bad")) return tiles;
  const shown = new Set(tiles.map(t => JSON.stringify(t.ref)));
  const basis = tiles[0]?.compare ?? "yoy";
  const resolve = (ref: FindingRef) => [basis, basis === "yoy" ? "qoq" : "yoy"].map(compare => resolveEvidence(data, { ref, periodEnd: report.periodEnd, span: "quarter", compare: compare as "yoy" | "qoq" }, locale)).find(r => r != null) ?? null;
  const candidates: HeroTile[] = [
    ...picked.slice(HIGHLIGHT_COUNT).map(toned),
    ...WATCH[view].filter(ref => !shown.has(JSON.stringify(ref))).flatMap((ref): HeroTile[] => {
      const r = resolve(ref);
      // The large number is the move itself, named by the figure: "Net income · YoY −12.3%"; a sign change shows the figure.
      return r?.compare ? [{ title: r.label, ref, compare: r.evidence.compare as "yoy" | "qoq", show: r.delta != null ? "change" : "value", resolved: r, tone: heroTone(ref, r) }] : [];
    }),
  ].filter(t => t.tone === "bad" && weight(t.resolved) >= 1 && !shown.has(JSON.stringify(t.ref)));
  const worst = candidates.sort((a, b) => weight(b.resolved) - weight(a.resolved))[0];
  if (!worst) return tiles;
  return tiles.length < HIGHLIGHT_COUNT ? [...tiles, worst] : [...tiles.slice(0, -1), worst];
}
