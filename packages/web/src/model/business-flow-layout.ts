import type { BusinessFlowQuarter } from "@/shared/analysis-contract/business-flow";
import type { FinancialGraph, SankeyNode } from "./business-flow-sankey";

export type FlowTone = "source" | "profit" | "expense" | "loss";
export type LabelSide = "top" | "bottom" | "left" | "right";
export type PlacedNode = SankeyNode & { x: number; y: number; h: number; column: number; tone: FlowTone; side: LabelSide };
export type PlacedLink = { source: string; target: string; value: number; tone: FlowTone; h: number; sy: number; ty: number; d: string };
export type InfographicLayout = { width: number; height: number; nodeWidth: number; nodes: PlacedNode[]; links: PlacedLink[] };

/** Geometry for the editorial layout: profit rises, costs sink, labels sit outside the bars. */
export const INFOGRAPHIC = { nodeWidth: 22, revenueHeight: 300, labelHeight: 54, sideLabelHeight: 50, gap: 18, lift: 56, drop: 48, minStep: 132, labelGap: 18, labelOffset: 12, margin: 32 } as const;
/** Callers with a different label design (e.g. one-line labels) override the label metrics; the defaults draw the editorial layout. */
export type InfographicGeometry = { [K in keyof typeof INFOGRAPHIC]: number };

const groupRank = (n: PlacedNode) => n.tone === "expense" ? 1 : 0;

function gapBetween(a: PlacedNode, b: PlacedNode, g: InfographicGeometry) {
  if (a.side === "left" || a.side === "right") return Math.max(g.gap, g.sideLabelHeight - a.h);
  return g.gap + (a.side === "bottom" ? g.labelHeight : 0) + (b.side === "top" ? g.labelHeight : 0);
}

