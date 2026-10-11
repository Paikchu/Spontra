import type { InfographicLayout, PlacedLink, PlacedNode } from "./business-flow-layout";
import type { FinancialGraph } from "./business-flow-sankey";

/**
 * Period-over-period geometry for the Sankey: the comparison quarter drawn at the current quarter's scale,
 * marks of its amounts on the current bars, and the interpolation between the two layouts.
 */

/** The largest value sets a layout's scale; the prior quarter must share the current quarter's, so its revenue height is scaled by their ratio. */
export function priorRevenueHeight(current: FinancialGraph, previous: FinancialGraph, revenueHeight: number): number {
  const peak = (g: FinancialGraph) => Math.max(g.nodes.find(n => n.name === "revenue")?.value ?? 0, ...g.nodes.map(n => n.value), 1e-9);
  return revenueHeight * peak(previous) / peak(current);
}

/**
 * The prior graph in the current graph's order: a layout places nodes by the order of their links, so a quarter that
 * discloses the same businesses in another order would otherwise swap bands when the chart morphs between quarters.
 */
export function alignedGraph(previous: FinancialGraph, current: FinancialGraph): FinancialGraph {
  const nodeRank = new Map(current.nodes.map((n, i) => [n.name, i]));
  const linkRank = new Map(current.links.map((l, i) => [`${l.source}>${l.target}`, i]));
  const rank = (map: Map<string, number>, key: string, fallback: number) => map.get(key) ?? current.nodes.length + current.links.length + fallback;
  const nodes = previous.nodes.map((n, i) => ({ n, i })).sort((a, b) => rank(nodeRank, a.n.name, a.i) - rank(nodeRank, b.n.name, b.i)).map(({ n }) => n);
  const links = previous.links.map((l, i) => ({ l, i })).sort((a, b) => rank(linkRank, `${a.l.source}>${a.l.target}`, a.i) - rank(linkRank, `${b.l.source}>${b.l.target}`, b.i)).map(({ l }) => l);
  return { ...previous, nodes, links };
}

/**
 * The comparison period's amount on a bar, at the current layout's scale. It is measured from the bar's labelled end
 * (top-labelled bars from their top, bottom-labelled cost bars from their bottom): `tick` is where that amount ends,
 * `gain` the part of the bar it did not reach, `short` the stretch past the bar it used to reach.
 */
export type PriorMark = { name: string; tick: number; gain: [number, number] | null; short: [number, number] | null };

export function priorMarks(layout: InfographicLayout, priorOf: (n: PlacedNode) => number | null): PriorMark[] {
  const anchor = layout.nodes.find(n => n.name === "revenue" && n.value > 0) ?? layout.nodes.find(n => n.value > 0);
  if (!anchor) return [];
  const scale = anchor.h / anchor.value;
  const marks: PriorMark[] = [];
  for (const n of layout.nodes) {
    const prior = priorOf(n);
    if (prior == null || !Number.isFinite(prior) || prior < 0) continue;
    const fromBottom = n.side === "bottom";
    const start = fromBottom ? n.y + n.h : n.y, end = fromBottom ? n.y : n.y + n.h;
    const h = prior * scale;
    // Under half a unit apart the two amounts read as one: the tick sits on the bar's end.
    if (Math.abs(h - n.h) < 0.5) { marks.push({ name: n.name, tick: end, gain: null, short: null }); continue; }
    const tick = fromBottom ? start - h : start + h;
    const span = (a: number, b: number): [number, number] => [Math.min(a, b), Math.max(a, b)];
    marks.push({ name: n.name, tick, gain: h < n.h ? span(tick, end) : null, short: h > n.h ? span(end, tick) : null });
  }
  return marks;
}

export type MorphNode = PlacedNode & { fade: number };
export type MorphLink = PlacedLink & { fade: number };
export type MorphLayout = { nodes: MorphNode[]; links: MorphLink[] };

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const linkKey = (l: { source: string; target: string }) => `${l.source}>${l.target}`;

/**
 * The statement between two quarters: at t = 0 the current layout, at t = 1 the prior one. Nodes and bands present in
 * both glide by name; one present in only one quarter keeps its own geometry and fades with the quarter it belongs to.
 */
export function morphLayout(current: InfographicLayout, previous: InfographicLayout | null, t: number): MorphLayout {
  if (!previous || t <= 0) return { nodes: current.nodes.map(n => ({ ...n, fade: 1 })), links: current.links.map(l => ({ ...l, fade: 1 })) };
  const p = Math.min(1, t);
  const prevNodes = new Map(previous.nodes.map(n => [n.name, n]));
  const prevLinks = new Map(previous.links.map(l => [linkKey(l), l]));
  const nodes: MorphNode[] = current.nodes.map(n => {
    const o = prevNodes.get(n.name);
    return o ? { ...n, x: mix(n.x, o.x, p), y: mix(n.y, o.y, p), h: mix(n.h, o.h, p), fade: 1 } : { ...n, fade: 1 - p };
  });
  for (const o of previous.nodes) if (!current.nodes.some(n => n.name === o.name)) nodes.push({ ...o, fade: p });
  const links: MorphLink[] = current.links.map(l => {
    const o = prevLinks.get(linkKey(l));
    return o ? { ...l, sy: mix(l.sy, o.sy, p), ty: mix(l.ty, o.ty, p), h: mix(l.h, o.h, p), fade: 1 } : { ...l, fade: 1 - p };
  });
  for (const o of previous.links) if (!prevLinkInCurrent(current, o)) links.push({ ...o, fade: p });
  return { nodes, links };
}

const prevLinkInCurrent = (current: InfographicLayout, o: PlacedLink) => current.links.some(l => l.source === o.source && l.target === o.target);
