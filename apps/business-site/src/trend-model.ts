import type { RevenueHistory, RevenueHistoryNode, RevenueHistoryQuarter } from "@/shared/analysis-contract/revenue-history";
import { messages } from "@/packages/web/src/i18n";
import { sameBasis, segmentBasis } from "@/shared/analysis-runtime/segment-basis";

const m = messages({
  totalRevenue: "Total company revenue", revenueChange: "Revenue change",
}, {
  totalRevenue: "公司总营收", revenueChange: "营收变化",
});

export type TrendItem = { key: string; id: string; parent: string | null; name: string; slot: number };
export type Slot = { periodEnd: string; quarter: RevenueHistoryQuarter | null; missingReason?: "currency" };
/** A stacked piece of one column. Every column renders every layer key, so switching focus morphs heights instead of remounting. */
export type Layer = { key: string; value: number; tone: "root" | "child" | "total"; slot: number; shade: number; name: string };
export type Column = { slot: Slot; layers: Layer[]; total: number | null; state: "ok" | "missing" | "basis";
  /** The segment basis of the quarter against the latest split one: the same, an earlier one (re-segmented since), or none (total only). */
  segmentBasis?: "current" | "earlier" | null };

/** Most quarters shown as bars; companies with a shorter disclosure history show fewer. */
export const SLOTS = 5;
/** Names compare without case, spacing or punctuation, and "&" reads as "and", so "Compute & Networking" matches "Compute and Networking". */
const norm = (name: string) => name.toLowerCase().replace(/&/g, "and").replace(/[^\p{L}\p{N}]/gu, "");

export const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
export const monthEnd = (index: number) => new Date(Date.UTC(Math.floor(index / 12), index % 12 + 1, 0)).toISOString().slice(0, 10);

/** Use base currency units for all actuals; never compare different currencies without an exchange-rate basis. */
function unscaledQuarter(quarter: RevenueHistoryQuarter): RevenueHistoryQuarter {
  const amount = <T extends { value: string }>(item: T): T => ({ ...item, value: String(Number(item.value) * quarter.scale) });
  return {
    ...quarter, scale: 1, revenue: String(Number(quarter.revenue) * quarter.scale),
    segments: quarter.segments.map(segment => ({ ...amount(segment), ...(segment.children ? { children: segment.children.map(amount) } : {}) })),
    ...(quarter.revenueAdjustments ? { revenueAdjustments: quarter.revenueAdjustments.map(amount) } : {}),
  };
}

/** Consecutive quarterly slots ending at the newest period; extra slots supply growth baselines without adding visible bars. */
export function buildSlots(history: RevenueHistory, count = SLOTS): Slot[] {
  const quarters = [...history.quarters].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const latest = quarters.at(-1);
  if (!latest) return [];
  const top = monthIndex(latest.periodEnd);
  return Array.from({ length: count }, (_, i) => {
    const target = top - 3 * (count - 1 - i);
    const match = quarters.find(q => Math.abs(monthIndex(q.periodEnd) - target) <= 1) ?? null;
    const differentCurrency = match && match.currency !== latest.currency;
    return { periodEnd: match?.periodEnd ?? monthEnd(target), quarter: match && !differentCurrency ? unscaledQuarter(match) : null,
      ...(differentCurrency ? { missingReason: "currency" as const } : {}) };
  });
}

/** Visible bar count: from the first disclosed quarter to the latest, at most `max`, so a recent listing gets no leading empty bars. */
export function visibleSlotCount(slots: Slot[], max = SLOTS) {
  const first = slots.findIndex(slot => slot.quarter != null || slot.missingReason != null);
  return first < 0 ? 0 : Math.min(max, slots.length - first);
}

/** Same disclosure id first; otherwise the same disclosed business name (filings rename members across presentations). */
function findNode<T extends { id: string; name: string }>(nodes: T[] | undefined, item: { id: string; name: string }) {
  return nodes?.find(n => n.id === item.id) ?? nodes?.find(n => norm(n.name) === norm(item.name));
}

