import type { TreeNode, TreeRevenueModel } from "@/shared/analysis-contract/business-tree";
import { estimateTextWidth } from "@/packages/web/src/model/business-flow-layout";

/**
 * A picked business's breakdown, drawn to the left of the Sankey in the chart's own coordinates: the
 * business's node is the root, its product lines the first column, products the next, and how each
 * earns money as pills at the end of its branch. Columns grow right to left, so the whole map reads
 * from the products back into the statement.
 */
export type MindAnchor = {
  /** The Sankey node the branch hangs from, and the business it is. */
  key: string; label: string;
  /** Where the trunk leaves the anchor: the left end of its label, at the label's centre. */
  x: number; y: number;
  /** How the business itself earns money, when the material says so at this level, and what it is made of. */
  revenue: TreeRevenueModel[];
  nodes: TreeNode[];
};
type Box = { x: number; y: number; w: number; h: number };
/** `path` names what the item hangs from, from the business down to its parent. */
export type MindNodeItem = Box & { kind: "node"; id: string; anchor: string; depth: number; path: string[]; node: TreeNode; name: string; gloss: string | null };
/** `owner` is null for a pill hung on the business itself. */
export type MindRevenueItem = Box & { kind: "revenue"; id: string; anchor: string; depth: number; path: string[]; revenue: TreeRevenueModel; owner: TreeNode | null };
export type MindItem = MindNodeItem | MindRevenueItem;
export type MindEdge = { id: string; anchor: string; x0: number; y0: number; x1: number; y1: number; revenue: boolean; depth: number };
export type MindTrunk = { anchor: string; x0: number; x1: number; y: number };
/** `caption` is where the map's title sits: above its top row, at its left edge. `stacked` nodes put what a node is under its name. */
export type MindMapLayout = { items: MindItem[]; edges: MindEdge[]; trunks: MindTrunk[]; caption: { x: number; y: number }; box: { x0: number; y0: number; x1: number; y1: number }; stacked: boolean };

/** Type and spacing in layout units at k = 1, scaled with the Sankey's own type. */
export const mindType = (k: number) => ({ name: 14 * k, gloss: 12 * k, pill: 12.5 * k, padX: 10 * k, inner: 7 * k, nodeH: 28 * k, stackedH: 44 * k, pillH: 23 * k, gap: 6 * k, groupGap: 12 * k, column: 44 * k, maxName: 200 * k, maxGloss: 150 * k, title: 15 * k, hint: 12 * k, captionH: 48 * k });

/** Clips a name to the width a column allows; the full name stays in the tooltip and the card. */
function fit(text: string, size: number, max: number, bold = false): string {
  if (estimateTextWidth(text, size, bold) <= max) return text;
  let out = text;
  while (out.length > 4 && estimateTextWidth(out + "…", size, bold) > max) out = out.slice(0, -1);
  return out.trimEnd() + "…";
}

type Draft = { item: MindItem; children: Draft[]; span: number };

/**
 * `stacked` trades width for height: a deep, wide breakdown beside a short statement reads larger with
 * two-line nodes, a tall one with one-line nodes. The caller lays out both and keeps the one that fits.
 */
