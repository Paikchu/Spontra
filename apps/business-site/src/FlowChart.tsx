import type { ProductOffering } from "@/shared/analysis-contract/business-explainer";
import { Button } from "@/components/ui/button";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { FinancialGraph } from "@/lib/earning-report/web/business-flow-sankey";
import { estimateTextWidth, layoutInfographic, type InfographicLayout, type PlacedLink, type PlacedNode } from "@/lib/earning-report/web/business-flow-layout";

/** `change` is the comparable change against the prior quarter; absent when the two quarters cannot be compared. */
export type NodeCopy = { name: string; value: string; change?: { label: string; trend?: "up" | "down" } };
export type Tip = { title: string; color: string; rows: Array<[string, string]> };

type Band = { x0: number; x1: number; sy: number; ty: number; h: number; color: string; key: string; owner: string };

/** Type scale in layout units at k = 1; k is solved per pane so labels keep a constant on-screen size. */
const typeFor = (k: number) => ({ name: 14 * k, value: 21 * k, net: 26 * k, change: 13 * k, gap: 7 * k, offset: 9 * k, pill: 13 * k });
/** One-line labels need far less vertical room than the editorial two-line default, so the statement fits a wide pane. */
const geometryFor = (k: number) => ({ labelHeight: 34 * k, sideLabelHeight: 30 * k, gap: 14, lift: 46, drop: 40, labelGap: 22 * k, labelOffset: 12 * k, margin: 32 * k });
const SCREEN_VALUE_PX = 16;
const valueSize = (n: PlacedNode, k: number) => n.name === "net" ? typeFor(k).net : typeFor(k).value;
const EMPTY: InfographicLayout = { width: 1, height: 1, nodeWidth: 22, nodes: [], links: [] };
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
  return estimateTextWidth(text.name, type.name) + type.gap + estimateTextWidth(text.value, valueSize(n, k), true) + 4 * k
    + (text.change ? type.gap * 0.8 + estimateTextWidth(text.change.label, type.change, true) : 0);
}

export function layoutFor(graph: FinancialGraph, copy: (n: PlacedNode) => NodeCopy, k = 1): InfographicLayout | null {
  return layoutInfographic(graph, n => labelWidth(n, copy(n), k), geometryFor(k));
}

type Box = { x0: number; y0: number; x1: number; y1: number };
type Camera = { x: number; y: number; zoom: number };
const HOME: Camera = { x: 0, y: 0, zoom: 1 };
const FOCUS_ZOOM = 1.3;

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
  const type = typeFor(k), { labelOffset, sideLabelHeight } = geometryFor(k), w = layout.nodeWidth;
  const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const add = (x0: number, y0: number, x1: number, y1: number) => { box.x0 = Math.min(box.x0, x0); box.y0 = Math.min(box.y0, y0); box.x1 = Math.max(box.x1, x1); box.y1 = Math.max(box.y1, y1); };
  for (const key of names) {
    const n = byName.get(key)!, text = copy(n), lw = labelWidth(n, text, k), vs = valueSize(n, k);
    add(n.x, n.y, n.x + w, n.y + n.h);
    if (n.side === "top") add(n.x + w / 2 - lw / 2, n.y - type.offset - vs * 1.2, n.x + w / 2 + lw / 2, n.y);
    else if (n.side === "bottom") add(n.x + w / 2 - lw / 2, n.y + n.h, n.x + w / 2 + lw / 2, n.y + n.h + type.offset + vs * 1.2);
    else {
      const mid = n.y + Math.max(n.h, sideLabelHeight) / 2;
      if (n.side === "left") add(n.x - labelOffset - lw, mid - vs, n.x, mid + vs);
      else add(n.x + w, mid - vs, n.x + w + labelOffset + lw, mid + vs);
    }
    if (key === "revenue" || key === "segment-total") add(n.x, n.y, n.x + w + 150 * k, n.y + n.h);
  }
  const pad = 28 * k;
  return { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad };
}

