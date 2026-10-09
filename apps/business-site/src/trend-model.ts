import type { RevenueHistory, RevenueHistoryNode, RevenueHistoryQuarter } from "@/shared/analysis-contract/revenue-history";
import type { GuidanceItem, GuidancePublication, GuidanceSource } from "@/shared/analysis-contract/guidance";
import { disclosedSegmentLabel } from "@/packages/web/src/model/business-flow-model";

export type TrendItem = { key: string; id: string; parent: string | null; name: string; slot: number };
export type Slot = { periodEnd: string; quarter: RevenueHistoryQuarter | null; missingReason?: "currency" };
/** A stacked piece of one column. Every column renders every layer key, so switching focus morphs heights instead of remounting. */
export type Layer = { key: string; value: number; tone: "root" | "child" | "total"; slot: number; shade: number; name: string };
export type Column = { slot: Slot; layers: Layer[]; total: number | null; state: "ok" | "missing" | "basis" };

/** Most quarters shown as bars; companies with a shorter disclosure history show fewer. */
export const SLOTS = 5;
const norm = (name: string) => disclosedSegmentLabel(name).replace(/[\s（）()]/g, "").toLowerCase();

export const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
export const monthEnd = (index: number) => new Date(Date.UTC(Math.floor(index / 12), index % 12 + 1, 0)).toISOString().slice(0, 10);

/** Use base currency units for both actuals and guidance; never compare different currencies without an exchange-rate basis. */
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
            shade: 0, name: disclosedSegmentLabel(node.name) };
        }) };
      }
      return { slot, total: revenue, state: "basis", layers: [{ key: "__total", value: revenue, tone: "total", slot: 0, shade: 0, name: "公司总收入" }] };
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
  const total: Layer = { key: "__total", value: 0, tone: "total", slot: 0, shade: 0, name: "收入变化" };
  if (current.state !== "ok" || base.state !== "ok") return whole(total, "basis");
  if (current.layers.length < 2) return whole(current.layers[0] ?? total, "single");
  if (keys(current) !== keys(base)) return whole(total, "basis");
  let level = base.total;
  const steps = current.layers
    .map(layer => { const prior = base.layers.find(l => l.key === layer.key)!.value; return { ...layer, base: prior, delta: layer.value - prior }; })
    .sort((a, b) => b.delta - a.delta)
    .map(step => { const before = level; level += step.delta; return { ...step, before, after: level }; });
  return { base, current, lag, change, percent, steps, reason: "split" };
}

