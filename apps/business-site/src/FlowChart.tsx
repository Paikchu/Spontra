import { useMedia } from "./side-scroll";

import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { peekChartBox } from "./chart-box";
import { markContent } from "./vitals";
import type { FinancialGraph } from "@/packages/web/src/model/business-flow-sankey";
import { estimateTextWidth, INFOGRAPHIC, layoutInfographic, type InfographicGeometry, type InfographicLayout, type PlacedLink, type PlacedNode } from "@/packages/web/src/model/business-flow-layout";
import { priorMarks } from "@/packages/web/src/model/business-flow-compare";
import { layoutMindMap, type MindItem, type MindMapLayout } from "./mindmap-layout";
import { MindLayer, type MindMapInput } from "./MindMap";
import { getLocale, messages } from "@/packages/web/src/i18n";
import { qoqLabel } from "@/shared/analysis-runtime/locale";

const m = messages({
  revenueModel: "Revenue model", partOf: "Part of", description: "Description", contains: "Contains",
  items: (n: number) => `${n} ${n === 1 ? "item" : "items"}`, details: (label: string) => `${label} business details`,
  flow: "Flow", lastQuarter: "last quarter",
}, {
  revenueModel: "收入模式", partOf: "所属", description: "描述", contains: "包含",
  items: (n: number) => `${n} 项`, details: (label: string) => `${label} 业务详情`,
  flow: "金额", lastQuarter: "上季度",
});

/** `change` is the comparable change against the comparison quarter; absent when the two quarters cannot be compared. */
export type NodeCopy = { name: string; value: string; change?: { label: string; trend?: "up" | "down" } };
export type Tip = { title: string; color: string; rows: Array<[string, string]> };

type Band = { x0: number; x1: number; sy: number; ty: number; h: number; color: string; key: string; owner: string };

/** Type scale in layout units at k = 1; k is solved per pane so labels keep a constant on-screen size. */
const typeFor = (k: number) => ({ name: 15 * k, value: 22 * k, net: 26 * k, change: 12.5 * k, gap: 7 * k, offset: 10 * k, pill: 14 * k });
/** Names sit above figures, keeping long statement labels from widening every column. */
const geometryFor = (k: number) => ({ labelHeight: 62 * k, sideLabelHeight: 56 * k, gap: 16, lift: 46, drop: 40, labelGap: 20 * k, labelOffset: 14 * k, margin: 28 * k });
const SCREEN_VALUE_PX = 17;
const valueSize = (n: PlacedNode, k: number) => n.name === "net" ? typeFor(k).net : typeFor(k).value;
const EMPTY: InfographicLayout = { width: 1, height: 1, nodeWidth: 22, nodes: [], links: [] };
const INLINE_LABEL_GAP = 5;
const INLINE_REVENUE_HEIGHT = 180;
type LabelLine = { content: string; kind: "name" | "value" | "change"; size: number; advance: number };
type Fitted = { layout: InfographicLayout; k: number; stacked?: Map<string, LabelLine[]>; editorial?: InfographicLayout };
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const linkKey = (l: { source: string; target: string }) => `${l.source}>${l.target}`;
const r = (v: number) => Math.round(v * 10) / 10;

function bandPath({ x0, x1, sy, ty, h }: Omit<Band, "color" | "key">) {
  const xm = (x0 + x1) / 2;
  return `M${r(x0)},${r(sy)}C${r(xm)},${r(sy)} ${r(xm)},${r(ty)} ${r(x1)},${r(ty)}L${r(x1)},${r(ty + h)}C${r(xm)},${r(ty + h)} ${r(xm)},${r(sy + h)} ${r(x0)},${r(sy + h)}Z`;
}
function linePath(x0: number, sy: number, x1: number, ty: number) {
  const xm = (x0 + x1) / 2;
  return `M${r(x0)},${r(sy)}C${r(xm)},${r(sy)} ${r(xm)},${r(ty)} ${r(x1)},${r(ty)}`;
}

function labelWidth(n: PlacedNode, text: NodeCopy, k: number) {
  const type = typeFor(k);
  return Math.max(estimateTextWidth(text.name, type.name), estimateTextWidth(text.value, valueSize(n, k), true)
    + (text.change ? type.gap + estimateTextWidth(text.change.label, type.change, true) : 0)) + 4 * k;
}

export function layoutFor(graph: FinancialGraph, copy: (n: PlacedNode) => NodeCopy, k = 1, geometry: Partial<InfographicGeometry> = {}): InfographicLayout | null {
  return layoutInfographic(graph, n => labelWidth(n, copy(n), k), { ...geometryFor(k), ...geometry });
}

function wrapLabel(text: string, width: number, size: number, bold: boolean) {
  const parts = text.match(/[^\s\u2e80-\u9fff]+|[\u2e80-\u9fff]|\s+/gu) ?? [];
  const lines: string[] = [];
  let line = "";
  for (const part of parts.flatMap(word => estimateTextWidth(word, size, bold) > width ? [...word] : [word])) {
    if (line && estimateTextWidth(line + part, size, bold) > width) {
      lines.push(line.trimEnd());
      line = "";
    }
    line += line ? part : part.trimStart();
  }
  if (line) lines.push(line.trimEnd());
  return lines;
}