export function matchItem(q: RevenueHistoryQuarter, item: TrendItem, items: TrendItem[]): number | null {
  const parent = items.find(i => i.key === item.parent);
  const parentNode = parent ? findNode<RevenueHistoryNode>(q.segments, parent) : undefined;
  const node = item.parent
    ? findNode(parentNode?.children, item)
    : findNode(q.segments, item);
  if (node) return Number(node.value);
  // A disclosed concept may move between parent categories across presentations.
  // Recover only a unique exact id, never infer a new total from differently named businesses.
  const matches = q.segments.flatMap(segment => [segment, ...(segment.children ?? [])]).filter(node => node.id === item.id);
  return matches.length === 1 ? Number(matches[0].value) : null;
}

/** All layer keys in stable stacking order: each root followed by its children, then the whole-company fallback. */
export function layerOrder(items: TrendItem[], columns: Column[] = []) {
  return [...new Set([...items.filter(i => !i.parent).flatMap(root => [root.key, ...items.filter(i => i.parent === root.key).map(c => c.key)]),
    ...columns.flatMap(column => column.layers.map(layer => layer.key)).filter(key => key !== "__total"), "__total"])];
}

export function buildColumns(slots: Slot[], items: TrendItem[], selected: TrendItem | null): Column[] {
  const latestSplit = [...slots].reverse().find(slot => slot.quarter && segmentBasis(slot.quarter.segments) != null)?.quarter ?? null;
  const basisOf = (slot: Slot): Column["segmentBasis"] => !slot.quarter || !latestSplit || segmentBasis(slot.quarter.segments) == null ? null
    : sameBasis(slot.quarter.segments, latestSplit.segments) ? "current" : "earlier";
  return columnsFor(slots, items, selected).map(column => ({ ...column, segmentBasis: basisOf(column.slot) }));
}

function columnsFor(slots: Slot[], items: TrendItem[], selected: TrendItem | null): Column[] {
  const roots = items.filter(i => !i.parent);
  return slots.map(slot => {
    const q = slot.quarter;
    if (!q) return { slot, layers: [], total: null, state: "missing" };
    const revenue = Number(q.revenue);
    if (!selected) {
      const values = roots.map(root => matchItem(q, root, items));
      // Matching the current presentation enables the current legend, never a fabricated historical split.
      if (roots.length && values.every(v => v != null) && Math.abs(values.reduce((s, v) => s + v!, 0) - revenue) <= Math.max(1, revenue * 1e-6))
        return { slot, total: revenue, state: "ok", layers: roots.map((root, i) => ({ key: root.key, value: values[i]!, tone: "root", slot: root.slot, shade: 0, name: root.name })) };
      const original = q.segments;
      if (original.length > 1 && original.every(node => Number.isFinite(Number(node.value)) && Number(node.value) >= 0)
        && Math.abs(original.reduce((sum, node) => sum + Number(node.value), 0) - revenue) <= Math.max(1, revenue * 1e-6)) {
        return { slot, total: revenue, state: "basis", layers: original.map((node, index) => {
          const matched = roots.find(root => root.id === node.id || norm(root.name) === norm(node.name));
          return { key: matched?.key ?? `disclosed:${node.id}`, value: Number(node.value), tone: "root", slot: matched?.slot ?? roots.length + index + 1,
            shade: 0, name: node.name };
        }) };
      }
      return { slot, total: revenue, state: "basis", layers: [{ key: "__total", value: revenue, tone: "total", slot: 0, shade: 0, name: m.totalRevenue }] };
    }
    const value = matchItem(q, selected, items);
    if (value == null) return { slot, layers: [], total: null, state: "basis" };
    const children = items.filter(i => i.parent === selected.key);
    const parts = children.map(child => matchItem(q, child, items));
    if (children.length && parts.every(v => v != null) && Math.abs(parts.reduce((s, v) => s + v!, 0) - value) <= Math.max(1, value * 1e-6))
      return { slot, total: value, state: "ok", layers: children.map((child, i) => ({ key: child.key, value: parts[i]!, tone: "child", slot: child.slot, shade: i, name: child.name })) };
    return { slot, total: value, state: "ok", layers: [{ key: selected.key, value, tone: selected.parent ? "child" : "root", slot: selected.slot, shade: 0, name: selected.name }] };
  });
}

/** Round axis ceiling with three even steps. */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0, 1, 2, 3];
  const raw = max / 3, power = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(m => m * power).find(s => s >= raw)!;
  return [0, step, step * 2, step * 3];
}

export function growth(current: number | null, before: number | null): number | null {
  return current != null && before != null && before > 0 ? (current / before - 1) * 100 : null;
}

