import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { FinancialGraph } from "@/lib/earning-report/web/business-flow-sankey";
import { estimateTextWidth, layoutInfographic, type InfographicLayout, type PlacedLink, type PlacedNode } from "@/lib/earning-report/web/business-flow-layout";

export type NodeCopy = { name: string; value: string };
export type Tip = { title: string; color: string; rows: Array<[string, string]> };

type Band = { x0: number; x1: number; sy: number; ty: number; h: number; color: string; key: string };

/** Type scale in layout units at k = 1; k is solved per pane so labels keep a constant on-screen size. */
const typeFor = (k: number) => ({ name: 14 * k, value: 21 * k, net: 26 * k, gap: 7 * k, offset: 9 * k, pill: 13 * k });
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

export function layoutFor(graph: FinancialGraph, copy: (n: PlacedNode) => NodeCopy, k = 1): InfographicLayout | null {
  const type = typeFor(k);
  return layoutInfographic(graph, n => {
    const text = copy(n);
    return estimateTextWidth(text.name, type.name) + type.gap + estimateTextWidth(text.value, valueSize(n, k), true) + 4 * k;
  }, geometryFor(k));
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

export function FlowChart({ graph, copy, money, colorOf, active, focusSlot, onHover, onPick, tipFor, label, revealKey }: {
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

  const bands: Band[] = useMemo(() => layout.links.map(l => {
    const s = byName.get(l.source)!, t = byName.get(l.target)!;
    return { x0: s.x + w, x1: t.x, sy: l.sy, ty: l.ty, h: l.h, key: linkKey(l), color: colorOf(l.target === "revenue" || t.segmentId ? l.source : l.target) };
  }), [layout, byName, w, colorOf]);

  const focus = useMemo(() => {
    if (!active || active === "revenue" || !byName.has(active)) return null;
    const nodes = new Set([active]), links = new Set<string>();
    const walk = (name: string, up: boolean) => {
      if (name === "revenue" && name !== active) return;
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
        trace.push({ x0: s.x + w, x1: t.x, sy: link.sy + offset, ty: link.ty + offset, h, key: "trace:" + linkKey(link), color: colorOf(active) });
        if (link.target === "revenue") { slot = { y: link.ty + offset, h }; break; }
        offset = link.ty + offset - t.y;
        link = layout.links.find(l => l.source === t.name);
      }
    }
    return { nodes, links, trace, slot, segment: Boolean(node.segmentId) };
  }, [active, byName, layout, w, colorOf]);

  const revenue = byName.get("revenue");
  const point = (event: { clientX: number; clientY: number }, value: Tip) => {
    const rect = box.current?.getBoundingClientRect();
    if (rect) setTip({ x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, tip: value });
  };
  const slotLabel = focus?.slot && active ? focusSlot(byName.get(active)!) : null;

  return <div className="fc" ref={box} style={{ "--ratio": `${layout.width} / ${layout.height}` } as CSSProperties} onMouseLeave={() => { setTip(null); onHover(null); }}>
    <svg key={revealKey} className="fc-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={label} data-focus={focus ? (focus.segment ? "segment" : "path") : undefined}>
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
          {bands.map((b, i) => <path key={b.key} className="fc-band" d={bandPath(b)} fill={`url(#${uid}g${i})`}
            data-lit={focus ? (focus.links.has(b.key) ? (focus.segment && focus.trace.some(t => t.key === "trace:" + b.key) ? "context" : "on") : undefined) : undefined}
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
          const lit = focus ? focus.nodes.has(n.name) || undefined : undefined;
          const interactive = Boolean(n.segmentId) || n.name === "revenue";
          return <g key={n.name} className="fc-node" data-tone={n.tone} data-net={n.name === "net" || undefined} data-lit={lit} data-active={n.name === active || undefined}
            style={{ "--c": colorOf(n.name), "--d": `${n.column * 90 + 300}ms` } as CSSProperties}
            onMouseEnter={() => onHover(n.name)} onMouseMove={e => point(e, tipFor(n))}
            {...(interactive ? { role: "button", tabIndex: 0, "aria-label": `${text.name} ${text.value}${n.segmentId ? "，在列表中选中" : "，显示全部业务"}`, onClick: () => onPick(n), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(n); } }, onFocus: () => onHover(n.name), onBlur: () => onHover(null) } : {})}>
            <rect className="fc-hit" x={n.x - 6} y={n.y - 4} width={w + 12} height={n.h + 8} />
            <rect className="fc-bar" x={n.x} y={n.y} width={w} height={n.h} rx={Math.min(3, n.h / 2)} />
            <text className="fc-label" x={r(x)} y={r(y)} textAnchor={anchor}>
              <tspan className="fc-name" style={{ fontSize: type.name }}>{text.name}</tspan><tspan className="fc-value" dx={type.gap} style={{ fontSize: vs }}>{text.value}</tspan>
            </text>
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
  </div>;
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const flip = x > width - 240;
  return <div className="fc-tip" role="presentation" style={{ transform: `translate(${flip ? x - 16 : x + 16}px, ${y + 16}px) translateX(${flip ? "-100%" : "0"})` }}>{children}</div>;
}
