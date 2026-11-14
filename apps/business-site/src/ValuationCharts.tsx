import { messages } from "@/packages/web/src/i18n";
import { DIMENSION_WEIGHTS, SCORE_ANCHOR_LEVELS, VALUATION_DIMENSIONS, type Confidence, type ValuationDimensionKey, type ValuationPublication } from "@/shared/analysis-contract/valuation";

/**
 * The valuation's one figure: the five dimensions on a fixed pentagon. Geometry is the SVG; labels are HTML placed by
 * percent, so text keeps its size at every width. Every score is the researcher's; nothing is derived here.
 */
const m = messages({
  radar: "Five-dimension chart", unscored: "not scored", ringNote: (levels: string) => `Rings at ${levels}`, weight: (w: string) => `Weight ${w}`,
}, {
  radar: "五维图", unscored: "未评分", ringNote: (levels: string) => `环线为 ${levels} 分`, weight: (w: string) => `权重 ${w}`,
});

const pct = (v: number, digits = 0) => `${v < 0 ? "−" : ""}${(Math.abs(v) * 100).toFixed(digits)}%`;
const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

const RADAR = { w: 400, h: 360, cx: 200, cy: 190, r: 100, labelRadius: 156 } as const;
/** A vertex on the fixed pentagon: the five axes in contract order, clockwise from the top. */
function vertex(index: number, radius: number): { x: number; y: number } {
  const angle = (index * 72 - 90) * Math.PI / 180;
  return { x: RADAR.cx + radius * Math.cos(angle), y: RADAR.cy + radius * Math.sin(angle) };
}
const ring = (radius: number) => VALUATION_DIMENSIONS.map((_, i) => { const v = vertex(i, radius); return `${v.x.toFixed(1)},${v.y.toFixed(1)}`; }).join(" ");

/**
 * The same axes, order and weights for every company, rings at the scoring anchors, the scored polygon as one series.
 * An incomplete set is not plotted: missing evidence is not a zero score. Compact labels carry only the names: the rows
 * beside the chart say the scores.
 */
export function Radar({ report, label, confidence, compact }: {
  report: Pick<ValuationPublication, "dimensions">;
  label: (key: ValuationDimensionKey) => string;
  confidence?: (level: Confidence) => string;
  compact?: boolean;
}) {
  const byKey = new Map(report.dimensions.map(d => [d.key, d]));
  if (VALUATION_DIMENSIONS.some(key => !finite(byKey.get(key)?.score))) return null;
  const points = VALUATION_DIMENSIONS.map((key, i) => {
    const d = byKey.get(key);
    const score = d && finite(d.score) ? Math.max(0, Math.min(10, d.score)) : null;
    const v = vertex(i, RADAR.r * (score ?? 0) / 10), at = vertex(i, RADAR.labelRadius);
    return { key, score, confidence: d?.confidence ?? null, v, at };
  });
  const summary = points.map(p => `${label(p.key)} ${p.score != null ? p.score.toFixed(1) : m.unscored}`).join(" · ");
  const conf = (c: Confidence | null) => c && c !== "medium" && confidence ? ` · ${confidence(c)}` : "";
  return <figure className="val-radar" data-compact={compact ? "" : undefined} aria-label={`${m.radar} · ${summary}`}>
    <div className="val-radar-plot"><svg viewBox={`0 0 ${RADAR.w} ${RADAR.h}`} role="img" aria-label={summary} className="val-radar-svg">
      {SCORE_ANCHOR_LEVELS.map(level => <polygon key={level} className="val-radar-ring" points={ring(RADAR.r * level / 10)} />)}
      {points.map(p => { const end = vertex(VALUATION_DIMENSIONS.indexOf(p.key), RADAR.r); return <line key={p.key} className="val-radar-axis" x1={RADAR.cx} y1={RADAR.cy} x2={end.x.toFixed(1)} y2={end.y.toFixed(1)} />; })}
      <polygon className="val-radar-area" points={points.map(p => `${p.v.x.toFixed(1)},${p.v.y.toFixed(1)}`).join(" ")} />
      {points.map(p => <circle key={p.key} className="val-radar-dot" data-unscored={p.score == null ? "" : undefined} cx={p.v.x.toFixed(1)} cy={p.v.y.toFixed(1)} r={4}><title>{`${label(p.key)} · ${p.score != null ? p.score.toFixed(1) : m.unscored}`}</title></circle>)}
    </svg>
    {points.map(p => <span key={p.key} className="val-radar-label" style={{ left: `${(p.at.x / RADAR.w * 100).toFixed(1)}%`, top: `${(p.at.y / RADAR.h * 100).toFixed(1)}%` }}>
      <b>{label(p.key)}{!compact && <em> {p.score != null ? p.score.toFixed(1) : "—"}</em>}</b>
      {!compact && <small>{m.weight(pct(DIMENSION_WEIGHTS[p.key]))}{conf(p.confidence)}</small>}
    </span>)}</div>
    {!compact && <figcaption>{m.ringNote(SCORE_ANCHOR_LEVELS.join(" / "))}</figcaption>}
  </figure>;
}
