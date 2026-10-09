import type { BusinessFlowQuarter } from "@/shared/analysis-contract/business-flow";
import type { GuidanceItem, GuidancePublication, GuidanceSource } from "@/shared/analysis-contract/guidance";
import { ACTION_NAMES, guidanceLabel, segmentMatches } from "./trend-model";

/**
 * Management guidance on the Sankey itself. A bracket beside a bar is the range guided for this quarter, at the
 * bar's scale, so where the bar ends against it reads as 高于 / 落在 / 低于. A pill is what the latest report guides
 * for the next quarter on that line. Only nodes the statement draws take marks: company revenue, a business whose
 * filing name the guidance uses, and operating profit (gross and operating margins as pills only, since a rate
 * has no height on the bar). Constant-currency variants and lines the chart does not draw stay in the trend panel.
 */
export type GuideVerdict = "above" | "within" | "below";
export type GuideBracket = { node: string; low: number; high: number; derived: boolean; verdict: GuideVerdict; item: GuidanceItem; source: GuidanceSource | null };
export type GuidePill = { node: string; text: string; action: GuidanceItem["action"]; item: GuidanceItem; source: GuidanceSource | null };
export type GuidanceMarks = { brackets: GuideBracket[]; pills: GuidePill[] };

const DAY = 86_400_000;
const EMPTY: GuidanceMarks = { brackets: [], pills: [] };
const BASIS_RANK: Record<GuidanceItem["basis"], number> = { gaap: 0, non_gaap: 1, unspecified: 2, constant_currency: 9 };

/** The node a guidance item speaks about, or null when the statement does not draw that line. */
export function nodeForGuidance(item: GuidanceItem, nodes: Set<string>, businessIdOf: (node: string) => string | null): string | null {
  if (item.basis === "constant_currency") return null;
  if (item.metric === "revenue" && !item.segment) return nodes.has("revenue") ? "revenue" : null;
  if (item.metric === "segment_revenue") { for (const n of nodes) { const id = businessIdOf(n); if (id && segmentMatches(item, id)) return n; } return null; }
  if (item.metric === "operating_income" || item.metric === "operating_margin") return nodes.has("operating") ? "operating" : null;
  if (item.metric === "gross_margin") return nodes.has("gross") ? "gross" : null;
  return null;
}

/** A guided amount in dollars: stated as USD, or derived from stated growth. A rate has no amount. */
function dollarRange(item: GuidanceItem): { low: number; high: number; derived: boolean } | null {
  if (item.unit === "USD" && item.low != null && item.high != null) return { low: item.low, high: item.high, derived: false };
  if (item.derived) return { low: item.derived.low, high: item.derived.high, derived: true };
  return null;
}

/** "+30–34%" / "$17.9B–$18.1B" / "≥ $90.0B" / "预计上行": the pill's own words, the full sentence stays in the tooltip. */
export function pillText(item: GuidanceItem, money: (dollars: number) => string): string {
  if (item.form === "qualitative") return item.direction === "up" ? "预计上行" : item.direction === "down" ? "预计下行" : "预计持平";
  const num = (v: number) => item.unit === "USD" ? money(v) : item.unit === "USD_per_share" ? `$${v.toFixed(2)}` : `${Number(v.toFixed(1))}`;
  const unit = item.unit === "percent" ? "%" : "";
  const sign = item.measure === "growth" ? "+" : "";
  if (item.form === "floor" && item.low != null) return `≥ ${sign}${num(item.low)}${unit}`;
  if (item.form === "ceiling" && item.high != null) return `≤ ${sign}${num(item.high)}${unit}`;
  const only = item.low ?? item.high;
  if (item.low == null || item.high == null) return only == null ? "" : `${sign}${num(only)}${unit}`;
  return item.low === item.high ? `${sign}${num(item.low)}${unit}` : `${sign}${num(item.low)}–${num(item.high)}${unit}`;
}

export const ACTION_GLYPH: Record<NonNullable<GuidanceItem["action"]>, string> = { raised: "↑", lowered: "↓", reaffirmed: "=", narrowed: "↔", widened: "↔", updated: "·", initiated: "" };

export function guidanceMarks(quarter: BusinessFlowQuarter, nodeNames: Iterable<string>, guidance: GuidancePublication | null, options: {
  /** The amount the bar draws for a node, in the quarter's units (its `scale`). */
  amountOf: (node: string) => number | null;
  businessIdOf: (node: string) => string | null;
  money: (dollars: number) => string;
}): GuidanceMarks {
  if (!guidance || quarter.currency !== "USD") return EMPTY;
  const nodes = new Set(nodeNames);
  const end = Date.parse(quarter.periodEnd);
  const latestFirst = [...guidance.items].filter(i => i.horizon === "quarter" && i.periodEnd)
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt) || BASIS_RANK[a.basis] - BASIS_RANK[b.basis]);
  const source = (item: GuidanceItem) => guidance.sources.find(s => s.id === item.sourceIds[0]) ?? null;
  const brackets = new Map<string, GuideBracket>(), pills = new Map<string, GuidePill>();
  for (const item of latestFirst) {
    const node = nodeForGuidance(item, nodes, options.businessIdOf);
    if (!node) continue;
    const gap = Date.parse(item.periodEnd!) - end;
    if (Math.abs(gap) <= 20 * DAY) {
      // Guided for this quarter: the last range given before the report, read against the bar.
      if (brackets.has(node)) continue;
      const range = dollarRange(item), amount = options.amountOf(node);
      if (!range || amount == null || !Number.isFinite(amount)) continue;
      const dollars = amount * quarter.scale;
      const verdict: GuideVerdict = dollars > range.high ? "above" : dollars < range.low ? "below" : "within";
      brackets.set(node, { node, low: range.low, high: range.high, derived: range.derived, verdict, item, source: source(item) });
    } else if (gap > 20 * DAY && gap < 120 * DAY) {
      // Guided for the next quarter, by the latest event only.
      if (pills.has(node) || item.issuedAt !== latestFirst[0].issuedAt) continue;
      const text = pillText(item, options.money);
      if (!text) continue;
      pills.set(node, { node, text, action: item.action, item, source: source(item) });
    }
  }
  return { brackets: [...brackets.values()], pills: [...pills.values()] };
}

/** The sentence under a mark, in the trend panel's wording. */
export const markSentence = (item: GuidanceItem, money: (v: number | null) => string) => guidanceLabel(item, money);
export const actionName = (action: GuidanceItem["action"]) => action ? ACTION_NAMES[action] : "";
