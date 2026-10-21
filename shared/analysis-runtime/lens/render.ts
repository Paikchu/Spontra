import type { CompiledAxis, CompiledChart, CompiledSeries, LensFrameSize } from "../../analysis-contract/lens-frame.ts";
import { compactMoney } from "./format.ts";
import type { Locale } from "../locale.ts";

/**
 * Draws a compiled chart as an SVG document string: no DOM, no library, so the frame, the page's
 * inline fallback and a test all paint the same picture. Colours and type come from the page's
 * tokens; the frame defines the same custom properties on its root.
 */
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const CHAR = 6.4, PERIOD_H = 26, NOTE_H = 18, LEGEND_H = 20, TITLE_H = 24, SUBTITLE_H = 22, VALUE_H = 18;
const n2 = (v: number) => Number(v.toFixed(2));
/** CJK characters run about one em wide, nearly twice a Latin character; widths are estimated per character. */
const WIDE = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g, WIDE_EXTRA = 4.6;
const textW = (s: string) => s.length * CHAR + (s.match(WIDE)?.length ?? 0) * WIDE_EXTRA;
const LABELLED = new Set(["line", "step", "dot", "area", "stacked_area", "rule"]);

type Scale = { y: (v: number) => number; zero: number; axis: CompiledAxis };

function scaleFor(axis: CompiledAxis | null, top: number, bottom: number): Scale | null {
  if (!axis) return null;
  const y = (v: number) => bottom - (v - axis.min) / (axis.max - axis.min || 1) * (bottom - top);
  return { y, zero: y(Math.max(axis.min, Math.min(axis.max, 0))), axis };
}

