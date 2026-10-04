import type { RevenueHistory, RevenueHistoryNode, RevenueHistoryQuarter } from "@/shared/analysis-contract/revenue-history";
import { disclosedSegmentLabel } from "@/lib/earning-report/web/business-flow-model";

export type TrendItem = { key: string; id: string; parent: string | null; name: string; slot: number };
export type Slot = { periodEnd: string; quarter: RevenueHistoryQuarter | null };
/** A stacked piece of one column. Every column renders every layer key, so switching focus morphs heights instead of remounting. */
export type Layer = { key: string; value: number; tone: "root" | "child" | "total"; slot: number; shade: number; name: string };
export type Column = { slot: Slot; layers: Layer[]; total: number | null; state: "ok" | "missing" | "basis" };

export const SLOTS = 8;
const norm = (name: string) => disclosedSegmentLabel(name).replace(/[\s（）()]/g, "").toLowerCase();

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
const monthEnd = (index: number) => new Date(Date.UTC(Math.floor(index / 12), index % 12 + 1, 0)).toISOString().slice(0, 10);

/** Eight consecutive quarterly slots ending at the newest period, stepped by calendar quarter; 52/53-week periods match within a month. */
export function buildSlots(history: RevenueHistory): Slot[] {
  const quarters = [...history.quarters].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const latest = quarters.at(-1);
  if (!latest) return [];
  const top = monthIndex(latest.periodEnd);
  return Array.from({ length: SLOTS }, (_, i) => {
    const target = top - 3 * (SLOTS - 1 - i);
    const match = quarters.find(q => Math.abs(monthIndex(q.periodEnd) - target) <= 1) ?? null;
    return { periodEnd: match?.periodEnd ?? monthEnd(target), quarter: match };
  });
}

/** Same disclosure id first; otherwise the same disclosed business name (filings rename members across presentations). */
function findNode<T extends { id: string; name: string }>(nodes: T[] | undefined, item: { id: string; name: string }) {
  return nodes?.find(n => n.id === item.id) ?? nodes?.find(n => norm(n.name) === norm(item.name));
}

export function matchItem(q: RevenueHistoryQuarter, item: TrendItem, items: TrendItem[]): number | null {
  if (!item.parent) { const node = findNode(q.segments, item); return node ? Number(node.value) : null; }
  const parent = items.find(i => i.key === item.parent);
  const node = parent ? findNode<RevenueHistoryNode>(q.segments, parent) : undefined;
  const child = findNode(node?.children, item);
  return child ? Number(child.value) : null;
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
