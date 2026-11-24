import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, useEffect } from "react";
import { peekChartBox } from "./chart-box";
import { estimateTextWidth } from "@/packages/web/src/model/business-flow-layout";
import type { Pool, PoolItem, PoolTone } from "./capital-model";
import { messages } from "@/packages/web/src/i18n";
import { markContent } from "./vitals";

const m = messages({
  folded: (n: number) => `${n} other items`, amount: "Amount",
  shareOf: (title: string) => `Share of ${title.toLowerCase()}`,
  itemTitle: (label: string, money: string, share: string, title: string) => `${label} ${money}, ${share} of ${title.toLowerCase()}`,
}, {
  folded: (n: number) => `其他 ${n} 项`, amount: "金额",
  shareOf: (title: string) => `占${title}比例`,
  itemTitle: (label: string, money: string, share: string, title: string) => `${label} ${money}，占${title} ${share}`,
});

const TONE: Record<PoolTone, string> = {
  own: "var(--flow-profit)", debt: "var(--flow-expense)", lease: "color-mix(in srgb, var(--flow-expense) 55%, var(--biz-0))",
  customer: "var(--biz-1)", payable: "var(--biz-0)", equity: "var(--biz-3)", deficit: "var(--loss)", returned: "var(--biz-2)",
  productive: "var(--biz-4)", cash: "var(--chart-1)", invest: "var(--chart-4)", other: "var(--biz-0)",
};
const BAR = 16, SLOT = 40, GAP = 10, TOP = 44, BOTTOM = 12, NAME = 12.5, VALUE = 16;
const COMPACT_SLOT = 64;
type Placed = PoolItem & { side: "source" | "use"; x: number; y: number; h: number; poolY: number };
const r = (v: number) => Math.round(v * 10) / 10;

/** Items that carry the story are never folded into "other" once they are visible at all; a deficit never is. */
const KEEP: PoolTone[] = ["own", "debt", "customer", "equity", "returned"];

/** When a side has more items than label slots fit, only its smallest supporting items fold into one, just enough to fit; the merged key names its side so both sides can fold. */
function fit(items: PoolItem[], room: number, total: number, side: Placed["side"]): PoolItem[] {
  const capacity = Math.max(3, Math.floor((room + GAP) / (SLOT + GAP)));
  if (items.length <= capacity) return items;
  const keep = (i: PoolItem) => i.tone === "deficit" || (KEEP.includes(i.tone) && i.value >= total * 0.01);
  const foldable = items.filter(i => !keep(i)).sort((a, b) => a.value - b.value);
  const fold = new Set(foldable.slice(0, items.length - capacity + 1).map(i => i.key));
  if (fold.size < 2) return items;
  const folded = items.filter(i => fold.has(i.key));
  const merged: PoolItem = { key: `folded-${side}`, label: m.folded(folded.length), tone: "other", value: folded.reduce((s, i) => s + i.value, 0), lines: folded.map(i => ({ label: i.label, value: i.value })) };
  return [...items.filter(i => !fold.has(i.key)), merged];
}

function layoutPool(full: Pool, width: number, height: number, money: (v: number) => string, compact: boolean) {
  const room = Math.max(120, height - TOP - BOTTOM);
  const pool = compact ? full : { ...full, sources: fit(full.sources, room, full.total, "source"), uses: fit(full.uses, room, full.total, "use") };
  const labelWidth = (item: PoolItem) => Math.max(estimateTextWidth(item.label, NAME), estimateTextWidth(money(item.value) + " 00%", VALUE, true));
  const side = compact ? width * 0.32 : Math.min(width * 0.3, Math.max(110, ...[...pool.sources, ...pool.uses].map(labelWidth)) + 14);
  const bar = compact ? 8 : BAR, minSlot = compact ? COMPACT_SLOT : SLOT;
  const avail = room;
  const need = (items: PoolItem[], scale: number) => items.reduce((sum, item) => sum + Math.max(item.value * scale, minSlot), 0) + GAP * Math.max(0, items.length - 1);
  // The largest scale at which both sides, with their label slots, fit; label slots alone always fit after folding.
  let low = 0, high = avail / Math.max(pool.total, 1e-9);
  for (let i = 0; i < 30; i++) { const mid = (low + high) / 2; if (Math.max(need(pool.sources, mid), need(pool.uses, mid)) <= avail) low = mid; else high = mid; }
  const scale = low;
  const poolH = pool.total * scale, poolY = TOP + (avail - poolH) / 2;
  const left = side, center = width / 2 - bar / 2, right = width - side - bar;
  const stack = (items: PoolItem[], kind: Placed["side"], x: number): Placed[] => {
    let y = TOP + (avail - need(items, scale)) / 2, into = poolY;
    return items.map(item => {
      const h = Math.max(2, item.value * scale), slot = Math.max(h, minSlot);
      const placed = { ...item, side: kind, x, y: y + (slot - h) / 2, h, poolY: into };
      y += slot + GAP; into += item.value * scale;
      return placed;
    });
  };
  return { scale, poolH, poolY, center, bar, side, nodes: [...stack(pool.sources, "source", left), ...stack(pool.uses, "use", right)] };
}