/** `still`: no entrance animation, for a redraw at a new size of a chart already on screen. `locale`: the number form of a stack's total, the one figure drawn here rather than compiled. */
export function renderChartSvg(chart: CompiledChart, size: LensFrameSize, options: { still?: boolean; locale?: Locale } = {}): string {
  const W = Math.max(120, Math.floor(size.width)), H = Math.max(120, Math.floor(size.height));
  const n = chart.periods.length;
  const bySeries = new Map(chart.series.map(s => [s.id, s]));
  // The note series is written under the periods; every other series is drawn.
  const note = chart.periodNote ? bySeries.get(chart.periodNote) ?? null : null;
  const drawn = chart.series.filter(s => s !== note);
  // The point of the chart: focused columns and series carry colour and figures, the rest is grey context.
  const focusCols = new Set(chart.focus.periods), focusSeries = new Set(chart.focus.series);
  const context = (s: CompiledSeries) => focusSeries.size < drawn.length && !focusSeries.has(s.id) ? " context" : "";
  // Every chart with a left scale shows it, bars included: gridlines let a reader compare columns at a glance.
  const labelledLeft = chart.marks.some(m => m.series.some(id => bySeries.get(id)?.axis === "left"));
  const labelledRight = !!chart.axes.right;
  const leftW = labelledLeft && chart.axes.left ? Math.max(...chart.axes.left.ticks.map(t => textW(t.label))) + 10 : 0;
  const rightW = labelledRight && chart.axes.right ? Math.max(...chart.axes.right.ticks.map(t => textW(t.label))) + 10 : 0;
  // Legend rows by estimated width, so a long set wraps instead of running off the edge.
  const legendItems = chart.legend === "top" ? drawn.map(s => ({ s, w: textW(s.label) + 24 })) : [];
  const legendRows: Array<typeof legendItems> = [];
  for (const item of legendItems) { const row = legendRows.at(-1); if (row && row.reduce((w, i) => w + i.w, 0) + item.w <= W) row.push(item); else legendRows.push([item]); }
  const hasNegative = drawn.some(s => s.values.some(v => v != null && v < 0));
  const top = 4 + (chart.title ? TITLE_H : 0) + (chart.subtitle ? SUBTITLE_H : 0) + (legendRows.length ? 6 : 0) + legendRows.length * LEGEND_H + VALUE_H;
  const bottom = H - PERIOD_H - (note ? NOTE_H : 0) - (hasNegative ? VALUE_H : 2);
  const x0 = leftW, x1 = W - rightW - 2;
  const colW = (x1 - x0) / n, cx = (i: number) => x0 + colW * (i + 0.5);
  const left = scaleFor(chart.axes.left, top, bottom), right = scaleFor(chart.axes.right, top, bottom);
  const scaleOf = (s: CompiledSeries) => (s.axis === "right" ? right : left)!;
  const out: string[] = [];
  const text = (x: number, y: number, body: string, cls: string, anchor: "start" | "middle" | "end" = "middle", attrs = "") => out.push(`<text class="${cls}" x="${n2(x)}" y="${n2(y)}" text-anchor="${anchor}"${attrs}>${esc(body)}</text>`);

  // Title and legend.
  let hy = 4;
  if (chart.title) { text(0, hy + 15, chart.title, "title", "start"); hy += TITLE_H; }
  if (chart.subtitle) { text(0, hy + 13, chart.subtitle, "sub", "start"); hy += SUBTITLE_H; }
  if (legendRows.length) hy += 6;
  for (const row of legendRows) {
    let lx = 0;
    for (const { s, w } of row) { out.push(`<rect class="swatch${context(s)}" x="${n2(lx)}" y="${n2(hy + 5)}" width="8" height="8" rx="2" fill="${s.color}"/>`); text(lx + 13, hy + 13, s.label, "legend", "start"); lx += w; }
    hy += LEGEND_H;
  }
  // Bands sit behind everything in the plot.
  for (const b of chart.bands) {
    out.push(`<rect class="band" x="${n2(x0 + colW * b.from)}" y="${n2(top)}" width="${n2(colW * (b.to - b.from + 1))}" height="${n2(bottom - top)}"/>`);
    if (b.label) text(x0 + colW * b.from + 6, top + 11, b.label, "band-label", "start");
  }
  // Gridlines with their labels behind the marks.
  if (left && labelledLeft) for (const t of left.axis.ticks) {
    const y = left.y(t.value);
    if (t.value !== 0 && y < bottom - 1) out.push(`<line class="grid" x1="${n2(x0)}" x2="${n2(x1)}" y1="${n2(y)}" y2="${n2(y)}"/>`);
    text(x0 - 6, y + 3.5, t.label, "tick", "end");
  }
  if (right && labelledRight) for (const t of right.axis.ticks) { const y = right.y(t.value); text(x1 + 6, y + 3.5, t.label, "tick tick-right", "start"); }
  for (const sc of [left, right]) if (sc && sc.axis.zero) out.push(`<line class="zero" x1="${n2(x0)}" x2="${n2(x1)}" y1="${n2(sc.zero)}" y2="${n2(sc.zero)}"/>`);
  else if (sc && sc.axis.min >= 0 && sc === left) out.push(`<line class="zero" x1="${n2(x0)}" x2="${n2(x1)}" y1="${n2(bottom)}" y2="${n2(bottom)}"/>`);

  // Columns: bars, stacks and waterfalls per period, each column a group that hover lights.
  const barSeries = chart.marks.filter(m => m.type === "bar").flatMap(m => m.series.map(id => bySeries.get(id)!));
  const stackMarks = chart.marks.filter(m => m.type === "stacked_bar");
  const waterfall = chart.marks.find(m => m.type === "waterfall");
  const groups = barSeries.length + stackMarks.length + (waterfall ? 1 : 0);
  // A lone series gets broad columns; a group shares most of its column.
  const gap = 3, barW = groups === 1 ? Math.min(72, Math.max(5, colW * 0.5)) : groups ? Math.min(40, Math.max(5, (colW * 0.74 - gap * (groups - 1)) / groups)) : 0, groupW = groups * barW + (groups - 1) * gap;
  const valueLabels: string[] = [];
  const show = (i: number) => focusCols.has(i) ? ' data-focus="" data-show=""' : "";
  // Labels of one column that would overlap step up, so two bars of similar height both stay readable.
  const placed: Array<{ col: number; x: number; y: number; w: number }> = [];
  const valueAt = (i: number, x: number, y: number, body: string, below: boolean) => {
    let ly = below ? y + 12 : y - 5;
    const w = textW(body) + 6;
    for (const p of placed) if (p.col === i && Math.abs(p.x - x) < (p.w + w) / 2 && Math.abs(p.y - ly) < 12) ly = below ? p.y + 12 : p.y - 12;
    placed.push({ col: i, x, y: ly, w });
    valueLabels.push(`<text class="val" data-col="${i}"${show(i)} x="${n2(x)}" y="${n2(ly)}" text-anchor="middle">${esc(body)}</text>`);
  };
  // A line's label sits beside its point when bars already label the column above themselves.
  const beside = (i: number, x: number, y: number, body: string) => valueLabels.push(`<text class="val" data-col="${i}"${show(i)} x="${n2(x > x1 - 60 ? x - 7 : x + 7)}" y="${n2(y + 4)}" text-anchor="${x > x1 - 60 ? "end" : "start"}">${esc(body)}</text>`);
  for (let i = 0; i < n; i++) {
    const parts: string[] = [];
    let gx = cx(i) - groupW / 2;
    for (const s of barSeries) {
      const v = s.values[i], sc = scaleOf(s);
      if (v == null) parts.push(`<rect class="bar missing" x="${n2(gx)}" y="${n2(sc.zero - 2)}" width="${n2(barW)}" height="2"/>`);
      else {
        const y = sc.y(v), h = Math.max(2, Math.abs(y - sc.zero));
        parts.push(`<rect x="${n2(gx)}" y="${n2(Math.min(y, sc.zero))}" width="${n2(barW)}" height="${n2(h)}" rx="1.5" class="bar${context(s)}" fill="${v < 0 ? "var(--loss)" : s.color}" style="--d:${i * 50}ms"/>`);
        valueAt(i, gx + barW / 2, v < 0 ? sc.zero + h : y, s.text[i]!, v < 0);
      }
      gx += barW + gap;
    }
    for (const m of stackMarks) {
      const members = m.series.map(id => bySeries.get(id)!);
      let up = 0, down = 0;
      for (const s of members) {
        const v = s.values[i], sc = scaleOf(s);
        if (v == null) continue;
        const from = v >= 0 ? up : down, to = from + v;
        parts.push(`<rect class="bar${context(s)}" x="${n2(gx)}" y="${n2(Math.min(sc.y(from), sc.y(to)))}" width="${n2(barW)}" height="${n2(Math.max(1, Math.abs(sc.y(from) - sc.y(to))))}" fill="${s.color}" style="--d:${i * 50}ms"><title>${esc(`${s.label} ${s.text[i]}`)}</title></rect>`);
        if (v >= 0) up = to; else down = to;
      }
      const first = members[0]!, sc = scaleOf(first);
      const total = members.reduce((sum, s) => sum + (s.values[i] ?? 0), 0);
      valueAt(i, gx + barW / 2, sc.y(up), members.length > 1 ? stackText(members, total, options.locale) : first.text[i] ?? "", false);
      gx += barW + gap;
    }
    if (waterfall) {
      const s = bySeries.get(waterfall.series[0]!)!, sc = scaleOf(s), v = s.values[i];
      if (v != null) {
        const prev = i > 0 ? s.values[i - 1] : null;
        const from = prev ?? 0, to = v, up = to >= from;
        parts.push(`<rect class="bar" x="${n2(gx)}" y="${n2(Math.min(sc.y(from), sc.y(to)))}" width="${n2(barW)}" height="${n2(Math.max(2, Math.abs(sc.y(from) - sc.y(to))))}" rx="1.5" fill="${prev == null ? s.color : up ? "var(--up)" : "var(--loss)"}" style="--d:${i * 50}ms"/>`);
        if (i < n - 1 && s.values[i + 1] != null) parts.push(`<line class="connector" x1="${n2(gx + barW)}" x2="${n2(cx(i + 1) - groupW / 2)}" y1="${n2(sc.y(to))}" y2="${n2(sc.y(to))}"/>`);
        valueAt(i, gx + barW / 2, sc.y(Math.max(from, to)), s.text[i]!, false);
      }
    }
    out.push(`<g class="col" data-col="${i}"${focusCols.has(i) ? ' data-focus=""' : ""}>${parts.join("")}</g>`);
  }

  // Lines, steps, dots, areas: paths through the resolved points; a gap in the data breaks the path.
  const point = (s: CompiledSeries, i: number) => { const v = s.values[i]; return v == null ? null : { x: cx(i), y: scaleOf(s).y(v) }; };
  const pathOf = (s: CompiledSeries, step: boolean) => {
    let d = "", open = false;
    for (let i = 0; i < n; i++) {
      const p = point(s, i);
      if (!p) { open = false; continue; }
      if (!open) { d += `M${n2(p.x)},${n2(p.y)}`; open = true; }
      else if (step) { const q = point(s, i - 1)!; d += `L${n2(p.x)},${n2(q.y)}L${n2(p.x)},${n2(p.y)}`; }
      else d += `L${n2(p.x)},${n2(p.y)}`;
    }
    return d;
  };
  for (const m of chart.marks) {
    if (m.type === "stacked_area") {
      const members = m.series.map(id => bySeries.get(id)!), sc = scaleOf(members[0]!);
      const stack = Array.from({ length: n }, (_, i) => members.reduce<number[]>((acc, s) => [...acc, (acc.at(-1) ?? 0) + (s.values[i] ?? 0)], []));
      members.forEach((s, k) => {
        const upper = Array.from({ length: n }, (_, i) => `${n2(cx(i))},${n2(sc.y(stack[i]![k]!))}`);
        const lower = Array.from({ length: n }, (_, i) => `${n2(cx(i))},${n2(sc.y(k ? stack[i]![k - 1]! : Math.max(0, sc.axis.min)))}`).reverse();
        out.push(`<path class="area-fill stacked" d="M${upper.join("L")}L${lower.join("L")}Z" fill="${s.color}" style="--d:${k * 80}ms"/>`);
      });
      const last = n - 1;
      members.forEach((s, k) => { if (s.values[last] != null) valueLabels.push(`<text class="val" data-col="${last}" data-focus="" data-show="" x="${n2(cx(last) - 6)}" y="${n2((sc.y(stack[last]![k]!) + sc.y(k ? stack[last]![k - 1]! : 0)) / 2 + 4)}" text-anchor="end">${esc(s.text[last]!)}</text>`); });
      continue;
    }
    if (m.type === "line" || m.type === "step" || m.type === "area" || m.type === "dot") for (const id of m.series) {
      const s = bySeries.get(id)!, sc = scaleOf(s);
      const d = pathOf(s, m.type === "step");
      if (m.type === "area" && d) {
        const first = chart.periods.findIndex((_, i) => s.values[i] != null), last = n - 1 - [...chart.periods].reverse().findIndex((_, i) => s.values[n - 1 - i] != null);
        out.push(`<path class="area-fill" d="${d}L${n2(cx(last))},${n2(sc.zero)}L${n2(cx(first))},${n2(sc.zero)}Z" fill="${s.color}"/>`);
      }
      if (m.type !== "dot" && d) out.push(`<path class="line${context(s)}" d="${d}" stroke="${s.color}"/>`);
      for (let i = 0; i < n; i++) {
        const p = point(s, i);
        if (!p) continue;
        out.push(`<circle class="dot${context(s)}" data-col="${i}" cx="${n2(p.x)}" cy="${n2(p.y)}" r="${m.type === "dot" ? 3.5 : 2.4}" fill="${s.color}"/>`);
        if (groups) beside(i, p.x, p.y, s.text[i]!); else valueAt(i, p.x, p.y, s.text[i]!, false);
      }
    }
    if (m.type === "rule") for (const id of m.series) {
      const s = bySeries.get(id)!, sc = scaleOf(s);
      const i = n - 1 - [...chart.periods].reverse().findIndex((_, k) => s.values[n - 1 - k] != null);
      if (i >= n || s.values[i] == null) continue;
      const r = s.ranges?.[i];
      if (r) out.push(`<rect class="rule-band" x="${n2(x0)}" y="${n2(Math.min(sc.y(r.low), sc.y(r.high)))}" width="${n2(x1 - x0)}" height="${n2(Math.max(1, Math.abs(sc.y(r.low) - sc.y(r.high))))}" fill="${s.color}"/>`);
      const y = sc.y(s.values[i]!);
      out.push(`<line class="rule" x1="${n2(x0)}" x2="${n2(x1)}" y1="${n2(y)}" y2="${n2(y)}" stroke="${s.color}"/>`);
      text(x1 - 4, y - 5, `${s.label} ${s.text[i]}`, "rule-label", "end");
    }
  }
  out.push(...valueLabels);
  // Annotations: a short sentence at its point, above it unless that runs into the top.
  for (const a of chart.annotations) {
    const s = bySeries.get(a.series)!, p = point(s, a.period);
    if (!p) continue;
    const above = p.y - 22 > top;
    const x = Math.min(x1 - 4, Math.max(x0 + 4, p.x)), anchor = p.x > x1 - 80 ? "end" : p.x < x0 + 80 ? "start" : "middle";
    // Below a point the value label already sits at +12, so the callout starts under it.
    out.push(`<line class="leader" x1="${n2(p.x)}" x2="${n2(p.x)}" y1="${n2(above ? p.y - 6 : p.y + 16)}" y2="${n2(above ? p.y - 16 : p.y + 28)}"/>`);
    text(x, above ? p.y - 20 : p.y + 40, a.text, "ann", anchor);
  }
  // Period labels along the bottom; sparse (asked for, or forced when they would collide) keeps the newest and every other one before it.
  const labelW = Math.max(...chart.periods.map(p => textW(p.label))) + 8;
  const every = chart.periodLabels === "sparse" || labelW > colW ? Math.max(2, Math.ceil(labelW / colW)) : 1;
  const labelY = H - 7 - (note ? NOTE_H : 0);
  chart.periods.forEach((p, i) => {
    if ((n - 1 - i) % every !== 0) return;
    text(cx(i), labelY, p.label, focusCols.has(i) ? "period current" : "period");
    if (note?.text[i]) text(cx(i), H - 7, note.text[i]!, focusCols.has(i) ? "note current" : "note");
  });
  // Hit areas last, so the frame can tell which column the pointer is over.
  for (let i = 0; i < n; i++) out.push(`<rect class="hit" data-col="${i}" x="${n2(x0 + colW * i)}" y="0" width="${n2(colW)}" height="${H}"/>`);

  // One series labels every column, as a reader would write the figures on a printed chart; more series label the newest column and the hovered one.
  const single = drawn.length === 1;
  // The style is shared by every chart on a page, so nothing in it is particular to this one; hover is an attribute the host sets.
  return `<svg class="lens-svg"${options.still ? ' data-still=""' : ""}${single ? ' data-labels="all"' : ""}${single && groups ? ' data-solo=""' : ""} xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chart.summary)}"><style>${CSS}</style>${out.join("")}</svg>`;
}