/** Keeps column order, separates neighbours by their label space, and optionally recentres on the ideal positions. */
function resolve(column: PlacedNode[], ideal: Map<string, number>, recentre: boolean, g: InfographicGeometry) {
  let cursor = -Infinity;
  column.forEach((n, i) => {
    const want = ideal.get(n.name) ?? -Infinity;
    n.y = i === 0 ? (Number.isFinite(want) ? want : 0) : Math.max(Number.isFinite(want) ? want : -Infinity, cursor);
    if (i < column.length - 1) cursor = n.y + n.h + gapBetween(n, column[i + 1], g);
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

/** Approximate rendered width: CJK glyphs are one em, Latin digits and punctuation about 0.6 em. */
export function estimateTextWidth(text: string, size: number, bold = false): number {
  let em = 0;
  for (const char of text) em += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char) ? 1 : char === " " ? 0.3 : 0.6;
  return em * size * (bold ? 1.06 : 1);
}

/** Width of the default two-line label when the caller does not measure its own text. */
const defaultLabelWidth = (n: PlacedNode) => Math.max(estimateTextWidth(n.label, 15, true) + 8 + estimateTextWidth("$000.0B", 22, true), estimateTextWidth("占收入 00.0% · 环比 +00.0%", 13));

/** Horizontal span of a node's label relative to its column's x. */
function labelSpan(n: PlacedNode, width: number, g: InfographicGeometry): [number, number] {
  const { nodeWidth, labelOffset } = g;
  return n.side === "left" ? [-labelOffset - width, 0] : n.side === "right" ? [0, nodeWidth + labelOffset + width] : [nodeWidth / 2 - width / 2, nodeWidth / 2 + width / 2];
}

export function layoutInfographic(graph: FinancialGraph, labelWidth: (n: PlacedNode) => number = defaultLabelWidth, geometry: Partial<InfographicGeometry> = {}): InfographicLayout | null {
  if (!graph.links.length || !graph.nodes.length) return null;
  const g: InfographicGeometry = { ...INFOGRAPHIC, ...geometry };
  const depths = [...new Set(graph.nodes.map(n => n.depth))].sort((a, b) => a - b);
  const columnOf = new Map(depths.map((d, i) => [d, i]));
  const last = depths.length - 1;
  const revenue = graph.nodes.find(n => n.name === "revenue");
  const revenueColumn = graph.signed ? -1 : revenue ? columnOf.get(revenue.depth)! : 0;
  const scale = g.revenueHeight / Math.max(revenue?.value ?? 0, ...graph.nodes.map(n => n.value), 1e-9);

  const nodes: PlacedNode[] = graph.nodes.map(n => {
    const column = columnOf.get(n.depth)!;
    const tone: FlowTone = n.loss ? "loss" : n.credit ? "source" : n.expense ? "expense" : n.segmentId || n.name === "revenue" || column < revenueColumn ? "source" : "profit";
    // A deficit source enters from below, so its label sits under it like a cost's.
    const deficitSource = tone === "loss" && !graph.links.some(l => l.target === n.name);
    const side: LabelSide = column === 0 && column < revenueColumn ? "left" : column === last && column > revenueColumn ? "right" : tone === "expense" || deficitSource ? "bottom" : "top";
    return { ...n, column, tone, side, x: 0, y: 0, h: Math.max(2, n.value * scale) };
  });
  const byName = new Map(nodes.map(n => [n.name, n]));
  const linkHeight = (value: number) => value * scale;
  const incoming = (name: string) => graph.links.filter(l => l.target === name);
  const outgoing = (name: string) => graph.links.filter(l => l.source === name);
  const columns = depths.map((_, c) => nodes.filter(n => n.column === c));

  // Revenue and the business tree to its left: each child sits beside its slot in the parent.
  if (revenue) byName.get("revenue")!.y = 0;
  // A deficit that pays costs revenue cannot reach at all starts beside revenue, below it.
  if (revenue && revenueColumn >= 0) {
    let below = byName.get("revenue")!;
    for (const n of columns[revenueColumn].filter(n => n.name !== "revenue")) { n.y = below.y + below.h + gapBetween(below, n, g); below = n; }
  }
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
    resolve(columns[c], ideal, true, g);
  }

  const outStart = (n: PlacedNode) => n.offset ? n.h - outgoing(n.name).reduce((sum, l) => sum + linkHeight(l.value), 0) : 0;

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
        return source.y + outStart(source) + order.slice(0, order.indexOf(l)).reduce((sum, o) => sum + linkHeight(o.value), 0);
      }).filter(Number.isFinite);
      const slot = slots.length ? Math.min(...slots) : -Infinity;
      ideal.set(n.name, slot + (n.tone === "expense" ? g.drop : -g.lift));
    }
    // Inputless gains (other income) only feed the next profit node, which takes its parent's top band; stacking them
    // above the column lets their bands rise into that node instead of crossing the column's own cost outflows.
    const floating = columns[c].filter(n => n.tone !== "expense" && n.tone !== "loss" && !incoming(n.name).length);
    // A deficit source funds costs, which sink; it enters from below the column so its bands rise into them.
    const deficits = columns[c].filter(n => n.tone === "loss" && !incoming(n.name).length);
    const anchored = columns[c].filter(n => !floating.includes(n) && !deficits.includes(n));
    anchored.sort((a, b) => groupRank(a) - groupRank(b) || (ideal.get(a.name) ?? 0) - (ideal.get(b.name) ?? 0));
    resolve(anchored, ideal, false, g);
    let below = anchored[0];
    for (const n of floating.reverse()) {
      n.y = below ? below.y - gapBetween(n, below, g) - n.h : 0;
      below = n;
    }
    let above = anchored.at(-1);
    for (const n of deficits) {
      n.y = above ? above.y + above.h + gapBetween(above, n, g) : 0;
      above = n;
    }
  }

  // Vertical bounds include the label blocks, then everything is shifted onto the canvas.
  const extent = (n: PlacedNode): [number, number] => n.side === "top" ? [n.y - g.labelHeight, n.y + n.h] : n.side === "bottom" ? [n.y, n.y + n.h + g.labelHeight] : [n.y, n.y + Math.max(n.h, g.sideLabelHeight)];
  const top = Math.min(...nodes.map(n => extent(n)[0]));
  const shift = g.margin - top;
  for (const n of nodes) n.y += shift;
  const height = Math.max(...nodes.map(n => extent(n)[1])) + g.margin;

  // Column spacing is the smallest step at which no label touches a label or bar in another column.
  const widths = new Map(nodes.map(n => [n.name, labelWidth(n)]));
  const boxes = nodes.flatMap(n => {
    const [top, bottom] = extent(n), [l, r] = labelSpan(n, widths.get(n.name)!, g);
    const labelTop = n.side === "top" ? top : n.side === "bottom" ? n.y + n.h : n.y;
    const labelBottom = n.side === "top" ? n.y : bottom;
    return [{ column: n.column, l, r, top: labelTop, bottom: labelBottom }, { column: n.column, l: 0, r: g.nodeWidth, top: n.y, bottom: n.y + n.h }];
  });
  let step: number = g.minStep;
  for (const a of boxes) for (const b of boxes) {
    if (b.column <= a.column || a.bottom <= b.top || b.bottom <= a.top) continue;
    step = Math.max(step, (a.r - b.l + g.labelGap) / (b.column - a.column));
  }
  step = Math.ceil(step);
  const left = Math.max(g.margin, ...boxes.filter(b => b.column === 0).map(b => g.margin - b.l));
  const right = Math.max(g.margin + g.nodeWidth, ...boxes.filter(b => b.column === last).map(b => b.r + g.margin));
  for (const n of nodes) n.x = left + n.column * step;
  const width = Math.ceil(left + last * step + right);

  // Bands leave and enter in the vertical order of their partners so they never cross at a bar.
  const out = new Map<string, number>(), into = new Map<string, number>();
  const sourceOrder = graph.links.slice().sort((a, b) => byName.get(a.target)!.y - byName.get(b.target)!.y);
  const sy = new Map<typeof graph.links[number], number>();
  for (const l of sourceOrder) { const s = byName.get(l.source)!, used = out.get(l.source) ?? 0; sy.set(l, s.y + outStart(s) + used); out.set(l.source, used + linkHeight(l.value)); }
  const targetOrder = graph.links.slice().sort((a, b) => byName.get(a.source)!.y - byName.get(b.source)!.y);
  const links: PlacedLink[] = [];
  for (const l of targetOrder) {
    const s = byName.get(l.source)!, t = byName.get(l.target)!, used = into.get(l.target) ?? 0, h = linkHeight(l.value);
    const ty = t.y + used;
    into.set(l.target, used + h);
    const tone: FlowTone = s.tone === "loss" || t.tone === "loss" ? "loss" : t.tone === "expense" ? "expense" : t.tone === "profit" ? "profit" : "source";
    links.push({ source: l.source, target: l.target, value: l.value, tone, h, sy: sy.get(l)!, ty, d: band(s.x + g.nodeWidth, sy.get(l)!, t.x, ty, h) });
  }
  return { width, height: Math.ceil(height), nodeWidth: g.nodeWidth, nodes, links };
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
