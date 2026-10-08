import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { estimateTextWidth } from "@/lib/earning-report/web/business-flow-layout";
import type { Pool, PoolItem, PoolTone } from "./capital-model";

const TONE: Record<PoolTone, string> = {
  own: "var(--flow-profit)", debt: "var(--flow-expense)", lease: "color-mix(in srgb, var(--flow-expense) 55%, var(--biz-0))",
  customer: "var(--biz-1)", payable: "var(--biz-0)", equity: "var(--biz-3)", deficit: "var(--loss)", returned: "var(--biz-2)",
  productive: "var(--biz-4)", cash: "var(--chart-1)", invest: "var(--chart-4)", other: "var(--biz-0)",
};
export const toneColor = (tone: PoolTone) => TONE[tone];
/** Legend names describe the role, not one item, since several items share a tone. */
export const TONE_LABEL: Record<PoolTone, string> = {
  own: "经营与留存", debt: "借款", lease: "租赁", customer: "客户预付", payable: "应付与应计", equity: "股东资金", deficit: "亏损与消耗",
  returned: "回报股东", productive: "设备与资本开支", cash: "现金", invest: "投资", other: "其他",
};
const BAR = 16, SLOT = 40, GAP = 10, TOP = 44, BOTTOM = 12, NAME = 12.5, VALUE = 16;
type Placed = PoolItem & { side: "source" | "use"; x: number; y: number; h: number; poolY: number };
const r = (v: number) => Math.round(v * 10) / 10;

/** Items that carry the story are never folded into "other" once they are visible at all; a deficit never is. */
const KEEP: PoolTone[] = ["own", "debt", "customer", "equity", "returned"];

/** When a side has more items than label slots fit, only its smallest supporting items fold into one, just enough to fit. */
function fit(items: PoolItem[], room: number, total: number): PoolItem[] {
  const capacity = Math.max(3, Math.floor((room + GAP) / (SLOT + GAP)));
  if (items.length <= capacity) return items;
  const keep = (i: PoolItem) => i.tone === "deficit" || (KEEP.includes(i.tone) && i.value >= total * 0.01);
  const foldable = items.filter(i => !keep(i)).sort((a, b) => a.value - b.value);
  const fold = new Set(foldable.slice(0, items.length - capacity + 1).map(i => i.key));
  if (fold.size < 2) return items;
  const folded = items.filter(i => fold.has(i.key));
  const merged: PoolItem = { key: "folded", label: `其他 ${folded.length} 项`, tone: "other", value: folded.reduce((s, i) => s + i.value, 0), lines: folded.map(i => ({ label: i.label, value: i.value })) };
  return [...items.filter(i => !fold.has(i.key)), merged];
}

function layoutPool(full: Pool, width: number, height: number, money: (v: number) => string) {
  const room = Math.max(120, height - TOP - BOTTOM);
  const pool = { ...full, sources: fit(full.sources, room, full.total), uses: fit(full.uses, room, full.total) };
  const labelWidth = (item: PoolItem) => Math.max(estimateTextWidth(item.label, NAME), estimateTextWidth(money(item.value) + " 00%", VALUE, true));
  const side = Math.min(width * 0.3, Math.max(110, ...[...pool.sources, ...pool.uses].map(labelWidth)) + 14);
  const avail = Math.max(120, height - TOP - BOTTOM);
  const need = (items: PoolItem[], scale: number) => items.reduce((sum, item) => sum + Math.max(item.value * scale, SLOT), 0) + GAP * Math.max(0, items.length - 1);
  // The largest scale at which both sides, with their label slots, fit; label slots alone always fit after folding.
  let low = 0, high = avail / Math.max(pool.total, 1e-9);
  for (let i = 0; i < 30; i++) { const mid = (low + high) / 2; if (Math.max(need(pool.sources, mid), need(pool.uses, mid)) <= avail) low = mid; else high = mid; }
  const scale = low;
  const poolH = pool.total * scale, poolY = TOP + (avail - poolH) / 2;
  const left = side, center = width / 2 - BAR / 2, right = width - side - BAR;
  const stack = (items: PoolItem[], kind: Placed["side"], x: number): Placed[] => {
    let y = TOP + (avail - need(items, scale)) / 2, into = poolY;
    return items.map(item => {
      const h = Math.max(2, item.value * scale), slot = Math.max(h, SLOT);
      const placed = { ...item, side: kind, x, y: y + (slot - h) / 2, h, poolY: into };
      y += slot + GAP; into += item.value * scale;
      return placed;
    });
  };
  return { scale, poolH, poolY, center, nodes: [...stack(pool.sources, "source", left), ...stack(pool.uses, "use", right)] };
}

function band(x0: number, y0: number, x1: number, y1: number, h0: number, h1: number) {
  const xm = (x0 + x1) / 2;
  return `M${r(x0)},${r(y0)}C${r(xm)},${r(y0)} ${r(xm)},${r(y1)} ${r(x1)},${r(y1)}L${r(x1)},${r(y1 + h1)}C${r(xm)},${r(y1 + h1)} ${r(xm)},${r(y0 + h0)} ${r(x0)},${r(y0 + h0)}Z`;
}

/**
 * Sources on the left fill one pool; uses on the right drain it. Both sides add up to the same total,
 * so every band is a disclosed amount, and a loss or a cash draw-down appears as a source or use, never a gap.
 */
