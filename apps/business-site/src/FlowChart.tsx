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

export function layoutFor(graph: FinancialGraph, copy: (n: PlacedNode) => NodeCopy, k = 1): InfographicLayout | null {
  const type = typeFor(k);
  return layoutInfographic(graph, n => {
    const text = copy(n);
    return estimateTextWidth(text.name, type.name) + type.gap + estimateTextWidth(text.value, valueSize(n, k), true) + 4 * k
      + (text.change ? type.gap * 0.8 + estimateTextWidth(text.change.label, type.change, true) : 0);
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

export function FlowChart({ graph, copy, money, colorOf, active, focusSlot, onHover, onPick, tipFor, label, revealKey, businessDetails, productBusiness = null, onCloseProducts }: {
  businessDetails?: ReactNode;
  productBusiness?: string | null;
  onCloseProducts?: () => void;
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
  const [left, setLeft] = useState(0);
  const leftPosition = useRef(0);
  useEffect(() => {
    const target = expanded ? 700 : 0;
    if (reducedMotion()) { leftPosition.current = target; setLeft(target); return; }
    const origin = leftPosition.current, start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / 350);
      leftPosition.current = origin + (target - origin) * (1 - Math.pow(1 - p, 3));
      setLeft(leftPosition.current);
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [expanded]);
  const canvasHeight = expanded ? Math.max(size && size.w < 600 ? 900 : 640, layout.height) : layout.height;
  const [focusX, setFocusX] = useState(0);
  const focusPosition = useRef(0);
  useEffect(() => {
    const target = productTarget?.x ?? 0;
    if (reducedMotion()) { focusPosition.current = target; setFocusX(target); return; }
    const origin = focusPosition.current, start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / 350);
      focusPosition.current = origin + (target - origin) * (1 - Math.pow(1 - p, 3));
      setFocusX(focusPosition.current);
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [productTarget?.x]);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [fitAll, setFitAll] = useState(false);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; pointerId: number } | null>(null);
  useEffect(() => { drag.current = null; setCamera({ x: 0, y: 0, zoom: 1 }); setFitAll(false); }, [productBusiness, revealKey]);
  const progress = left / 700;
  const viewportWidth = (fitAll ? layout.width + left : layout.width + ((size && size.w < 600 ? size.w : Math.max(1000, size?.w ?? 1000)) - layout.width) * progress) / camera.zoom;
  const viewportX = fitAll ? -left : (focusX - 700) * progress;
  const viewportHeight = (fitAll ? Math.max(canvasHeight, layout.height) : canvasHeight) / camera.zoom;


  const bands: Band[] = useMemo(() => layout.links.map(l => {
    const s = byName.get(l.source)!, t = byName.get(l.target)!;
    // A band belongs to the business feeding revenue, or to the profit/cost it produces after revenue.
    const owner = l.target === "revenue" || t.segmentId ? l.source : l.target;
    return { x0: s.x + w, x1: t.x, sy: l.sy, ty: l.ty, h: l.h, key: linkKey(l), owner, color: colorOf(owner) };
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
        trace.push({ x0: s.x + w, x1: t.x, sy: link.sy + offset, ty: link.ty + offset, h, key: "trace:" + linkKey(link), owner: active, color: colorOf(active) });
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
  // One delegated handler: focus follows whatever band or node is under the pointer, and clears over empty canvas.
  const hoverOver = (event: React.MouseEvent<SVGSVGElement>) => {
    const owner = (event.target as Element).closest<SVGElement>("[data-owner]")?.dataset.owner ?? null;
    onHover(owner);
    if (!owner) setTip(null);
  };

  return <div className="fc" data-products={expanded || undefined} ref={box} style={{ "--ratio": `${layout.width} / ${layout.height}` } as CSSProperties} onMouseLeave={() => { setTip(null); onHover(null); }}>
    <div className="fc-controls"><Button variant="outline" size="sm" aria-label="缩小画布" onClick={() => setCamera(c => ({ ...c, zoom: Math.max(.6, c.zoom / 1.2) }))}>−</Button><Button variant="outline" size="sm" onClick={() => { setFitAll(true); setCamera({ x: 0, y: 0, zoom: 1 }); }}>适应画布</Button><Button variant="outline" size="sm" aria-label="放大画布" onClick={() => setCamera(c => ({ ...c, zoom: Math.min(3, c.zoom * 1.2) }))}>+</Button>{expanded && <Button variant="outline" size="sm" onClick={onCloseProducts}>收起说明</Button>}</div>
    <svg key={revealKey} onPointerDown={e => {
        if ((e.target as Element).closest("[data-owner],a,button,.fc-business-details")) return;
        if (e.button !== 0 || drag.current) return;
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
      onPointerUp={e => { if (drag.current?.pointerId === e.pointerId) drag.current = null; }} onPointerCancel={e => { if (drag.current?.pointerId === e.pointerId) drag.current = null; }} onLostPointerCapture={e => { if (drag.current?.pointerId === e.pointerId) drag.current = null; }} className="fc-svg" viewBox={`${viewportX + camera.x} ${camera.y} ${viewportWidth} ${viewportHeight}`} preserveAspectRatio="xMidYMid meet" role="group" aria-label={label} onMouseOver={hoverOver} data-focus={focus ? (focus.segment ? "segment" : "path") : undefined}>
      {expanded && productTarget && <foreignObject x={productTarget.x - 670} y={48} width={Math.min(450, (size?.w ?? 1000) - 48)} height={canvasHeight - 72}>
        <div key={productBusiness} className="fc-business-details" tabIndex={0} role="region" aria-label={`${productTarget.label} 业务说明`}>{businessDetails}</div>
      </foreignObject>}
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
            data-owner={n.name} onMouseMove={e => point(e, tipFor(n))} onMouseLeave={() => setTip(null)}
            {...(interactive ? { role: "button", tabIndex: 0, "aria-label": `${text.name} ${text.value}${text.change ? ` 环比 ${text.change.label}` : ""}${n.segmentId ? "，在列表中选中" : "，显示全部业务"}`, onClick: () => onPick(n), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(n); } }, onFocus: () => onHover(n.name), onBlur: () => onHover(null) } : {})}>
            <rect className="fc-hit" x={n.x - 6} y={n.y - 4} width={w + 12} height={n.h + 8} />
            <rect className="fc-bar" x={n.x} y={n.y} width={w} height={n.h} rx={Math.min(3, n.h / 2)} />
            <text className="fc-label" x={r(x)} y={r(y)} textAnchor={anchor}>
              <tspan className="fc-name" style={{ fontSize: type.name }}>{text.name}</tspan><tspan className="fc-value" dx={type.gap} style={{ fontSize: vs }}>{text.value}</tspan>{text.change && <tspan className="fc-change" dx={type.gap * 0.8} data-trend={text.change.trend} style={{ fontSize: type.change }}>{text.change.label}</tspan>}
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