function stackText(members: CompiledSeries[], total: number, locale: Locale = "en"): string {
  const first = members[0]!;
  // The stack's total in the unit its members use: a compact amount or a percentage.
  if (first.unit === "USD") return compactMoney(total, first.currency, locale);
  if (first.unit === "percent") return `${Number(total.toFixed(1))}%`;
  return String(Number(total.toFixed(2)));
}

const CSS = `
.lens-svg{font-family:var(--sans,system-ui,sans-serif);font-variant-numeric:tabular-nums;overflow:visible}
.lens-svg text{fill:var(--muted-foreground);font-size:12px}
.title{fill:var(--foreground);font-size:15px;font-weight:650;letter-spacing:-.005em}
.sub{font-size:12.5px}
.legend{font-size:12px}
.tick{font-size:11.5px;fill:var(--faint)}
.grid{stroke:var(--border);stroke-opacity:.7;shape-rendering:crispEdges}
.zero{stroke:var(--muted-foreground);stroke-opacity:.55;shape-rendering:crispEdges}
.band{fill:var(--foreground);fill-opacity:.05}
.band-label{font-size:10.5px;fill:var(--faint)}
.bar{transition:opacity .25s;transform-box:fill-box;transform-origin:bottom;animation:lens-grow .6s cubic-bezier(.22,1,.36,1) both;animation-delay:var(--d,0ms)}
.bar.missing{fill:var(--hairline)}
.col:not([data-focus]) .bar{opacity:.5}
.lens-svg[data-solo] .col:not([data-focus]) .bar,.bar.context{opacity:1;fill:color-mix(in srgb,var(--muted-foreground) 38%,var(--background))}
.lens-svg[data-solo][data-hover] .col[data-hot]:not([data-focus]) .bar{fill:color-mix(in srgb,var(--muted-foreground) 62%,var(--background))}
.line.context{stroke:color-mix(in srgb,var(--muted-foreground) 50%,var(--background));stroke-width:1.4}
.swatch.context{fill:color-mix(in srgb,var(--muted-foreground) 38%,var(--background))}
.dot.context{fill:color-mix(in srgb,var(--muted-foreground) 50%,var(--background))}
.lens-svg[data-hover] .col:not([data-hot]) .bar{opacity:.4}
.col[data-hot] .bar{opacity:1}
.connector{stroke:var(--border);stroke-dasharray:2 3}
.line{fill:none;stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round;animation:lens-fade .6s ease both}
.area-fill{fill-opacity:.16;animation:lens-fade .6s ease both}
.area-fill.stacked{fill-opacity:.78;stroke:var(--background);stroke-width:1;animation-delay:var(--d,0ms)}
.dot{transition:opacity .25s;opacity:.85}
.val{fill:var(--foreground);font-size:12px;font-weight:600;opacity:0;transition:opacity .2s;paint-order:stroke;stroke:var(--background);stroke-width:3px;stroke-linejoin:round}
.val[data-show]{opacity:1}
.lens-svg[data-labels=all] .val{opacity:1;font-weight:500}
.lens-svg[data-labels=all] .val:not([data-show]){fill:var(--muted-foreground)}
.lens-svg[data-labels=all] .val[data-show]{font-weight:650}
.rule{stroke-width:1.2;stroke-dasharray:5 4}
.rule-band{fill-opacity:.12}
.rule-label{font-size:10.5px;font-weight:600;fill:var(--foreground);paint-order:stroke;stroke:var(--background);stroke-width:3px}
.leader{stroke:var(--muted-foreground);stroke-width:1}
.ann{fill:var(--foreground);font-size:12px;font-weight:600;paint-order:stroke;stroke:var(--background);stroke-width:4px;stroke-linejoin:round}
.period{fill:var(--muted-foreground);font-size:12px}
.period.current{fill:var(--foreground);font-weight:600}
.note{fill:var(--faint);font-size:11.5px}
.note.current{fill:var(--foreground)}
.hit{fill:transparent}
@keyframes lens-grow{from{transform:scaleY(.001)}}
@keyframes lens-fade{from{opacity:0}}
.lens-svg[data-still] .bar,.lens-svg[data-still] .line,.lens-svg[data-still] .area-fill{animation:none}
@media (prefers-reduced-motion:reduce){.bar,.line,.area-fill{animation:none}}
`.replace(/\n/g, "");