/** One business's step in the bridge from the base period to the current one. */
export type BridgeStep = Layer & { base: number; delta: number; before: number; after: number };
export type Bridge = { base: Column; current: Column; lag: 1 | 4; change: number; percent: number | null; steps: BridgeStep[]; reason: "split" | "single" | "basis" };

/** Column of the quarter shown in the flow chart; the newest when it is not in the history. */
export function columnIndex(columns: Column[], periodEnd: string | null): number {
  const index = periodEnd ? columns.findIndex(c => c.slot.periodEnd === periodEnd) : -1;
  return index >= 0 ? index : columns.length - 1;
}

/**
 * Splits the change between two quarters by business. Only two columns stacked from the same businesses
 * are attributed; a renamed or regrouped presentation keeps the total change and says why there is no split.
 */
export function buildBridge(columns: Column[], index: number, lag: 1 | 4): Bridge | null {
  const current = columns[index], base = columns[index - lag];
  if (!current || !base || current.total == null || base.total == null) return null;
  const change = current.total - base.total;
  const percent = base.total > 0 ? change / base.total * 100 : null;
  const keys = (c: Column) => c.layers.map(l => l.key).sort().join("\n");
  // Without a common split the whole change is one step: the business itself, or neutral company revenue.
  const whole = (layer: Layer, reason: Bridge["reason"]): Bridge =>
    ({ base, current, lag, change, percent, reason, steps: [{ ...layer, value: current.total!, base: base.total!, delta: change, before: base.total!, after: current.total! }] });
  const total: Layer = { key: "__total", value: 0, tone: "total", slot: 0, shade: 0, name: m.revenueChange };
  if (current.state !== "ok" || base.state !== "ok") return whole(total, "basis");
  // One business across a change of segment basis has no comparable change.
  if (current.layers.length < 2 && current.layers[0]?.tone !== "total" && !onSameBasis(current, base)) return null;
  if (current.layers.length < 2) return whole(current.layers[0] ?? total, "single");
  if (keys(current) !== keys(base)) return whole(total, "basis");
  let level = base.total;
  const steps = current.layers
    .map(layer => { const prior = base.layers.find(l => l.key === layer.key)!.value; return { ...layer, base: prior, delta: layer.value - prior }; })
    .sort((a, b) => b.delta - a.delta)
    .map(step => { const before = level; level += step.delta; return { ...step, before, after: level }; });
  return { base, current, lag, change, percent, steps, reason: "split" };
}

/**
 * Growth of each column against the column `lag` slots earlier; a gap on either side leaves the point empty. A business's
 * growth (`byBusiness`) is also empty across a change of segment basis: the same name on two bases is not the same business.
 */
export function growthSeries(columns: Column[], lag: 1 | 4, byBusiness = false): Array<number | null> {
  return columns.map((column, i) => {
    const base = columns[i - lag];
    if (!base) return null;
    if (byBusiness && !onSameBasis(column, base)) return null;
    return growth(column.total, base.total);
  });
}

/** Two columns that split revenue the same way; a column that does not split (total only) is on no basis. */
export function onSameBasis(a: Column, b: Column): boolean {
  return !!a.slot.quarter && !!b.slot.quarter && sameBasis(a.slot.quarter.segments, b.slot.quarter.segments);
}

/**
 * Right-axis ticks for the growth line, on the same four gridlines as the revenue axis: 0% always falls on a gridline,
 * and the step is the smallest round number whose four ticks cover every rate. Null when there is no rate to plot.
 */
export function rateTicks(rates: Array<number | null>): number[] | null {
  const known = rates.filter((v): v is number => v != null && Number.isFinite(v));
  if (!known.length) return null;
  const lo = Math.min(0, ...known), hi = Math.max(0, ...known);
  let power = 10 ** Math.floor(Math.log10(Math.max((hi - lo) / 3, 0.5)));
  for (let tries = 0; tries < 8; tries++, power *= 10) for (const m of [1, 2, 2.5, 5]) {
    const step = m * power, below = Math.max(0, Math.ceil(-lo / step - 1e-9)), above = Math.max(0, Math.ceil(hi / step - 1e-9));
    if (below + above <= 3) return [0, 1, 2, 3].map(k => Number(((k - below) * step).toPrecision(12)) || 0);
  }
  return null;
}
