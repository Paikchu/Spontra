import type { BusinessFlowQuarter } from "@/shared/analysis-contract/business-flow";
import type { FinancialGraph, SankeyNode } from "./business-flow-sankey";

export type FlowTone = "source" | "profit" | "expense";
export type LabelSide = "top" | "bottom" | "left" | "right";
export type PlacedNode = SankeyNode & { x: number; y: number; h: number; column: number; tone: FlowTone; side: LabelSide };
export type PlacedLink = { source: string; target: string; value: number; tone: FlowTone; h: number; sy: number; ty: number; d: string };
export type InfographicLayout = { width: number; height: number; nodeWidth: number; nodes: PlacedNode[]; links: PlacedLink[] };

/** Geometry for the editorial layout: profit rises, costs sink, labels sit outside the bars. */
export const INFOGRAPHIC = { nodeWidth: 22, revenueHeight: 300, labelHeight: 84, sideLabelHeight: 80, gap: 18, lift: 64, drop: 56, step: 176, sideMargin: 190, centerMargin: 96, margin: 32 } as const;

const groupRank = (n: PlacedNode, hasInput: boolean) => n.tone === "expense" ? 2 : hasInput ? 0 : 1;

function gapBetween(a: PlacedNode, b: PlacedNode) {
  if (a.side === "left" || a.side === "right") return Math.max(INFOGRAPHIC.gap, INFOGRAPHIC.sideLabelHeight - a.h);
  return INFOGRAPHIC.gap + (a.side === "bottom" ? INFOGRAPHIC.labelHeight : 0) + (b.side === "top" ? INFOGRAPHIC.labelHeight : 0);
}

/** Keeps column order, separates neighbours by their label space, and optionally recentres on the ideal positions. */
function resolve(column: PlacedNode[], ideal: Map<string, number>, recentre: boolean) {
  let cursor = -Infinity;
  column.forEach((n, i) => {
    const want = ideal.get(n.name) ?? -Infinity;
    n.y = i === 0 ? (Number.isFinite(want) ? want : 0) : Math.max(Number.isFinite(want) ? want : -Infinity, cursor);
    if (i < column.length - 1) cursor = n.y + n.h + gapBetween(n, column[i + 1]);
  });
  if (!recentre) return;
  const finite = column.filter(n => Number.isFinite(ideal.get(n.name) ?? NaN));
  if (!finite.length) return;
  const shift = finite.reduce((sum, n) => sum + ideal.get(n.name)! - n.y, 0) / finite.length;
  for (const n of column) n.y += shift;
}

function band(x0: number, sy: number, x1: number, ty: number, h: number) {
  const xm = (x0 + x1) / 2, r = (v: number) => Math.round(v * 10) / 10;
  return `M${r(x0)},${r(sy)}C${r(xm)},${r(sy)} ${r(xm)},${r(ty)} ${r(x1)},${r(ty)}L${r(x1)},${r(ty + h)}C${r(xm)},${r(ty + h)} ${r(xm)},${r(sy + h)} ${r(x0)},${r(sy + h)}Z`;
}

