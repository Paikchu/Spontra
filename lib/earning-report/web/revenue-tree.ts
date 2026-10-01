import type { BusinessFlowQuarter, RevenueBreakdown, RevenueBreakdownNode } from "@/shared/analysis-contract/business-flow";
import { numeric } from "./business-flow-model";

export type RevenueTree = { dimension: RevenueBreakdown; nodes: RevenueBreakdownNode[]; depth: number; legacy: boolean };
const priorities: Record<RevenueBreakdown["kind"], number> = { business: 0, product_service: 0, end_market: 0, segment: 1, customer: 2, geography: 3 };
export const revenueNodeKey = (tree: RevenueTree, id: string) => tree.legacy ? id : `revenue:${JSON.stringify([tree.dimension.id, id])}`;

/** A bad child split stops at the parent; a bad root partition cannot describe total revenue. */
function usableTree(q: BusinessFlowQuarter, dimension: RevenueBreakdown, legacy = false): RevenueTree | null {
  const revenue = numeric(q.figures.revenue);
  if (!dimension.complete || !dimension.definitionKey || dimension.periodEnd !== q.periodEnd ||
      (q.periodStart != null && dimension.periodStart !== q.periodStart) ||
      dimension.currency !== q.currency || dimension.scale !== q.scale || revenue == null || revenue <= 0 ||
      !dimension.nodes.length || dimension.nodes.length > 40) return null;
  const duration = (Date.parse(dimension.periodEnd) - Date.parse(dimension.periodStart)) / 86400000;
  if (!legacy && (!Number.isFinite(duration) || duration < 70 || duration > 110)) return null;
  const byId = new Map(dimension.nodes.map(n => [n.id, n]));
  if (byId.size !== dimension.nodes.length || dimension.nodes.some(n => !n.id || (n.parentId !== null && !byId.has(n.parentId)))) return null;
  const sourceIds = new Set(q.sources.filter(s => /^https?:\/\//.test(s.url)).map(s => s.id));
  const amountValid = (n: RevenueBreakdownNode) => {
    const value = numeric(n.revenue);
    return value != null && value >= 0 && (legacy || Boolean(n.revenue?.sourceIds.length && n.revenue.sourceIds.every(id => sourceIds.has(id))));
  };
  const tolerance = Math.max(1e-6, revenue * 1e-9);
  const balanced = (nodes: RevenueBreakdownNode[], total: number) => nodes.length > 0 && nodes.every(amountValid) &&
    Math.abs(nodes.reduce((sum, n) => sum + numeric(n.revenue)!, 0) - total) <= tolerance;
  // Check all parent chains, including disconnected cycles, before rendering any hierarchy.
  for (const node of dimension.nodes) {
    const seen = new Set<string>();
    let current: RevenueBreakdownNode | undefined = node;
    let depth = 0;
    while (current) {
      if (seen.has(current.id) || ++depth > 4) return null;
      seen.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
  const roots = dimension.nodes.filter(n => n.parentId === null);
  if (!balanced(roots, revenue)) return null;
  const visible: RevenueBreakdownNode[] = [];
  let depth = 1;
  function visit(node: RevenueBreakdownNode, level: number) {
    // Zero amounts remain in the ledger, but do not create zero-width Sankey nodes.
    if (numeric(node.revenue) === 0) return;
    visible.push(node); depth = Math.max(depth, level);
    const children = dimension.nodes.filter(n => n.parentId === node.id);
    if (node.childrenComplete && balanced(children, numeric(node.revenue)!)) children.forEach(n => visit(n, level + 1));
  }
  roots.forEach(n => visit(n, 1));
  return { dimension, nodes: visible, depth, legacy };
}

export function availableRevenueTrees(q: BusinessFlowQuarter): RevenueTree[] {
  const dimensions = q.revenueBreakdowns ?? [];
  const counts = new Map<string, number>();
  dimensions.forEach(d => counts.set(d.id, (counts.get(d.id) ?? 0) + 1));
  const candidates = dimensions.filter(d => counts.get(d.id) === 1).map(d => usableTree(q, d)).filter((t): t is RevenueTree => t !== null);
  // Existing segment payloads remain usable; no company-specific rendering rules.
  const legacy = usableTree(q, { id: "financial-segments", label: "财务分部", kind: "segment", definitionKey: "legacy-segments",
    periodStart: q.periodStart ?? "", periodEnd: q.periodEnd, currency: q.currency, scale: q.scale, complete: q.segmentsComplete,
    nodes: q.segments.flatMap(s => [
      { ...s, parentId: null, childrenComplete: Boolean(s.children?.length) },
      ...(s.children ?? []).map(c => ({ ...s, ...c, children: undefined, parentId: s.id, childrenComplete: false, sourceIds: c.revenue.sourceIds })),
    ]) }, true);
  if (legacy && !candidates.some(t => t.dimension.kind === "segment")) candidates.push(legacy);
  return candidates.sort((a, b) => priorities[a.dimension.kind] - priorities[b.dimension.kind] ||
    b.nodes.length - a.nodes.length || b.depth - a.depth || (a.dimension.id < b.dimension.id ? -1 : a.dimension.id > b.dimension.id ? 1 : 0));
}

export function selectRevenueTree(q: BusinessFlowQuarter): RevenueTree | null {
  return availableRevenueTrees(q)[0] ?? null;
}

export function compareRevenueNode(q: BusinessFlowQuarter, previous: BusinessFlowQuarter | null, id: string) {
  const tree = selectRevenueTree(q), old = previous ? selectRevenueTree(previous) : null;
  const node = tree?.nodes.find(n => revenueNodeKey(tree, n.id) === id);
  const prior = old?.nodes.find(n => revenueNodeKey(old, n.id) === id);
  const a = node?.revenue, b = prior?.revenue;
  const av = numeric(a), bv = numeric(b);
  if (!tree || !old || !previous || tree.dimension.id !== old.dimension.id || tree.dimension.kind !== old.dimension.kind ||
      tree.dimension.definitionKey !== old.dimension.definitionKey || q.currency !== previous.currency || q.scale !== previous.scale ||
      !a?.comparabilityKey || a.comparabilityKey !== b?.comparabilityKey || a.definition !== b.definition || av == null || bv == null) return { label: "不可比" };
  if (bv === 0) return { label: av === 0 ? "持平" : "上季为零" };
  const percent = (av - bv) / bv * 100;
  return { label: `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%` };
}