export function PoolChart({ pool, money, label, spotlight = null }: { pool: Pool; money: (v: number) => string; label: string;
  /** Item keys a finding is about; they stay lit while the pointer is elsewhere. */
  spotlight?: Set<string> | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 960, h: 520 });
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width), h = Math.round(entry.contentRect.height);
      if (w > 0 && h > 0) setSize(old => old.w === w && old.h === h ? old : { w, h });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => layoutPool(pool, size.w, size.h, money), [pool, size, money]);
  const [active, setActive] = useState<string | null>(null);
  const lit = (key: string) => active ? active === key : Boolean(spotlight?.has(key));
  const focused = active || (spotlight && layout.nodes.some(n => spotlight.has(n.key)));
  const [tip, setTip] = useState<{ x: number; y: number; item: Placed } | null>(null);
  const share = (v: number) => pool.total ? `${Math.round(v / pool.total * 100)}%` : "";
  const point = (event: React.MouseEvent, item: Placed) => {
    const rect = box.current!.getBoundingClientRect();
    setTip({ x: event.clientX - rect.left, y: event.clientY - rect.top, item });
  };
  return <div className="pool">
    <div className="pool-canvas" ref={box}>
      <svg className="fc-svg pool-svg" viewBox={`0 0 ${size.w} ${size.h}`} role="img" aria-label={label} data-focus={focused ? "" : undefined}>
        <g>
          {layout.nodes.map(n => {
            const d = n.side === "source"
              ? band(n.x + BAR, n.y, layout.center, n.poolY, n.h, n.value * layout.scale)
              : band(layout.center + BAR, n.poolY, n.x, n.y, n.value * layout.scale, n.h);
            return <path key={n.key} className="fc-band" d={d} style={{ fill: TONE[n.tone] }} data-lit={lit(n.key) ? "on" : undefined}
              onMouseMove={e => { setActive(n.key); point(e, n); }} onMouseLeave={() => { setActive(null); setTip(null); }} />;
          })}
        </g>
        <g className="fc-node pool-total" style={{ "--c": "var(--flow-revenue)" } as CSSProperties}>
          <rect className="fc-bar" x={layout.center} y={layout.poolY} width={BAR} height={Math.max(2, layout.poolH)} rx={3} />
          <text className="fc-label" x={r(layout.center + BAR / 2)} y={r(layout.poolY - 12)} textAnchor="middle">
            <tspan className="fc-name" style={{ fontSize: NAME + 1 }}>{pool.title}</tspan><tspan className="fc-value" dx={8} style={{ fontSize: VALUE + 4 }}>{money(pool.total)}</tspan>
          </text>
        </g>
        {layout.nodes.map(n => {
          const mid = n.y + n.h / 2, x = n.side === "source" ? n.x - 10 : n.x + BAR + 10, anchor = n.side === "source" ? "end" : "start";
          return <g key={n.key} className="fc-node" data-tone={n.tone} data-lit={lit(n.key) ? "" : undefined} style={{ "--c": TONE[n.tone] } as CSSProperties}
            onMouseMove={e => { setActive(n.key); point(e, n); }} onMouseLeave={() => { setActive(null); setTip(null); }}>
            <title>{`${n.label} ${money(n.value)}，占${pool.title} ${share(n.value)}`}</title>
            <rect className="fc-hit" x={n.x - 6} y={Math.min(n.y, mid - SLOT / 2)} width={BAR + 12} height={Math.max(n.h, SLOT)} />
            <rect className="fc-bar" x={n.x} y={n.y} width={BAR} height={n.h} rx={Math.min(3, n.h / 2)} />
            <text className="fc-label" x={r(x)} y={r(mid - 4)} textAnchor={anchor}><tspan className="fc-name" style={{ fontSize: NAME }}>{n.label}</tspan></text>
            <text className="fc-label" x={r(x)} y={r(mid + VALUE - 1)} textAnchor={anchor}>
              <tspan className="fc-value" style={{ fontSize: VALUE }}>{money(n.value)}</tspan><tspan className="fc-change pool-share" dx={6} style={{ fontSize: 12 }}>{share(n.value)}</tspan>
            </text>
          </g>;
        })}
      </svg>
      {tip && <div className="fc-tip" role="presentation" style={{ transform: `translate(${tip.x > size.w - 260 ? tip.x - 16 : tip.x + 16}px, ${tip.y + 16}px) translateX(${tip.x > size.w - 260 ? "-100%" : "0"})` }}>
        <div className="fc-tip-title"><i style={{ background: TONE[tip.item.tone] }} />{tip.item.label}</div>
        <div className="fc-tip-row"><span>金额</span><b>{money(tip.item.value)}</b></div>
        <div className="fc-tip-row"><span>占{pool.title}</span><b>{share(tip.item.value)}</b></div>
        {tip.item.lines.length > 1 || (tip.item.lines.length === 1 && tip.item.lines[0].label !== tip.item.label)
          ? tip.item.lines.slice(0, 8).map((line, i) => <div className="fc-tip-row pool-tip-line" key={i}><span>{line.label}</span><b>{money(line.value)}</b></div>) : null}
      </div>}
    </div>
  </div>;
}