function inlineLabel(copy: NodeCopy, width: number, emphasis: boolean): LabelLine[] {
  const widthAtOne = estimateTextWidth(copy.value, 1, true);
  const valueSize = Math.max(12, Math.min(emphasis ? 15 : 14, Math.floor(width / widthAtOne * 10) / 10));
  const splitValue = copy.value.match(/^([−+\-]?[0-9.,]+[万亿兆]*)([\u2e80-\u9fff]+)$/u);
  const styles: { kind: LabelLine["kind"]; text: string; size: number }[] = [
    { kind: "name", text: copy.name, size: 12 },
    { kind: "value", text: copy.value, size: valueSize },
    { kind: "change", text: copy.change?.label ?? "", size: 11 },
  ];
  return styles.flatMap(({ kind, text, size }) => {
    const lines = kind === "value" && splitValue && estimateTextWidth(text, size, true) > width
      ? [splitValue[1], splitValue[2]].flatMap(part => wrapLabel(part, width, size, true))
      : wrapLabel(text, width, size, kind !== "name");
    return lines.map(content => ({ content, kind, size, advance: size + 3 }));
  });
}

const inlineLabelHeight = (lines: LabelLine[]) => INLINE_LABEL_GAP + lines.reduce((sum, line) => sum + line.advance, 0);

/** Keep the editorial layout at ample widths; on a phone the full labels stack within each original column. */
function inlineLayout(graph: FinancialGraph, copy: (n: PlacedNode) => NodeCopy, width: number): Fitted | null {
  const editorial = layoutFor(graph, copy);
  if (!editorial) return null;
  if (editorial.width <= width) return { layout: editorial, k: 1 };
  const columns = new Set(graph.nodes.map(node => node.depth)).size;
  const step = Math.max(52, Math.floor(width / columns));
  const labelGap = 6;
  const stackWidth = step - labelGap;
  const stacked = new Map(editorial.nodes.map(node => [node.name, inlineLabel(copy(node), stackWidth, node.name === "net")]));
  const layout = layoutInfographic(graph, () => stackWidth, {
    minStep: step, nodeWidth: 8, revenueHeight: INLINE_REVENUE_HEIGHT, lift: 16, drop: 18, margin: 3, labelGap, gap: 18,
  }, node => inlineLabelHeight(stacked.get(node.name) ?? []));
  return layout && { layout, k: 1, stacked, editorial };
}

/** Transfer the editorial mark geometry onto its narrower bar, including any span outside the bar. */
function fittedMarks(layout: InfographicLayout, reference: InfographicLayout | undefined, priorOf: (n: PlacedNode) => number | null) {
  if (!reference) return priorMarks(layout, priorOf);
  const originals = new Map(reference.nodes.map(node => [node.name, node]));
  const fitted = new Map(layout.nodes.map(node => [node.name, node]));
  return priorMarks(reference, priorOf).flatMap(mark => {
    const original = originals.get(mark.name), node = fitted.get(mark.name);
    if (!original || !node) return [];
    const at = (value: number) => {
      const offset = value - original.y;
      const within = Math.max(0, Math.min(original.h, offset));
      return node.y + within * node.h / original.h + (offset - within) * INLINE_REVENUE_HEIGHT / INFOGRAPHIC.revenueHeight;
    };
    const span = (ends: [number, number] | null): [number, number] | null => ends && [at(ends[0]), at(ends[1])];
    return [{ ...mark, tick: at(mark.tick), gain: span(mark.gain), short: span(mark.short) }];
  });
}

type Box = { x0: number; y0: number; x1: number; y1: number };
function nodeLabel(n: PlacedNode, text: NodeCopy, k: number, w: number) {
  const type = typeFor(k), vs = valueSize(n, k), gap = geometryFor(k).labelOffset, line = vs + 5 * k;
  const height = type.name + line + vs * .25;
  const [x, y, anchor]: [number, number, "start" | "middle" | "end"] = n.side === "top" ? [n.x + w / 2, n.y - type.offset - line, "middle"]
    : n.side === "bottom" ? [n.x + w / 2, n.y + n.h + type.offset + type.name, "middle"]
    : [n.side === "left" ? n.x - gap : n.x + w + gap, n.y + Math.max(n.h, geometryFor(k).sideLabelHeight) / 2 - height / 2 + type.name, n.side === "left" ? "end" : "start"];
  const width = labelWidth(n, text, k), left = x - (anchor === "middle" ? width / 2 : anchor === "end" ? width : 0);
  return { x, y, valueY: y + line, anchor, box: { x0: left, x1: left + width, y0: y - type.name, y1: y + line + vs * .25 } };
}

type Camera = { x: number; y: number; zoom: number };
/** The drawable area: the statement, widened to the left when a business's breakdown hangs beside it. */
type World = Box;
const home = (world: World): Camera => ({ x: world.x0, y: world.y0, zoom: 1 });
const FOCUS_ZOOM = 1.3;
const MAX_ZOOM = 4;
/** Narrow layouts show the full-size statement in a sideways scroller; there the page's own gestures scroll it. */
const scrollsSideways = (element: Element) => { const scroller = element.closest(".chart"); return Boolean(scroller && scroller.scrollWidth > scroller.clientWidth); };

/**
 * The part of the statement a picked business is about: the business, the businesses it is made of, its path into revenue,
 * their labels and the share pill beside revenue. Costs and profit are never allocated to a business, so they stay out of it.
 */
function focusBounds(layout: InfographicLayout, name: string, copy: (n: PlacedNode) => NodeCopy, k: number): Box | null {
  const byName = new Map(layout.nodes.map(n => [n.name, n]));
  if (!byName.has(name)) return null;
  const names = new Set([name]);
  const up = (target: string) => { for (const l of layout.links) if (l.target === target && !names.has(l.source)) { names.add(l.source); up(l.source); } };
  up(name);
  for (let next: string | undefined = name; next && next !== "revenue" && next !== "segment-total";) {
    next = layout.links.find(l => l.source === next)?.target;
    if (next) names.add(next);
  }
  const w = layout.nodeWidth;
  const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const add = (x0: number, y0: number, x1: number, y1: number) => { box.x0 = Math.min(box.x0, x0); box.y0 = Math.min(box.y0, y0); box.x1 = Math.max(box.x1, x1); box.y1 = Math.max(box.y1, y1); };
  for (const key of names) {
    const n = byName.get(key)!, text = copy(n);
    add(n.x, n.y, n.x + w, n.y + n.h);
    const { box } = nodeLabel(n, text, k, w);
    add(box.x0, box.y0, box.x1, box.y1);
    if (key === "revenue" || key === "segment-total") add(n.x, n.y, n.x + w + 150 * k, n.y + n.h);
  }
  const pad = 28 * k;
  return { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad };
}