/** The camera that fits `box` in a pane of `size`, given that the viewBox keeps the layout's aspect and is centred (xMidYMid meet). */
function cameraFor(box: Box, layout: InfographicLayout, size: { w: number; h: number } | null): Camera {
  const aspect = size ? size.w / size.h : layout.width / layout.height;
  const visibleW = Math.max(layout.width, layout.height * aspect), visibleH = Math.max(layout.height, layout.width / aspect);
  // A gentle push-in: enough to set the business apart, never so close that the rest of the statement leaves the frame.
  const zoom = Math.max(1, Math.min(FOCUS_ZOOM, visibleW / (box.x1 - box.x0), visibleH / (box.y1 - box.y0)));
  if (zoom < 1.05) return HOME;
  const vw = layout.width / zoom, vh = layout.height / zoom;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  return { x: clamp((box.x0 + box.x1) / 2 - vw / 2, layout.width - vw), y: clamp((box.y0 + box.y1) / 2 - vh / 2, layout.height - vh), zoom };
}

/** A few fixed-point steps: larger type widens the layout, which shrinks the fit scale, so k converges quickly. */
function fitLayout(graph: FinancialGraph, copy: (n: PlacedNode) => NodeCopy, size: { w: number; h: number } | null) {
  let k = 1, layout = layoutFor(graph, copy, k);
  if (!layout || !size) return layout && { layout, k };
  for (let i = 0; i < 5; i++) {
    const scale = Math.min(size.w / layout.width, size.h / layout.height);
    const next = Math.max(0.9, Math.min(1.3, SCREEN_VALUE_PX / (21 * scale)));
    if (Math.abs(next - k) < 0.02) break;
    k = next;
    layout = layoutFor(graph, copy, k)!;
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

export type Badge = { kind: "risk" | "strength" | "shift" | "watch"; severity: number; title: string };

export function FlowChart({ graph, copy, money, colorOf, active, focusSlot, onHover, onPick, tipFor, label, revealKey, businessDetails, productBusiness = null, spotlight = null, badges, onBadge }: {
  businessDetails?: ReactNode;
  productBusiness?: string | null;
  /** Nodes a finding is about: they and their bands stay lit while the rest of the statement recedes. */
  spotlight?: Set<string> | null;
  /** A mark beside each node a finding names, for the overview. */
  badges?: Map<string, Badge>;
  onBadge?: (name: string) => void;
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
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width / 8) * 8, h = Math.round(entry.contentRect.height / 8) * 8;
      if (w > 0 && h > 0) setSize(old => old?.w === w && old.h === h ? old : { w, h });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fitted = useMemo(() => fitLayout(graph, copy, size), [graph, copy, size]);
  const [tip, setTip] = useState<{ x: number; y: number; width: number; tip: Tip } | null>(null);
  const layout = fitted?.layout ?? EMPTY, k = fitted?.k ?? 1, type = typeFor(k);
  const byName = useMemo(() => new Map(layout.nodes.map(n => [n.name, n])), [layout]);
  const w = layout.nodeWidth;
  const productTarget = productBusiness ? byName.get(productBusiness) : null;
  const expanded = Boolean(productTarget);
  // The explanation's scrollbar stays hidden until the reader scrolls it, and fades shortly after.
  const [scrolling, setScrolling] = useState(false);
  const scrollIdle = useRef(0);
  const revealScrollbar = () => { setScrolling(true); clearTimeout(scrollIdle.current); scrollIdle.current = window.setTimeout(() => setScrolling(false), 900); };
  useEffect(() => () => clearTimeout(scrollIdle.current), []);
  const [camera, setCamera] = useState<Camera>(HOME);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const flight = useRef(0);
  /** Glide the camera, interpolating the visible box so the zoom feels linear. */
  const flyTo = (target: Camera) => {
    cancelAnimationFrame(flight.current);
    const from = cameraRef.current;
    if (reducedMotion()) { setCamera(target); return; }
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
  const zoomBy = (factor: number) => {
    cancelAnimationFrame(flight.current);
    setCamera(c => {
      const zoom = Math.max(.6, Math.min(3, c.zoom * factor));
      const cx = c.x + layout.width / c.zoom / 2, cy = c.y + layout.height / c.zoom / 2;
      return { x: cx - layout.width / zoom / 2, y: cy - layout.height / zoom / 2, zoom };
    });
  };
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; pointerId: number } | null>(null);
  // A picked business brings its own part of the statement into view; the pane refits when the explanation opens, so follow the layout.
  const focusCamera = useMemo(() => {
    // Narrow layouts scroll the full-size statement sideways instead of zooming it.
    const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 960px)").matches;
    const box = productBusiness && fitted && !narrow ? focusBounds(fitted.layout, productBusiness, copy, fitted.k) : null;
    return box ? cameraFor(box, fitted!.layout, size) : HOME;
  }, [productBusiness, fitted, copy, size]);
  useEffect(() => { drag.current = null; flyTo(focusCamera); }, [focusCamera, revealKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const viewportWidth = layout.width / camera.zoom, viewportHeight = layout.height / camera.zoom;


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
    const owner = (event.target as Element).closest<SVGElement>("[data-owner]")?.dataset.owner ?? null;
    onHover(owner);
    if (!owner) setTip(null);
  };

  // The explanation is page text beside the canvas, not part of the scaled drawing: opening it narrows the pane and the Sankey refits.
  return <div className="fc" data-products={expanded || undefined} style={{ "--ratio": `${layout.width} / ${layout.height}`, "--mobile-width": `${Math.ceil(layout.width * SCREEN_VALUE_PX / (21 * k))}px` } as CSSProperties} onMouseLeave={() => { setTip(null); onHover(null); }}>
    <div className="fc-controls"><Button variant="outline" size="sm" aria-label="缩小画布" onClick={() => zoomBy(1 / 1.2)}>−</Button><Button variant="outline" size="sm" onClick={() => flyTo(HOME)}>适应画布</Button>{productBusiness && <Button variant="outline" size="sm" onClick={() => flyTo(focusCamera)}>聚焦业务</Button>}<Button variant="outline" size="sm" aria-label="放大画布" onClick={() => zoomBy(1.2)}>+</Button></div>
    {expanded && productTarget && <aside key={productBusiness} className="fc-business-details" aria-label={`${productTarget.label} 业务说明`}>
      <div className="fc-business-scroll" tabIndex={0} data-scrolling={scrolling || undefined} onScroll={revealScrollbar}>{businessDetails}</div>
    </aside>}
    <div className="fc-canvas" ref={box}>
    <svg key={revealKey} onPointerDown={e => {
        if ((e.target as Element).closest("[data-owner],a,button")) return;
        // Narrow layouts use native horizontal scrolling instead of capturing touch gestures.
        const scroller = box.current?.closest(".chart");
        if (scroller && scroller.scrollWidth > scroller.clientWidth) return;
        if (e.button !== 0 || drag.current) return;
        cancelAnimationFrame(flight.current);
        drag.current = { x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y, pointerId: e.pointerId };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        const start = drag.current;
        if (!start || start.pointerId !== e.pointerId) return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const x = start.cx - (e.clientX - start.x) * viewportWidth / rect.width;
        const y = start.cy - (e.clientY - start.y) * viewportHeight / rect.height;
        // Capture coordinates now: React may run this updater after pointerup clears the ref.
        setCamera(c => ({ ...c, x, y }));
      }}
      onPointerUp={e => { if (drag.current?.pointerId === e.pointerId) drag.current = null; }} onPointerCancel={e => { if (drag.current?.pointerId === e.pointerId) drag.current = null; }} onLostPointerCapture={e => { if (drag.current?.pointerId === e.pointerId) drag.current = null; }} className="fc-svg" viewBox={`${camera.x} ${camera.y} ${viewportWidth} ${viewportHeight}`} preserveAspectRatio="xMidYMid meet" role="group" aria-label={label} onMouseOver={hoverOver} data-focus={focus ? (focus.segment ? "segment" : "path") : lit ? "spotlight" : undefined}>
      <defs>
        {bands.map((b, i) => {
          const from = colorOf(b.key.split(">")[0]);
          return <linearGradient key={b.key} id={`${uid}g${i}`} gradientUnits="userSpaceOnUse" x1={b.x0} x2={b.x1} y1={0} y2={0}>
            <stop offset="0" style={{ stopColor: from }} /><stop offset="1" style={{ stopColor: b.color }} />
          </linearGradient>;
        })}
        <clipPath id={`${uid}reveal`}><rect x={0} y={0} width={layout.width} height={layout.height}>{!reducedMotion() && <animate attributeName="width" from="0" to={layout.width} dur="1.4s" calcMode="spline" keyTimes="0;1" keySplines="0.22 1 0.36 1" fill="freeze" />}</rect></clipPath>
        <linearGradient id={`${uid}sheen`} gradientUnits="userSpaceOnUse" x1={0} x2={layout.width * 0.34} y1={0} y2={0} spreadMethod="repeat">
          <stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset=".72" stopColor="#fff" stopOpacity="0" />
          <stop offset=".9" stopColor="#fff" stopOpacity=".34" /><stop offset=".96" stopColor="#fff" stopOpacity="0" /><stop offset="1" stopColor="#fff" stopOpacity="0" />
          {!reducedMotion() && <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to={`${layout.width * 0.34} 0`} dur="2.4s" repeatCount="indefinite" />}
        </linearGradient>
        <filter id={`${uid}glow`} x="-50%" y="-20%" width="200%" height="140%"><feGaussianBlur stdDeviation="6" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      <g clipPath={`url(#${uid}reveal)`}>
        <g className="fc-bands">
          {bands.map((b, i) => <path key={b.key} className="fc-band" d={bandPath(b)} fill={`url(#${uid}g${i})`} data-owner={b.owner}
            // A business's own band picks it like its node; keyboard users reach the same pick on the node.
            {...(byName.get(b.owner)?.segmentId ? { "data-pick": "", onClick: () => onPick(byName.get(b.owner)!) } : {})}
            data-lit={litLinks ? (litLinks.has(b.key) ? (focus?.segment && focus.trace.some(t => t.key === "trace:" + b.key) ? "context" : "on") : undefined) : undefined}
            onMouseMove={e => { const l = layout.links[i]; point(e, { title: `${copy(byName.get(l.source)!).name} → ${copy(byName.get(l.target)!).name}`, color: b.color, rows: [["流量", money(l.value)]] }); }}
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
            : bands.map(b => <Streams key={b.key} band={b} strength="ambient" />)}
        </g>
      </g>
      <g className="fc-nodes">
        {layout.nodes.map(n => {
          const text = copy(n), vs = valueSize(n, k), side = Math.max(n.h, geometryFor(k).sideLabelHeight), gap = geometryFor(k).labelOffset;
          const [x, y, anchor]: [number, number, "start" | "middle" | "end"] = n.side === "top" ? [n.x + w / 2, n.y - type.offset - 2, "middle"]
            : n.side === "bottom" ? [n.x + w / 2, n.y + n.h + type.offset + vs * 0.78, "middle"]
            : [n.side === "left" ? n.x - gap : n.x + w + gap, n.y + side / 2 + vs * 0.36, n.side === "left" ? "end" : "start"];
          const isLit = lit ? lit.has(n.name) || undefined : undefined;
          const badge = badges?.get(n.name);
          const interactive = Boolean(n.segmentId) || n.name === "revenue";
          return <g key={n.name} className="fc-node" data-tone={n.tone} data-net={n.name === "net" || undefined} data-lit={isLit} data-active={n.name === active || undefined}
            style={{ "--c": colorOf(n.name), "--d": `${n.column * 90 + 300}ms` } as CSSProperties}
            data-owner={n.name} onMouseMove={e => point(e, tipFor(n))} onMouseLeave={() => setTip(null)}
            {...(interactive ? { role: "button", tabIndex: 0, "aria-label": `${text.name} ${text.value}${text.change ? ` 环比 ${text.change.label}` : ""}${n.segmentId ? "，在列表中选中" : "，显示全部业务"}`, onClick: () => onPick(n), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(n); } }, onFocus: () => onHover(n.name), onBlur: () => onHover(null) } : {})}>
            <rect className="fc-hit" x={n.x - 6} y={n.y - 4} width={w + 12} height={n.h + 8} />
            <rect className="fc-bar" x={n.x} y={n.y} width={w} height={n.h} rx={Math.min(3, n.h / 2)} />
            <text className="fc-label" x={r(x)} y={r(y)} textAnchor={anchor}>
              <tspan className="fc-name" style={{ fontSize: type.name }}>{text.name}</tspan><tspan className="fc-value" dx={type.gap} style={{ fontSize: vs }}>{text.value}</tspan>{text.change && <tspan className="fc-change" dx={type.gap * 0.8} data-trend={text.change.trend} style={{ fontSize: type.change }}>{text.change.label}</tspan>}
            </text>
            {badge && !lit && <g className="fc-badge" data-kind={badge.kind} transform={`translate(${r(n.x + w + 2)},${r(n.y - 2)})`} role="button" tabIndex={0} aria-label={`要点：${badge.title}`}
              onClick={e => { e.stopPropagation(); onBadge?.(n.name); }} onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onBadge?.(n.name); } }}>
              <circle r={9 * k} /><text y={3.4 * k} textAnchor="middle" style={{ fontSize: 10 * k }}>{badge.severity}</text>
            </g>}
          </g>;
        })}
      </g>
      {focus && <g className="fc-slots">
        {focus.trace.slice(0, -1).map(t => <rect key={t.key} x={t.x1} y={t.ty} width={w} height={Math.max(2, t.h)} rx={2} style={{ fill: t.color }} />)}
      </g>}
      {focus?.slot && revenue && <g className="fc-slot" key={active}>
        <rect className="fc-slot-glow" x={revenue.x - 4} y={focus.slot.y} width={w + 8} height={Math.max(2, focus.slot.h)} rx={3} style={{ fill: colorOf(active!) }} filter={`url(#${uid}glow)`} />
        {slotLabel && <g transform={`translate(${r(revenue.x + w + 10 * k)},${r(focus.slot.y + focus.slot.h / 2)})`}>
          <rect className="fc-slot-pill" x={0} y={-type.pill} width={estimateTextWidth(slotLabel, type.pill, true) + type.pill * 1.6} height={type.pill * 2} rx={type.pill} style={{ stroke: colorOf(active!) }} />
          <text className="fc-slot-text" x={type.pill * 0.8} y={type.pill * 0.38} style={{ fontSize: type.pill }}>{slotLabel}</text>
        </g>}
      </g>}
    </svg>
    {tip && <Tooltip x={tip.x} y={tip.y} width={tip.width}>
      <div className="fc-tip-title"><i style={{ background: tip.tip.color }} />{tip.tip.title}</div>
      {tip.tip.rows.map(([k, v]) => <div className="fc-tip-row" key={k}><span>{k}</span><b>{v}</b></div>)}
    </Tooltip>}
    </div>
  </div>;
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const flip = x > width - 240;
  return <div className="fc-tip" role="presentation" style={{ transform: `translate(${flip ? x - 16 : x + 16}px, ${y + 16}px) translateX(${flip ? "-100%" : "0"})` }}>{children}</div>;
}

