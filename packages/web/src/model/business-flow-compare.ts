import type { InfographicLayout, PlacedNode } from "./business-flow-layout";

/** Period-over-period geometry for the Sankey: marks of the comparison quarter's amounts on the current bars. */

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