/** The camera that fits `box` in a pane of `size`, given that the viewBox keeps the world's aspect and is centred (xMidYMid meet). */
function cameraFor(box: Box, world: World, size: { w: number; h: number } | null, cap = FOCUS_ZOOM): Camera {
  const width = world.x1 - world.x0, height = world.y1 - world.y0;
  const aspect = size ? size.w / size.h : width / height;
  const visibleW = Math.max(width, height * aspect), visibleH = Math.max(height, width / aspect);
  // A gentle push-in: enough to set the business apart, never so close that the rest of the statement leaves the frame.
  const zoom = Math.max(1, Math.min(cap, visibleW / (box.x1 - box.x0), visibleH / (box.y1 - box.y0)));
  if (zoom < 1.05) return home(world);
  const vw = width / zoom, vh = height / zoom;
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  return { x: clamp((box.x0 + box.x1) / 2 - vw / 2, world.x0, world.x1 - vw), y: clamp((box.y0 + box.y1) / 2 - vh / 2, world.y0, world.y1 - vh), zoom };
}

/**
 * Where a picked business's breakdown goes: each branch leaves its Sankey node from the left end of the
 * node's label, and the first column starts left of every label in that column, so no branch crosses one.
 */
function mindFor(input: MindMapInput, layout: InfographicLayout, copy: (n: PlacedNode) => NodeCopy, k: number, focus: Box | null, size: { w: number; h: number } | null): MindMapLayout | null {
  const g = geometryFor(k), byName = new Map(layout.nodes.map(n => [n.name, n]));
  const labelLeft = (n: PlacedNode) => n.side === "left" ? n.x - g.labelOffset - labelWidth(n, copy(n), k) : n.x;
  const placed = input.branches.flatMap(b => { const n = byName.get(b.node); return n && b.nodes.length ? [{ b, n }] : []; });
  if (!placed.length) return null;
  const column = Math.min(...placed.map(p => p.n.column));
  const right = Math.min(...layout.nodes.filter(n => n.column === column).map(labelLeft)) - 20 * k;
  const anchors = placed.map(({ b, n }) => ({ key: b.node, label: b.label, x: labelLeft(n) - 6 * k, y: n.y + Math.max(n.h, g.sideLabelHeight) / 2, nodes: b.nodes }));
  const options = { k, right, top: 0, bottom: layout.height };
  const [flat, stacked] = [layoutMindMap(anchors, options), layoutMindMap(anchors, { ...options, stacked: true })];
  if (!flat || !stacked || !size) return flat;
  // The one that lets the focus frame draw its type larger in this pane.
  const scale = (mind: MindMapLayout) => {
    const world = worldOf(mind, layout), box = focus ? union(focus, mind.box) : mind.box;
    const camera = cameraFor(box, world, size, FOCUS_ZOOM * Math.max((world.x1 - world.x0) / layout.width, (world.y1 - world.y0) / layout.height));
    return Math.min(size.w / ((world.x1 - world.x0) / camera.zoom), size.h / ((world.y1 - world.y0) / camera.zoom));
  };
  return scale(stacked) > scale(flat) * 1.04 ? stacked : flat;
}
const union = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
function worldOf(mind: MindMapLayout | null, layout: InfographicLayout): World {
  return mind ? { x0: Math.min(0, mind.box.x0), y0: Math.min(0, mind.box.y0), x1: Math.max(layout.width, mind.box.x1), y1: Math.max(layout.height, mind.box.y1) } : { x0: 0, y0: 0, x1: layout.width, y1: layout.height };
}

/** A few fixed-point steps: larger type widens the layout, which shrinks the fit scale, so k converges quickly. */
function fitLayout(graph: FinancialGraph, copy: (n: PlacedNode) => NodeCopy, size: { w: number; h: number } | null, narrow = false) {
  // Avoid accumulating a tall staircase above revenue in a sideways phone viewport.
  const geometry = narrow ? { lift: 10, drop: 16, margin: 20 } : {};
  let k = 1, layout = layoutFor(graph, copy, k, geometry);
  if (!layout || !size) return layout && { layout, k };
  for (let i = 0; i < 5; i++) {
    const scale = Math.min(size.w / layout.width, size.h / layout.height);
    const next = Math.max(0.9, Math.min(1.3, SCREEN_VALUE_PX / (22 * scale)));
    if (Math.abs(next - k) < 0.02) break;
    k = next;
    layout = layoutFor(graph, copy, k, geometry)!;
  }
  return { layout, k };
}

/** Streamlines: thin dashed curves inside a band whose dash offset animates, so value appears to travel. */
function Streams({ band, strength }: { band: Band; strength: "ambient" | "lit" }) {
  const count = Math.max(1, Math.min(7, Math.round(band.h / 13)));
  return <g className="fc-streams" data-strength={strength} style={{ "--stream": band.color } as CSSProperties}>
    {Array.from({ length: count }, (_, i) => {
      const f = (i + 0.5) / count;
      // Deterministic phase per streamline so neighbours never pulse in unison.
      const phase = ((band.sy * 7 + i * 13.7) % 40) / 40;
      return <path key={i} d={linePath(band.x0, band.sy + band.h * f, band.x1, band.ty + band.h * f)} style={{ animationDelay: `${-phase * 1.6}s` }} />;
    })}
  </g>;
}