/** Growth of each column against the column `lag` slots earlier; a gap on either side leaves the point empty. */
export function growthSeries(columns: Column[], lag: 1 | 4): Array<number | null> {
  return columns.map((column, i) => i >= lag ? growth(column.total, columns[i - lag].total) : null);
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

/** A guided revenue range placed on a quarter: stated as an amount, or derived from stated growth. */
export type GuideMark = { periodEnd: string; low: number; high: number; derived: boolean; item: GuidanceItem; source: GuidanceSource | null };
export type GuideOverlay = { bySlot: Array<GuideMark | null>; next: GuideMark | null; outlook: GuidanceItem[] };

const DAY = 86_400_000;
const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 20 * DAY;
const plain = (value: string) => value.toLowerCase().replace(/revenues?$|net$/g, "").replace(/[^a-z0-9]/g, "");

/** Segment guidance names the business in the filing's words; match it to the member id, never to a translated label. */
export function segmentMatches(item: GuidanceItem, businessId: string): boolean {
  if (item.metric !== "segment_revenue" || !item.segment) return false;
  const name = plain(item.segment);
  return name.length >= 3 && (name === plain(businessId) || name === plain(businessId.replace(/Revenues?$/, "")));
}

function forSubject(item: GuidanceItem, selected: TrendItem | null) {
  if (!selected) return item.metric === "revenue" && !item.segment;
  return segmentMatches(item, selected.id);
}

function mark(item: GuidanceItem, sources: GuidanceSource[]): GuideMark | null {
  if (item.basis === "constant_currency") return null;
  const range = item.unit === "USD" && item.low != null && item.high != null ? { low: item.low, high: item.high, derived: false }
    : item.derived ? { low: item.derived.low, high: item.derived.high, derived: true } : null;
  return range && item.periodEnd ? { periodEnd: item.periodEnd, ...range, item, source: sources.find(s => s.id === item.sourceIds[0]) ?? null } : null;
}

/**
 * Places quarterly revenue guidance on the trend: each reported quarter gets the last range guided for it,
 * and the next quarter gets its own column. Annual and long-term targets do not fit a quarterly axis and
 * are returned separately, from the latest event only. Unplottable future quarterly guidance stays visible as text.
 */
export function guidanceOverlay(slots: Slot[], guidance: GuidancePublication | null, selected: TrendItem | null): GuideOverlay {
  const empty = { bySlot: slots.map(() => null), next: null, outlook: [] };
  if (!guidance || !slots.length) return empty;
  const latestFirst = [...guidance.items].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  const quarterly = latestFirst.filter(i => i.horizon === "quarter" && forSubject(i, selected));
  const pick = (test: (end: string) => boolean) => {
    for (const item of quarterly) { const m = item.periodEnd && test(item.periodEnd) ? mark(item, guidance.sources) : null; if (m) return m; }
    return null;
  };
  const last = slots.at(-1)!.periodEnd;
  const canPlot = slots.at(-1)!.quarter?.currency === "USD";
  const longer = latestFirst.filter(i => (selected ? forSubject(i, selected) : !i.segment)
    && (i.horizon !== "quarter" || ((!i.periodEnd || Date.parse(i.periodEnd) > Date.parse(last)) && (!canPlot || !mark(i, guidance.sources)))));
  const newest = longer[0]?.issuedAt;
  const order = ["revenue", "segment_revenue", "operating_margin", "eps", "free_cash_flow", "capex"];
  const rank = (i: GuidanceItem) => { const r = order.indexOf(i.metric); return r < 0 ? order.length : r; };
  return {
    bySlot: slots.map(slot => canPlot && slot.missingReason !== "currency" ? pick(end => near(end, slot.periodEnd)) : null),
    next: canPlot ? pick(end => Date.parse(end) - Date.parse(last) > 20 * DAY && Date.parse(end) - Date.parse(last) < 120 * DAY) : null,
    outlook: longer.filter(i => i.issuedAt === newest).sort((a, b) => rank(a) - rank(b) || (a.horizon === "annual" ? -1 : 1)).slice(0, 4),
  };
}

const METRIC_NAMES: Record<GuidanceItem["metric"], string> = {
  revenue: "收入", segment_revenue: "收入", gross_margin: "毛利率", operating_margin: "营业利润率", operating_income: "营业利润", eps: "EPS",
  free_cash_flow: "自由现金流", operating_cash_flow: "经营现金流", capex: "资本开支", rpo: "RPO", billings: "Billings", other: "",
};
export const ACTION_NAMES: Record<NonNullable<GuidanceItem["action"]>, string> = {
  initiated: "首次给出", raised: "上调", lowered: "下调", reaffirmed: "维持", narrowed: "收窄", widened: "放宽", updated: "更新",
};

/** "FY2027 收入增长 16%–17%（非 GAAP）" from an item; the money formatter is the panel's own. */
export function guidanceLabel(item: GuidanceItem, money: (v: number | null) => string): string {
  const period = item.horizon === "long_term" ? `长期${item.fiscalYear ? ` FY${item.fiscalYear}` : ""}` : item.horizon === "annual" ? `FY${item.fiscalYear}` : `FY${item.fiscalYear} Q${item.fiscalQuarter}`;
  const name = item.metric === "other" ? item.label : `${item.segment ? `${item.segment} ` : ""}${METRIC_NAMES[item.metric]}`;
  const basis = item.basis === "non_gaap" ? "（非 GAAP）" : item.basis === "constant_currency" ? "（固定汇率）" : "";
  if (item.form === "qualitative") return `${period} ${name}${item.direction === "up" ? "预计上行" : item.direction === "down" ? "预计下行" : "预计持平"}${basis}`;
  const one = (v: number | null) => v == null ? "" : item.unit === "USD" ? money(v) : item.unit === "USD_per_share" ? `$${v.toFixed(2)}` : `${Number(v.toFixed(2))}%`;
  const range = item.form === "floor" ? `≥ ${one(item.low)}` : item.form === "ceiling" ? `≤ ${one(item.high)}` : item.low === item.high ? one(item.low) : `${one(item.low)}–${one(item.high)}`;
  return `${period} ${name}${item.measure === "growth" ? "增长 " : " "}${range}${basis}`;
}