function band(x0: number, y0: number, x1: number, y1: number, h0: number, h1: number) {
  const xm = (x0 + x1) / 2;
  return `M${r(x0)},${r(y0)}C${r(xm)},${r(y0)} ${r(xm)},${r(y1)} ${r(x1)},${r(y1)}L${r(x1)},${r(y1 + h1)}C${r(xm)},${r(y1 + h1)} ${r(xm)},${r(y0 + h0)} ${r(x0)},${r(y0 + h0)}Z`;
}

/**
 * Sources on the left fill one pool; uses on the right drain it. Both sides add up to the same total,
 * so every band is a disclosed amount, and a loss or a cash draw-down appears as a source or use, never a gap.
 */
export function PoolChart({ pool, money, label, spotlight = null, compact = false }: { pool: Pool; money: (v: number) => string; label: string;
  /** Item keys a finding is about; they stay lit while the pointer is elsewhere. */
  spotlight?: Set<string> | null;
  compact?: boolean;
}) {
  useEffect(() => { markContent("company"); }, []);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(peekChartBox);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const w = Math.round(element.clientWidth), h = Math.round(element.clientHeight);
      if (w > 0 && h > 0) setSize(old => old?.w === w && old.h === h ? old : { w, h });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => size ? layoutPool(pool, size.w, size.h, money, compact) : null, [pool, size, money, compact]);
  const [active, setActive] = useState<string | null>(null);
  const lit = (key: string) => active ? active === key : Boolean(spotlight?.has(key));
  const focused = active || (spotlight && layout?.nodes.some(n => spotlight.has(n.key)));
  const [tip, setTip] = useState<{ x: number; y: number; item: Placed } | null>(null);
  const share = (v: number) => pool.total ? `${Math.round(v / pool.total * 100)}%` : "";
  const point = (event: { clientX: number; clientY: number }, item: Placed) => {
    const rect = box.current!.getBoundingClientRect();
    setTip({ x: event.clientX - rect.left, y: event.clientY - rect.top, item });
  };
  const highlight = (event: { clientX: number; clientY: number }, item: Placed) => { setActive(item.key); point(event, item); };
  const clear = () => { setActive(null); setTip(null); };
  const minHeight = Math.max(216, TOP + BOTTOM + (COMPACT_SLOT + GAP) * Math.max(pool.sources.length, pool.uses.length));
  return <div className="pool" data-compact={compact || undefined} style={compact ? { minHeight } : undefined}>
    <div className="pool-canvas" ref={box}>
      {size && layout && <svg className="fc-svg pool-svg" viewBox={`0 0 ${size.w} ${size.h}`} role={compact ? "group" : "img"} aria-label={label} data-focus={focused ? "" : undefined}
        onClick={compact ? e => { if (!(e.target instanceof Element) || !e.target.closest("[data-pool-item]")) clear(); } : undefined}>
        <g>
          {layout.nodes.map(n => {
            const d = n.side === "source"
              ? band(n.x + layout.bar, n.y, layout.center, n.poolY, n.h, n.value * layout.scale)
              : band(layout.center + layout.bar, n.poolY, n.x, n.y, n.value * layout.scale, n.h);
            return <path key={n.key} className="fc-band" data-pool-item={n.key} d={d} style={{ fill: TONE[n.tone] }} data-lit={lit(n.key) ? "on" : undefined}
              onMouseMove={e => highlight(e, n)} onMouseLeave={clear} onClick={compact ? e => highlight(e, n) : undefined} />;
          })}
        </g>
        <g className="fc-node pool-total" style={{ "--c": "var(--flow-revenue)" } as CSSProperties}>
          <rect className="fc-bar" x={layout.center} y={layout.poolY} width={layout.bar} height={Math.max(2, layout.poolH)} rx={3} />
          <text className="fc-label" x={r(layout.center + layout.bar / 2)} y={compact ? 21 : r(layout.poolY - 12)} textAnchor="middle">
            <tspan className="fc-name" style={{ fontSize: NAME + 1 }}>{pool.title}</tspan><tspan className="fc-value" dx={8} style={{ fontSize: VALUE + 4 }}>{money(pool.total)}</tspan>
          </text>
        </g>
        {layout.nodes.map(n => {
          const mid = n.y + n.h / 2, x = n.side === "source" ? n.x - 10 : n.x + layout.bar + 10, anchor = n.side === "source" ? "end" : "start";
          const itemTitle = m.itemTitle(n.label, money(n.value), share(n.value), pool.title);
          const focus = (element: SVGGElement) => {
            const rect = element.getBoundingClientRect();
            highlight({ clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }, n);
          };
          return <g key={n.key} className="fc-node" data-pool-item={n.key} data-tone={n.tone} data-lit={lit(n.key) ? "" : undefined} style={{ "--c": TONE[n.tone] } as CSSProperties}
            onMouseMove={e => highlight(e, n)} onMouseLeave={clear}
            {...(compact ? { role: "button", tabIndex: 0, "aria-label": itemTitle, onClick: (e: React.MouseEvent) => highlight(e, n),
              onFocus: (e: React.FocusEvent<SVGGElement>) => focus(e.currentTarget), onBlur: clear,
              onKeyDown: (e: React.KeyboardEvent<SVGGElement>) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); focus(e.currentTarget); } },
            } : {})}>
            <title>{itemTitle}</title>
            <rect className="fc-hit" x={n.x - 6} y={Math.min(n.y, mid - SLOT / 2)} width={layout.bar + 12} height={Math.max(n.h, SLOT)} />
            <rect className="fc-bar" x={n.x} y={n.y} width={layout.bar} height={n.h} rx={Math.min(3, n.h / 2)} />
            {compact ? <foreignObject x={n.side === "source" ? 0 : size.w - layout.side + 6} y={mid - COMPACT_SLOT / 2}
              width={layout.side - 6} height={COMPACT_SLOT}>
              <div className="portrait-pool-label" data-side={n.side}>
                <span className="fc-name">{n.label}</span>
                <span className="portrait-pool-amount"><strong className="fc-value">{money(n.value)}</strong>
                  <small className="fc-change pool-share">{share(n.value)}</small></span>
              </div>
            </foreignObject> : <>
            <text className="fc-label" x={r(x)} y={r(mid - 4)} textAnchor={anchor}><tspan className="fc-name" style={{ fontSize: NAME }}>{n.label}</tspan></text>
            <text className="fc-label" x={r(x)} y={r(mid + VALUE - 1)} textAnchor={anchor}>
              <tspan className="fc-value" style={{ fontSize: VALUE }}>{money(n.value)}</tspan><tspan className="fc-change pool-share" dx={6} style={{ fontSize: 12 }}>{share(n.value)}</tspan>
            </text>
            </>}
          </g>;
        })}
      </svg>}
      {size && tip && <div className="fc-tip" role="tooltip" style={compact
        ? { left: Math.max(8, Math.min(tip.x - 136, size.w - Math.min(272, size.w - 16) - 8)), width: Math.min(272, size.w - 16), top: tip.y > size.h / 2 ? Math.max(tip.y - 8, 100) : tip.y + 12,
          transform: tip.y > size.h / 2 ? "translateY(-100%)" : undefined }
        : { transform: `translate(${tip.x > size.w - 260 ? tip.x - 16 : tip.x + 16}px, ${tip.y + 16}px) translateX(${tip.x > size.w - 260 ? "-100%" : "0"})` }}>
        <div className="fc-tip-title"><i style={{ background: TONE[tip.item.tone] }} />{tip.item.label}</div>
        <div className="fc-tip-row"><span>{m.amount}</span><b>{money(tip.item.value)}</b></div>
        <div className="fc-tip-row"><span>{m.shareOf(pool.title)}</span><b>{share(tip.item.value)}</b></div>
        {tip.item.lines.length > 1 || (tip.item.lines.length === 1 && tip.item.lines[0].label !== tip.item.label)
          ? tip.item.lines.slice(0, 8).map((line, i) => <div className="fc-tip-row pool-tip-line" key={i}><span>{line.label}</span><b>{money(line.value)}</b></div>) : null}
      </div>}
    </div>
  </div>;
}