/** What the chart compares against: `change` names the change (YoY / QoQ), `prior` the comparison quarter (last year / last quarter), both in the page's locale. */
export type CompareBasis = { change: string; prior: string };
const qoq = (): CompareBasis => ({ change: qoqLabel(getLocale()), prior: m.lastQuarter });

export function FlowChart({ graph, copy, money, colorOf, active, focusSlot, onHover, onPick, tipFor, label, revealKey, businessDetails, mindMap = null, mindPick = null, onMindPick, productBusiness = null, spotlight = null, priorOf, basis = qoq(), inline = false }: {
  inline?: boolean;
  businessDetails?: ReactNode;
  /** The picked business broken down into product lines, products and how each earns, drawn beside the written details. */
  mindMap?: MindMapInput | null;
  /** The breakdown node whose explanation is open in the details beside the map; picking it again closes it. */
  mindPick?: string | null;
  onMindPick?: (item: MindItem | null) => void;
  /** The comparable amount of a node in the comparison quarter, drawn as a tick on its bar; null when the two quarters cannot be compared. */
  priorOf?: (n: PlacedNode) => number | null;
  basis?: CompareBasis;
  productBusiness?: string | null;
  /** Nodes a finding is about: they and their bands stay lit while the rest of the statement recedes. */
  spotlight?: Set<string> | null;
  /** A mark beside each node a finding names, for the overview. */
  graph: FinancialGraph;
  copy: (n: PlacedNode) => NodeCopy;
  money: (value: number) => string;
  colorOf: (name: string) => string;
  /** Graph node in focus (selected business or hovered node). */
  active: string | null;
  /** Rendered next to the revenue slot of an active business. */
  focusSlot: (n: PlacedNode) => string | null;
  onHover: (name: string | null) => void;
  onPick: (n: PlacedNode) => void;
  tipFor: (n: PlacedNode) => Tip;
  label: string;
  revealKey: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const box = useRef<HTMLDivElement>(null);
  // The pane measured before this chart mounted, so the first paint is already fitted.
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => inline ? null : peekChartBox());
  useEffect(() => { if (size) markContent("company"); }, [size]);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measured = inline ? element.closest(".statement-chart-content") ?? element : element;
    const measure = () => {
      const w = inline ? measured.clientWidth : Math.round(element.clientWidth / 8) * 8;
      const h = inline ? 1 : Math.round(element.clientHeight / 8) * 8;
      if (w > 0 && h > 0) setSize(old => old?.w === w && old.h === h ? old : { w, h });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(measured);
    return () => observer.disconnect();
  }, [inline]);
  const narrowPane = useMedia("(max-width: 960px)");
  const fitted = useMemo<Fitted | null>(() => inline && size ? inlineLayout(graph, copy, size.w)
    : fitLayout(graph, copy, size, narrowPane), [graph, copy, size, narrowPane, inline]);
  const [tip, setTip] = useState<{ x: number; y: number; width: number; tip: Tip } | null>(null);
  const layout = fitted?.layout ?? EMPTY, k = fitted?.k ?? 1, type = typeFor(k);
  const w = layout.nodeWidth;
  const editorial = fitted?.editorial;
  const markOf = useMemo(() => new Map(priorOf ? fittedMarks(layout, editorial, priorOf).map(m => [m.name, m]) : []),
    [layout, priorOf, editorial]);
  const byName = useMemo(() => new Map(layout.nodes.map(n => [n.name, n])), [layout]);
  const productTarget = productBusiness ? byName.get(productBusiness) : null;
  const mind = useMemo(() => mindMap && fitted && productBusiness
    ? mindFor(mindMap, fitted.layout, copy, fitted.k, narrowPane ? null : focusBounds(fitted.layout, productBusiness, copy, fitted.k), size) : null, [mindMap, fitted, copy, productBusiness, size, narrowPane]);
  const expanded = Boolean(productTarget);
  const world: World = useMemo(() => {
    const bounds = worldOf(mind, layout);
    if (!inline) return bounds;
    return { ...bounds, y0: Math.min(bounds.y0, ...[...markOf.values()].map(mark => mark.tick - 3)),
      y1: Math.max(bounds.y1, ...[...markOf.values()].map(mark => mark.tick + 3)) };
  }, [mind, layout, inline, markOf]);
  const worldW = world.x1 - world.x0, worldH = world.y1 - world.y0;
  // The explanation's scrollbar stays hidden until the reader scrolls it, and fades shortly after.
  const [scrolling, setScrolling] = useState(false);
  const scrollIdle = useRef(0);
  const revealScrollbar = () => { setScrolling(true); clearTimeout(scrollIdle.current); scrollIdle.current = window.setTimeout(() => setScrolling(false), 900); };
  useEffect(() => () => clearTimeout(scrollIdle.current), []);
  const [camera, setCamera] = useState<Camera>(() => home(world));
  const cameraRef = useRef(camera);
  useLayoutEffect(() => { cameraRef.current = camera; }, [camera]);
  const flight = useRef(0);
  /** Glide the camera, interpolating the visible box so the zoom feels linear. With reduced motion it has already landed. */
  const flyTo = (target: Camera) => {
    cancelAnimationFrame(flight.current);
    if (reducedMotion()) return;
    const from = cameraRef.current;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / 520), e = 1 - Math.pow(1 - p, 3);
      const span = 1 / (1 / from.zoom + (1 / target.zoom - 1 / from.zoom) * e);
      setCamera({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, zoom: span });
      if (p < 1) flight.current = requestAnimationFrame(step);
    };
    flight.current = requestAnimationFrame(step);
  };
  useEffect(() => () => cancelAnimationFrame(flight.current), []);
  /**
   * Zoom about a point of the pane, so what sits under the cursor or between the fingers stays put. The view never
   * shrinks below the whole statement, and zooming out keeps it inside the drawing, so zooming all the way out fits it.
   */
  const zoomAt = (factor: number, clientX: number, clientY: number) => {
    const rect = box.current?.querySelector("svg")?.getBoundingClientRect();
    if (!rect?.width || !rect.height || !Number.isFinite(factor) || factor <= 0) return;
    cancelAnimationFrame(flight.current);
    setCamera(c => {
      const zoom = Math.max(1, Math.min(MAX_ZOOM, c.zoom * factor));
      // viewBox is fitted with xMidYMid meet: the scale and letterbox offset that map the pane onto the drawing at a zoom.
      const fit = (z: number) => { const vw = worldW / z, vh = worldH / z, s = Math.min(rect.width / vw, rect.height / vh); return { vw, vh, s, ox: (rect.width - vw * s) / 2, oy: (rect.height - vh * s) / 2 }; };
      const before = fit(c.zoom), after = fit(zoom), px = clientX - rect.left, py = clientY - rect.top;
      let x = c.x + (px - before.ox) / before.s - (px - after.ox) / after.s, y = c.y + (py - before.oy) / before.s - (py - after.oy) / after.s;
      if (factor < 1) { x = Math.max(world.x0, Math.min(world.x1 - after.vw, x)); y = Math.max(world.y0, Math.min(world.y1 - after.vh, y)); }
      return { x, y, zoom };
    });
  };
  const zoomAtRef = useRef(zoomAt);
  useLayoutEffect(() => { zoomAtRef.current = zoomAt; });
  // The mouse wheel, a trackpad pinch (a ctrl-wheel in Chrome and Firefox, gesture events in Safari) zoom the chart, not the page.
  useEffect(() => {
    const element = box.current;
    if (!element || inline) return;
    let gesture: number | null = null;
    const onWheel = (e: WheelEvent) => {
      if (scrollsSideways(element) || e.deltaY === 0) return;
      e.preventDefault();
      if (gesture != null) return;
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      zoomAtRef.current(Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY);
    };
    const onGesture = (e: Event) => {
      if (scrollsSideways(element)) return;
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      if (e.type === "gesturestart") gesture = 1;
      else if (e.type === "gestureend") gesture = null;
      else if (gesture != null) { zoomAtRef.current(g.scale / gesture, g.clientX, g.clientY); gesture = g.scale; }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) element.addEventListener(type, onGesture);
    return () => {
      element.removeEventListener("wheel", onWheel);
      for (const type of ["gesturestart", "gesturechange", "gestureend"]) element.removeEventListener(type, onGesture);
    };
  }, [inline]);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; pointerId: number } | null>(null);
  // Two fingers on a touch screen pinch-zoom about their midpoint.
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const release = (pointerId: number) => {
    touches.current.delete(pointerId);
    if (touches.current.size < 2) pinch.current = null;
    if (drag.current?.pointerId === pointerId) drag.current = null;
  };
  // A picked business brings its own part of the statement into view; the pane refits when the explanation opens, so follow the layout.
  const focusCamera = useMemo(() => {
    // Narrow layouts scroll the full-size statement sideways instead of zooming it.
    const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 960px)").matches;
    const own = productBusiness && fitted && !narrow ? focusBounds(fitted.layout, productBusiness, copy, fitted.k) : null;
    if (!own) return home(world);
    if (!mind) return cameraFor(own, world, size);
    // With a breakdown, the frame takes it and the business's path into revenue; type never grows past the plain focus.
    return cameraFor(union(own, mind.box), world, size, FOCUS_ZOOM * Math.max(worldW / fitted!.layout.width, worldH / fitted!.layout.height));
  }, [productBusiness, fitted, copy, size, mind, world, worldW, worldH]);
  // With reduced motion a new focus (or the same one revealed again) is landed on in the render that brings it.
  const [aimed, setAimed] = useState<{ camera: Camera; key: string } | null>(null);
  if (aimed?.camera !== focusCamera || aimed.key !== revealKey) {
    setAimed({ camera: focusCamera, key: revealKey });
    if (reducedMotion()) setCamera(focusCamera);
  }
  useEffect(() => { if (!inline) { drag.current = null; flyTo(focusCamera); } }, [focusCamera, revealKey, inline]);
  const cameraForView = inline ? home(world) : camera;
  const viewportWidth = worldW / cameraForView.zoom, viewportHeight = worldH / cameraForView.zoom;
  const chartHeight = inline ? worldH * Math.max(size?.w ?? 0, worldW) / worldW : size?.h ?? 0;


  const bands: Band[] = useMemo(() => layout.links.map(l => {
    const s = byName.get(l.source)!, t = byName.get(l.target)!;
    // A band belongs to the business feeding revenue, or to the profit/cost it produces after revenue.
    const owner = (l.target === "revenue" || l.target === "segment-total") || t.segmentId ? l.source : l.target;
    return { x0: s.x + w, x1: t.x, sy: l.sy, ty: l.ty, h: l.h, key: linkKey(l), owner, color: colorOf(owner) };
  }), [layout, byName, w, colorOf]);

  const focus = useMemo(() => {
    if (!active || active === "revenue" || !byName.has(active)) return null;
    const nodes = new Set([active]), links = new Set<string>();
    const walk = (name: string, up: boolean) => {
      if ((name === "revenue" || name === "segment-total") && name !== active) return;
      for (const l of layout.links) {
        if ((up ? l.target : l.source) !== name) continue;
        links.add(linkKey(l));
        const next = up ? l.source : l.target;
        if (!nodes.has(next)) { nodes.add(next); walk(next, up); }
      }
    };
    walk(active, true);
    walk(active, false);
    // A business is traced as its own slice through every parent band until it reaches total revenue.
    const node = byName.get(active)!;
    const trace: Band[] = [];
    let slot: { y: number; h: number } | null = null;
    if (node.segmentId) {
      let link: PlacedLink | undefined = layout.links.find(l => l.source === active);
      let offset = 0;
      const h = link?.h ?? 0;
      while (link) {
        const s = byName.get(link.source)!, t = byName.get(link.target)!;
        trace.push({ x0: s.x + w, x1: t.x, sy: link.sy + offset, ty: link.ty + offset, h, key: "trace:" + linkKey(link), owner: active, color: colorOf(active) });
        if (link.target === "revenue" || link.target === "segment-total") { slot = { y: link.ty + offset, h }; break; }
        offset = link.ty + offset - t.y;
        link = layout.links.find(l => l.source === t.name);
      }
    }
    return { nodes, links, trace, slot, segment: Boolean(node.segmentId) };
  }, [active, byName, layout, w, colorOf]);

  // A hover or a picked business takes over; otherwise the finding's nodes and every band touching them stay lit.
  const lit = focus ? focus.nodes : spotlight && spotlight.size ? spotlight : null;
  const litLinks = focus ? focus.links : lit ? new Set(layout.links.filter(l => lit.has(l.source) || lit.has(l.target)).map(linkKey)) : null;
  const revenue = byName.get("segment-total") ?? byName.get("revenue");
  const point = (event: { clientX: number; clientY: number }, value: Tip) => {
    const rect = box.current?.getBoundingClientRect();
    if (rect) setTip({ x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, tip: value });
  };
  const slotLabel = focus?.slot && active ? focusSlot(byName.get(active)!) : null;
  // One delegated handler: focus follows whatever band or node is under the pointer, and clears over empty canvas.
  const hoverOver = (event: React.MouseEvent<SVGSVGElement>) => {
    const owner = (event.target as Element).closest<SVGElement>(".fc-node[data-owner]")?.dataset.owner ?? null;
    onHover(owner);
    if (!owner) setTip(null);
  };

  const mindTip = (event: React.MouseEvent, item: MindItem) => {
    const node = item.node;
    point(event, { title: node.name, color: colorOf(item.anchor), rows: [...(node.gloss ? [[m.description, node.gloss] as [string, string]] : []), ...(node.revenue.length ? [[m.revenueModel, node.revenue.map(r => r.label).join(", ")] as [string, string]] : []), ...(node.children.length ? [[m.contains, m.items(node.children.length)] as [string, string]] : [])] });
  };

  // The explanation is page text beside the canvas, not part of the scaled drawing: opening it narrows the pane and the Sankey refits.
  return <div className="fc" data-inline={inline || undefined} data-products={expanded || undefined} data-mind={mind ? "" : undefined}
    style={{ "--ratio": `${worldW} / ${worldH}`, "--inline-width": `${worldW}px`, "--mobile-width": `${Math.ceil(worldW * SCREEN_VALUE_PX / (22 * k))}px` } as CSSProperties}
    onMouseLeave={() => { setTip(null); onHover(null); }}>
    {expanded && productTarget && <aside key={productBusiness} className="fc-business-details" aria-label={m.details(productTarget.label)}>
      <div className="fc-business-scroll" tabIndex={0} data-scrolling={scrolling || undefined} onScroll={revealScrollbar}>{businessDetails}</div>
    </aside>}
    <div className="fc-canvas" ref={box}>
    {size && <svg key={revealKey} onPointerDown={e => {
        // Narrow layouts use native horizontal scrolling instead of capturing touch gestures.
        if (inline || box.current && scrollsSideways(box.current)) return;
        if (e.pointerType === "touch") {
          touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (touches.current.size === 2) {
            drag.current = null;
            cancelAnimationFrame(flight.current);
            for (const id of touches.current.keys()) { try { e.currentTarget.setPointerCapture(id); } catch { /* the pointer already lifted */ } }
            const [a, b] = [...touches.current.values()];
            pinch.current = Math.hypot(a.x - b.x, a.y - b.y);
            return;
          }
        }
        if ((e.target as Element).closest("[data-owner],[data-mind],a,button")) return;
        if (e.button !== 0 || drag.current) return;
        cancelAnimationFrame(flight.current);
        drag.current = { x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y, pointerId: e.pointerId };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch.current != null && touches.current.size === 2) {
          const [a, b] = [...touches.current.values()], distance = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinch.current > 0 && distance > 0) zoomAtRef.current(distance / pinch.current, (a.x + b.x) / 2, (a.y + b.y) / 2);
          pinch.current = distance;
          return;
        }
        const start = drag.current;
        if (!start || start.pointerId !== e.pointerId) return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const x = start.cx - (e.clientX - start.x) * viewportWidth / rect.width;
        const y = start.cy - (e.clientY - start.y) * viewportHeight / rect.height;
        // Capture coordinates now: React may run this updater after pointerup clears the ref.
        setCamera(c => ({ ...c, x, y }));
      }}
      onPointerUp={e => release(e.pointerId)} onPointerCancel={e => release(e.pointerId)} onLostPointerCapture={e => { if (drag.current?.pointerId === e.pointerId) drag.current = null; }} className="fc-svg" viewBox={`${cameraForView.x} ${cameraForView.y} ${viewportWidth} ${viewportHeight}`} preserveAspectRatio="xMidYMid meet" role="group" aria-label={label} onMouseOver={hoverOver}
      onClick={inline ? e => { if (!(e.target instanceof Element) || !e.target.closest("[data-owner]")) { setTip(null); onHover(null); } } : undefined}
      data-focus={focus ? (focus.segment ? "segment" : "path") : undefined}>
      <defs>
        {bands.map((b, i) => {
          const from = colorOf(b.key.split(">")[0]);
          return <linearGradient key={b.key} id={`${uid}g${i}`} gradientUnits="userSpaceOnUse" x1={b.x0} x2={b.x1} y1={0} y2={0}>
            <stop offset="0" style={{ stopColor: from }} /><stop offset="1" style={{ stopColor: b.color }} />
          </linearGradient>;
        })}
        <linearGradient id={`${uid}sheen`} gradientUnits="userSpaceOnUse" x1={0} x2={layout.width * 0.34} y1={0} y2={0} spreadMethod="repeat">
          <stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset=".72" stopColor="#fff" stopOpacity="0" />
          <stop offset=".9" stopColor="#fff" stopOpacity=".34" /><stop offset=".96" stopColor="#fff" stopOpacity="0" /><stop offset="1" stopColor="#fff" stopOpacity="0" />
          {!reducedMotion() && <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to={`${layout.width * 0.34} 0`} dur="2.4s" repeatCount="indefinite" />}
        </linearGradient>
        {/* The part of a bar past the comparison quarter's amount is striped; the stretch it no longer reaches is a hollow striped frame. */}
        <pattern id={`${uid}gain`} width={6 * k} height={6 * k} patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect className="fc-hatch-gain" width={2.4 * k} height={6 * k} /></pattern>
        <pattern id={`${uid}short`} width={6 * k} height={6 * k} patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect className="fc-hatch-short" width={1.4 * k} height={6 * k} /></pattern>
        <pattern id={`${uid}shortn`} width={6 * k} height={6 * k} patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect className="fc-hatch-short fc-hatch-neutral" width={1.4 * k} height={6 * k} /></pattern>
        <filter id={`${uid}glow`} x="-50%" y="-20%" width="200%" height="140%"><feGaussianBlur stdDeviation="6" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      <g>
        <g className="fc-bands">
          {bands.map((b, i) => <path key={b.key} className="fc-band" d={bandPath(b)} fill={`url(#${uid}g${i})`} data-owner={b.owner}
            // A business's own band picks it like its node; keyboard users reach the same pick on the node.
            data-pick={byName.get(b.owner)?.segmentId && !inline ? "" : undefined}
            onClick={inline ? e => { const l = layout.links[i]; point(e, { title: `${copy(byName.get(l.source)!).name} → ${copy(byName.get(l.target)!).name}`, color: b.color, rows: [[m.flow, money(l.value)]] }); } : byName.get(b.owner)?.segmentId ? () => onPick(byName.get(b.owner)!) : undefined}
            data-lit={litLinks ? (litLinks.has(b.key) ? (focus?.segment && focus.trace.some(t => t.key === "trace:" + b.key) ? "context" : "on") : undefined) : undefined}
            onMouseMove={e => { const l = layout.links[i]; point(e, { title: `${copy(byName.get(l.source)!).name} → ${copy(byName.get(l.target)!).name}`, color: b.color, rows: [[m.flow, money(l.value)]] }); }}
            onMouseLeave={() => setTip(null)} />)}
        </g>
        <g className="fc-trace">
          {focus?.trace.map(t => <path key={t.key} d={bandPath(t)} style={{ fill: t.color }} />)}
        </g>
        {focus && <g className="fc-sheen" key={active}>
          {[...bands.filter(b => focus.links.has(b.key) && !focus.trace.some(t => t.key === "trace:" + b.key)), ...focus.trace].map(b => <path key={b.key} d={bandPath(b)} fill={`url(#${uid}sheen)`} />)}
        </g>}
        <g className="fc-flow" aria-hidden="true">
          {focus
            ? [...bands.filter(b => focus.links.has(b.key) && !focus.trace.some(t => t.key === "trace:" + b.key)), ...focus.trace].map(b => <Streams key={b.key} band={b} strength="lit" />)
            : null}
        </g>
      </g>
      <g className="fc-nodes">
        {layout.nodes.map(n => {
          const text = copy(n), vs = valueSize(n, k), gap = geometryFor(k).labelOffset;
          const mark = markOf.get(n.name);
          const { x, y, valueY, anchor, box: labelBox } = nodeLabel(n, text, k, w);
          const stack = fitted?.stacked?.get(n.name);
          let lineY = stack && n.side === "top" ? n.y - inlineLabelHeight(stack) : n.y + n.h + INLINE_LABEL_GAP;
          const isLit = lit ? lit.has(n.name) || undefined : undefined;
          // The node in focus names its comparison amount beside the tick, where its own label does not sit.
          const prior = mark && n.name === active ? priorOf?.(n) ?? null : null;
          const priorText = prior != null && (n.side === "top" || n.side === "bottom" || mark!.tick < labelBox.y0 - type.change || mark!.tick > labelBox.y1 + type.change) ? `${basis.prior} ${money(prior)}` : null;
          const interactive = inline || Boolean(n.segmentId) || n.name === "revenue";
          const select = (event: { clientX: number; clientY: number }) => {
            if (!inline) { onPick(n); return; }
            onHover(n.name);
            point(event, tipFor(n));
          };
          return <g key={n.name} className="fc-node" data-tone={n.tone} data-net={n.name === "net" || undefined} data-lit={isLit} data-active={n.name === active || undefined}
            style={{ "--c": colorOf(n.name), "--d": `${n.column * 90 + 300}ms` } as CSSProperties}
            data-owner={n.name} onMouseMove={e => point(e, tipFor(n))} onMouseLeave={() => setTip(null)}
            {...(interactive ? { role: "button", tabIndex: 0, "aria-label": `${text.name} ${text.value}${text.change ? `, ${basis.change} ${text.change.label}` : ""}`, onClick: select, onKeyDown: (e: React.KeyboardEvent<SVGGElement>) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); select({ clientX: rect.x + rect.width / 2, clientY: rect.y }); } }, onFocus: (e: React.FocusEvent<SVGGElement>) => { onHover(n.name); const rect = e.currentTarget.getBoundingClientRect(); point({ clientX: rect.x + rect.width / 2, clientY: rect.y }, tipFor(n)); }, onBlur: () => { onHover(null); setTip(null); } } : {})}>
            <title>{n.label}: {text.value}</title>
            <rect className="fc-hit" x={n.x - 6} y={n.y - 4} width={w + 12} height={n.h + 8} />
            <rect className="fc-bar" x={n.x} y={n.y} width={w} height={n.h} rx={Math.min(3, n.h / 2)} />
            {mark && <g className="fc-prior" aria-hidden="true">
              {mark.gain && <rect x={n.x} y={r(mark.gain[0])} width={w} height={r(mark.gain[1] - mark.gain[0])} rx={Math.min(3, n.h / 2)} fill={`url(#${uid}gain)`} />}
              {mark.short && <rect className="fc-prior-short" x={n.x} y={r(mark.short[0])} width={w} height={r(mark.short[1] - mark.short[0])} fill={`url(#${uid}${n.tone === "expense" ? "shortn" : "short"})`} />}
              <path className="fc-prior-halo" d={`M${r(n.x - 5 * k)},${r(mark.tick)}H${r(n.x + w + 5 * k)}`} />
              <path className="fc-prior-tick" d={`M${r(n.x - 5 * k)},${r(mark.tick)}H${r(n.x + w + 5 * k)}`} />
              {priorText && !stack && <text className="fc-prior-label" x={r(n.side === "left" ? n.x - gap : n.x + w + gap)} y={r(mark.tick + type.change * 0.36)} textAnchor={n.side === "left" ? "end" : "start"} style={{ fontSize: type.change }}>{priorText}</text>}
            </g>}
            {stack ? <text className="fc-label" data-stacked textAnchor="middle">
              {stack.map((line, index) => {
                lineY += line.advance;
                return <tspan key={index} className={`fc-${line.kind}`} x={r(n.x + w / 2)} y={r(lineY - 3)}
                  data-trend={line.kind === "change" ? text.change?.trend : undefined} style={{ fontSize: line.size }}>{line.content}</tspan>;
              })}
            </text> : <text className="fc-label" textAnchor={anchor}>
              <tspan className="fc-name" x={r(x)} y={r(y)} style={{ fontSize: type.name }}>{text.name}</tspan>
              <tspan className="fc-value" x={r(x)} y={r(valueY)} style={{ fontSize: vs }}>{text.value}</tspan>{text.change && <tspan className="fc-change" dx={type.gap} data-trend={text.change.trend} style={{ fontSize: type.change }}>{text.change.label}</tspan>}
            </text>}
          </g>;
        })}
      </g>
      {mind && <MindLayer mind={mind} k={k} title={mindMap!.branches.filter(b => mind.trunks.some(tr => tr.anchor === b.node)).map(b => b.label).join("、")} colorOf={colorOf} picked={mindPick} onPick={id => onMindPick?.(id === mindPick ? null : mind.items.find(i => i.id === id) ?? null)} onTip={mindTip} onLeave={() => setTip(null)} />}
      {focus && <g className="fc-slots">
        {focus.trace.slice(0, -1).map(t => <rect key={t.key} x={t.x1} y={t.ty} width={w} height={Math.max(2, t.h)} rx={2} style={{ fill: t.color }} />)}
      </g>}
      {focus?.slot && revenue && <g className="fc-slot" key={active}>
        <rect className="fc-slot-glow" x={revenue.x - 4} y={focus.slot.y} width={w + 8} height={Math.max(2, focus.slot.h)} rx={3} style={{ fill: colorOf(active!) }} filter={`url(#${uid}glow)`} />
        {slotLabel && !fitted?.stacked && <g transform={`translate(${r(revenue.x + w + 10 * k)},${r(focus.slot.y + focus.slot.h / 2)})`}>
          <rect className="fc-slot-pill" x={0} y={-type.pill} width={estimateTextWidth(slotLabel, type.pill, true) + type.pill * 1.6} height={type.pill * 2} rx={type.pill} style={{ stroke: colorOf(active!) }} />
          <text className="fc-slot-text" x={type.pill * 0.8} y={type.pill * 0.38} style={{ fontSize: type.pill }}>{slotLabel}</text>
        </g>}
      </g>}
    </svg>}
    {tip && <Tooltip x={tip.x} y={tip.y} width={tip.width} height={chartHeight} inline={inline}>
      <div className="fc-tip-title"><i style={{ background: tip.tip.color }} />{tip.tip.title}</div>
      {tip.tip.rows.map(([k, v]) => <div className="fc-tip-row" key={k}><span>{k}</span><b>{v}</b></div>)}
    </Tooltip>}
    </div>
  </div>;
}

function Tooltip({ x, y, width, height, children, inline }: { x: number; y: number; width: number; height: number; children: ReactNode; inline: boolean }) {
  const flip = x > width - 240;
  const above = y > height - 180;
  if (inline) {
    const maxWidth = Math.min(288, width - 16);
    const left = Math.max(8, Math.min(x - maxWidth / 2, width - maxWidth - 8));
    return <div className="fc-tip" role="tooltip" style={{ left, width: maxWidth, top: above ? y - 10 : y + 10, transform: above ? "translateY(-100%)" : undefined }}>{children}</div>;
  }
  return <div className="fc-tip" role="tooltip" style={{ transform: `translate(${flip ? x - 16 : x + 16}px, ${above ? y - 16 : y + 16}px) translate(${flip ? "-100%" : "0"}, ${above ? "-100%" : "0"})` }}>{children}</div>;
}