export function layoutInfographic(graph: FinancialGraph): InfographicLayout | null {
  if (!graph.links.length || !graph.nodes.length) return null;
  const depths = [...new Set(graph.nodes.map(n => n.depth))].sort((a, b) => a - b);
  const columnOf = new Map(depths.map((d, i) => [d, i]));
  const last = depths.length - 1;
  const revenue = graph.nodes.find(n => n.name === "revenue");
  const revenueColumn = revenue ? columnOf.get(revenue.depth)! : 0;
  const scale = INFOGRAPHIC.revenueHeight / Math.max(revenue?.value ?? 0, ...graph.nodes.map(n => n.value), 1e-9);

  const nodes: PlacedNode[] = graph.nodes.map(n => {
    const column = columnOf.get(n.depth)!;
    const tone: FlowTone = n.expense ? "expense" : n.segmentId || n.name === "revenue" || column < revenueColumn ? "source" : "profit";
    const side: LabelSide = column === 0 && column < revenueColumn ? "left" : column === last && column > revenueColumn ? "right" : tone === "expense" ? "bottom" : "top";
    return { ...n, column, tone, side, x: 0, y: 0, h: Math.max(2, n.value * scale) };
  });
  const byName = new Map(nodes.map(n => [n.name, n]));
  const linkHeight = (value: number) => value * scale;
  const incoming = (name: string) => graph.links.filter(l => l.target === name);
  const outgoing = (name: string) => graph.links.filter(l => l.source === name);
  const columns = depths.map((_, c) => nodes.filter(n => n.column === c));

  // Revenue and the business tree to its left: each child sits beside its slot in the parent.
  if (revenue) byName.get("revenue")!.y = 0;
  for (let c = revenueColumn - 1; c >= 0; c--) {
    const ideal = new Map<string, number>();
    for (const n of columns[c]) {
      const link = outgoing(n.name)[0];
      const target = link && byName.get(link.target);
      if (!target) continue;
      const before = incoming(target.name).slice(0, incoming(target.name).indexOf(link)).reduce((sum, l) => sum + linkHeight(l.value), 0);
      ideal.set(n.name, target.y + before);
    }
    columns[c].sort((a, b) => (ideal.get(a.name) ?? 0) - (ideal.get(b.name) ?? 0));
    resolve(columns[c], ideal, true);
  }

  // Everything after revenue: profit is lifted above its parent's slot, costs drop below theirs.
  const outOrder = (name: string) => outgoing(name).slice().sort((a, b) => {
    const ta = byName.get(a.target)!, tb = byName.get(b.target)!;
    return (ta.tone === "expense" ? 1 : 0) - (tb.tone === "expense" ? 1 : 0);
  });
  for (let c = revenueColumn + 1; c <= last; c++) {
    const ideal = new Map<string, number>();
    for (const n of columns[c]) {
      const inputs = incoming(n.name);
      if (!inputs.length) { ideal.set(n.name, -Infinity); continue; }
      const slots = inputs.map(l => {
        const source = byName.get(l.source)!;
        if (source.column >= c) return Infinity;
        const order = outOrder(source.name);
        return source.y + order.slice(0, order.indexOf(l)).reduce((sum, o) => sum + linkHeight(o.value), 0);
      }).filter(Number.isFinite);
      const slot = slots.length ? Math.min(...slots) : -Infinity;
      ideal.set(n.name, slot + (n.tone === "expense" ? INFOGRAPHIC.drop : -INFOGRAPHIC.lift));
    }
    columns[c].sort((a, b) => groupRank(a, incoming(a.name).length > 0) - groupRank(b, incoming(b.name).length > 0) || (ideal.get(a.name) ?? 0) - (ideal.get(b.name) ?? 0));
    resolve(columns[c], ideal, false);
  }

  // Vertical bounds include the label blocks, then everything is shifted onto the canvas.
  const extent = (n: PlacedNode): [number, number] => n.side === "top" ? [n.y - INFOGRAPHIC.labelHeight, n.y + n.h] : n.side === "bottom" ? [n.y, n.y + n.h + INFOGRAPHIC.labelHeight] : [n.y, n.y + Math.max(n.h, INFOGRAPHIC.sideLabelHeight)];
  const top = Math.min(...nodes.map(n => extent(n)[0]));
  const shift = INFOGRAPHIC.margin - top;
  for (const n of nodes) n.y += shift;
  const height = Math.max(...nodes.map(n => extent(n)[1])) + INFOGRAPHIC.margin;

  const left = columns[0].some(n => n.side === "left") ? INFOGRAPHIC.sideMargin : INFOGRAPHIC.centerMargin;
  const right = columns[last].some(n => n.side === "right") ? INFOGRAPHIC.sideMargin : INFOGRAPHIC.centerMargin;
  for (const n of nodes) n.x = left + n.column * INFOGRAPHIC.step;
  const width = left + last * INFOGRAPHIC.step + INFOGRAPHIC.nodeWidth + right;

  // Bands leave and enter in the vertical order of their partners so they never cross at a bar.
  const out = new Map<string, number>(), into = new Map<string, number>();
  const sourceOrder = graph.links.slice().sort((a, b) => byName.get(a.target)!.y - byName.get(b.target)!.y);
  const sy = new Map<typeof graph.links[number], number>();
  for (const l of sourceOrder) { const s = byName.get(l.source)!, used = out.get(l.source) ?? 0; sy.set(l, s.y + used); out.set(l.source, used + linkHeight(l.value)); }
  const targetOrder = graph.links.slice().sort((a, b) => byName.get(a.source)!.y - byName.get(b.source)!.y);
  const links: PlacedLink[] = [];
  for (const l of targetOrder) {
    const s = byName.get(l.source)!, t = byName.get(l.target)!, used = into.get(l.target) ?? 0, h = linkHeight(l.value);
    const ty = t.y + used;
    into.set(l.target, used + h);
    const tone: FlowTone = t.tone === "expense" ? "expense" : t.tone === "profit" ? "profit" : "source";
    links.push({ source: l.source, target: l.target, value: l.value, tone, h, sy: sy.get(l)!, ty, d: band(s.x + INFOGRAPHIC.nodeWidth, sy.get(l)!, t.x, ty, h) });
  }
  return { width, height: Math.ceil(height), nodeWidth: INFOGRAPHIC.nodeWidth, nodes, links };
}

const symbols: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", HKD: "HK$" };
/** Short label for the diagram only; exact amounts stay in the ledger. */
export function compactFlowValue(value: number | null, quarter: BusinessFlowQuarter): string {
  if (value == null || !Number.isFinite(value)) return "未披露";
  const amount = value * quarter.scale, abs = Math.abs(amount);
  const [divisor, suffix] = abs >= 1e12 ? [1e12, "T"] : abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""];
  const digits = abs / divisor >= 100 || !suffix ? 0 : 1;
  const text = (abs / divisor).toFixed(digits) + suffix;
  const symbol = symbols[quarter.currency];
  return (amount < 0 ? "−" : "") + (symbol ? symbol + text : `${text} ${quarter.currency}`);
}