export function layoutMindMap(anchors: MindAnchor[], options: { k: number; right: number; top: number; bottom: number; stacked?: boolean }): MindMapLayout | null {
  const stacked = options.stacked === true;
  const t = mindType(options.k);
  const build = (node: TreeNode, depth: number, anchor: string, path: string[]): Draft => {
    const name = fit(node.name, t.name, t.maxName, true), gloss = node.gloss ? fit(node.gloss, t.gloss, t.maxGloss) : null;
    const nameW = estimateTextWidth(name, t.name, true), glossW = gloss ? estimateTextWidth(gloss, t.gloss) : 0;
    const w = (stacked ? Math.max(nameW, glossW) : nameW + (gloss ? t.inner + glossW : 0)) + 2 * t.padX;
    const item: MindNodeItem = { kind: "node", id: node.id, anchor, depth, path, node, name, gloss, x: 0, y: 0, w, h: stacked && gloss ? t.stackedH : t.nodeH };
    // How a node earns money comes first among its children, then what it is made of.
    const pills = node.revenue.map((revenue, i): Draft => ({ item: { kind: "revenue", id: `${node.id}:r${i}`, anchor, depth: depth + 1, path: [...path, node.name], revenue, owner: depth ? node : null, x: 0, y: 0, w: estimateTextWidth(revenue.label, t.pill, true) + 2 * t.padX + t.pill, h: t.pillH }, children: [], span: t.pillH }));
    const children = [...pills, ...node.children.map(child => build(child, depth + 1, anchor, [...path, node.name]))];
    const column = children.reduce((sum, c) => sum + c.span, 0) + Math.max(0, children.length - 1) * t.gap;
    return { item, children, span: Math.max(item.h, column) };
  };
  const blocks = anchors.map(anchor => {
    // The business is the root at depth 0; it is drawn by the Sankey, so only what hangs from it is placed.
    const roots = build({ id: `${anchor.key}:root`, name: anchor.label, gloss: null, kind: "line", flowNodeId: null, summary: null, anchor: null, revenue: anchor.revenue, children: anchor.nodes }, 0, anchor.key, []).children;
    const span = roots.reduce((sum, r) => sum + r.span, 0) + Math.max(0, roots.length - 1) * t.groupGap;
    return { anchor, roots, span, top: anchor.y - span / 2 };
  }).filter(b => b.roots.length).sort((a, b) => a.anchor.y - b.anchor.y);
  if (!blocks.length) return null;

  // Blocks keep their anchors' order and never overlap; together they stay inside the statement's height when they fit.
  for (let i = 1; i < blocks.length; i++) blocks[i]!.top = Math.max(blocks[i]!.top, blocks[i - 1]!.top + blocks[i - 1]!.span + t.groupGap * 2);
  const first = blocks[0]!.top, last = blocks.at(-1)!, end = last.top + last.span;
  const shift = end > options.bottom ? -Math.min(end - options.bottom, Math.max(0, first - options.top)) : first < options.top ? Math.min(options.top - first, Math.max(0, options.bottom - end)) : 0;
  for (const block of blocks) block.top += shift;

  // Columns align across the whole map; each item's right edge sits on its column's right edge.
  const all: Draft[] = [];
  const collect = (d: Draft) => { all.push(d); d.children.forEach(collect); };
  blocks.forEach(b => b.roots.forEach(collect));
  const depth = Math.max(...all.map(d => d.item.depth));
  const widths = Array.from({ length: depth + 1 }, (_, d) => Math.max(0, ...all.filter(x => x.item.depth === d).map(x => x.item.w)));
  const rightOf: number[] = [];
  for (let d = 1, edge = options.right - t.column; d <= depth; d++) { rightOf[d] = edge; edge -= widths[d]! + t.column; }

  const items: MindItem[] = [], edges: MindEdge[] = [], trunks: MindTrunk[] = [];
  const place = (d: Draft, top: number) => {
    const item = d.item;
    item.x = rightOf[item.depth]! - item.w;
    const column = d.children.reduce((sum, c) => sum + c.span, 0) + Math.max(0, d.children.length - 1) * t.gap;
    let cursor = top + (d.span - column) / 2;
    for (const child of d.children) { place(child, cursor); cursor += child.span + t.gap; }
    // A parent sits at the middle of what hangs from it.
    item.y = d.children.length ? (d.children[0]!.item.y + d.children.at(-1)!.item.y + d.children.at(-1)!.item.h) / 2 - item.h / 2 : top + (d.span - item.h) / 2;
    for (const child of d.children) edges.push({ id: `${item.id}>${child.item.id}`, anchor: item.anchor, x0: item.x, y0: item.y + item.h / 2, x1: child.item.x + child.item.w, y1: child.item.y + child.item.h / 2, revenue: child.item.kind === "revenue", depth: child.item.depth });
    items.push(item);
  };
  for (const block of blocks) {
    let cursor = block.top;
    for (const root of block.roots) {
      place(root, cursor);
      edges.push({ id: `${block.anchor.key}>${root.item.id}`, anchor: block.anchor.key, x0: options.right, y0: block.anchor.y, x1: root.item.x + root.item.w, y1: root.item.y + root.item.h / 2, revenue: false, depth: 1 });
      cursor += root.span + t.groupGap;
    }
    trunks.push({ anchor: block.anchor.key, x0: block.anchor.x, x1: options.right, y: block.anchor.y });
  }
  const pad = 14 * options.k;
  const left = Math.min(...items.map(i => i.x)), top = Math.min(...items.map(i => i.y));
  const box = { x0: left - pad, y0: top - t.captionH - pad, x1: Math.max(options.right, ...trunks.map(tr => tr.x0)), y1: Math.max(...items.map(i => i.y + i.h)) + pad };
  return { items: items.sort((a, b) => a.depth - b.depth), edges, trunks, caption: { x: left, y: top - t.captionH }, box, stacked };
}

/** A branch curve from a parent's left edge to a child's right edge. */
export function mindEdgePath(e: { x0: number; y0: number; x1: number; y1: number }): string {
  const r = (v: number) => Math.round(v * 10) / 10, xm = (e.x0 + e.x1) / 2;
  return `M${r(e.x0)},${r(e.y0)}C${r(xm)},${r(e.y0)} ${r(xm)},${r(e.y1)} ${r(e.x1)},${r(e.y1)}`;
}