/** Shared qualitative product relationships, including financial/insurance fallback views. */
export function ProductBranches({ target, offerings }: { target: { x: number; y: number; h: number; label: string }; offerings: ProductOffering[] }) {
  return <g className="fc-products" transform={`translate(${target.x},0)`} aria-label="产品到业务的归属关系">
        <text x={-670} y={28}>产品</text><text x={-410} y={28}>收入模式</text><text x={-205} y={28}>产品线</text>
        {offerings.length ? <>
          {offerings.map((p, i) => {
            const y = 56 + i * 94;
            const siblings = offerings.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.line === p.line);
            const lineY = 81 + siblings.reduce((sum, { index }) => sum + index * 94, 0) / siblings.length;
            return <g key={p.id}>
              <path className="fc-product-link" d={linePath(-420, y + 25, -210, lineY)} />
              <foreignObject x={-670} y={y} width={250} height={88}><div className="fc-product-card" title={p.description.text}><strong>{p.name}</strong><span>{p.description.text}</span></div></foreignObject>
              <foreignObject x={-410} y={y + 6} width={190} height={76}><div className="fc-charging" title={p.charging?.text ?? "收费模式未核实"}>{p.charging?.text ?? "收费模式未核实"}</div></foreignObject>
              <title>{p.name} → {p.line ?? "产品线未核实"} → {target.label}；{p.charging?.text ?? "收费模式未核实"}</title>
            </g>;
          })}
          {[...new Set(offerings.map(p => p.line))].map(line => {
            const indices = offerings.flatMap((p, i) => p.line === line ? [i] : []);
            const y = 81 + indices.reduce((sum, i) => sum + i * 94, 0) / indices.length;
            return <g key={line ?? "unknown"}><path className="fc-product-link" d={linePath(-30, y, 0, target.y + target.h / 2)} /><foreignObject x={-210} y={y - 25} width={180} height={76}><div className="fc-product-line"><strong>{line ?? "产品线未核实"}</strong></div></foreignObject></g>;
          })}
        </> : <foreignObject x={-670} y={65} width={420} height={100}><div className="fc-product-card">该业务暂无可溯源的产品映射</div></foreignObject>}
  </g>;

}
