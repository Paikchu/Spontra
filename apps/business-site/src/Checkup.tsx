import { Table, TableBody, TableCell, TableHead, TableRow } from "@/packages/web/src/ui/table";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/packages/web/src/ui/button";
import { getLocale, isChinese as zh, labels, messages } from "@/packages/web/src/i18n";
import type { AssessedMetric, BridgeStep, CapitalChain, CashBridge, Flag, FlagLevel, MetricForm, MetricPoint, PeerRank, StatementAssessment, StatementDimension } from "@/shared/analysis-contract/statement-analysis";
import type { FindingRef, FindingSpan, FindingView } from "@/shared/analysis-contract/findings";
import type { FlowSource } from "@/shared/analysis-contract/business-flow";
import { refLabel, resolveEvidence, resolveRef, type FindingData } from "@/shared/analysis-runtime/findings";
import { refView } from "@/shared/analysis-runtime/highlights";
import { flagFigures, formatMetric, formatMetricChange, METRIC_DEFS, thresholdsOf } from "@/shared/analysis-runtime/statement-analysis";
import { compactMoney, qoqLabel, shortPeriod, yoyLabel } from "@/shared/analysis-runtime/locale";
import { KIND_LABEL, type VerifiedFinding } from "./findings-model";
import type { VerifiedNote } from "@/shared/analysis-runtime/checkup-notes";
import { SourceLanguage, langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { flagCopy, metricRules } from "./flag-copy";

/**
 * The three-statement analysis, shown inside the statements it reads (docs/three-statement-analysis-design.md): each
 * view carries its own tripped rules under its tiles and its own metrics in the panel under its chart; a rule or a
 * metric opens in the stage like a finding. Nothing here is a sentence: names, figures, thresholds and dates.
 */
const m = messages({
  report: (period: string) => `${period} report`, since: (period: string) => `Since ${period}`,
  bridge: "Profit to cash", chain: "Capital chain", quarter: "Quarter", trailing: "Trailing 4 quarters", span: "Span",
  openingCash: "Cash and short-term investments at start", closingCash: "at end", unreconciled: "Not reconciled", base: (period: string) => `Base ${period}`,
  peers: (rank: number, of: number) => `Peers ${rank}/${of}`, peerTitle: (rows: string) => `Peers: ${rows}`,
  metric: (title: string) => `Metric: ${title}`, close: "Close",
  trend: "Trend", parts: "Components", figures: "Figures", related: "Findings", peerTable: "Peers", sources: "Sources",
  current: "Latest", conditions: "When this is flagged", met: "Met", unmet: "Not met", open: (title: string) => `Open ${title}`,
  chartLabel: (name: string) => `${name}, last quarters`, metrics: "Metrics", panel: "Panel", flags: "Rules tripped",
  analysis: "Analysis", earlier: "Earlier report", currentReport: "Current report", filed: (form: string, period: string) => `${form} · ${period}`,
}, {
  report: (period: string) => `${period} 财报`, since: (period: string) => `自 ${period}`,
  bridge: "利润到现金", chain: "资本链路", quarter: "本季度", trailing: "近四季", span: "口径",
  openingCash: "期初现金及短期投资", closingCash: "期末", unreconciled: "未合拢", base: (period: string) => `基期 ${period}`,
  peers: (rank: number, of: number) => `同业 ${rank}/${of}`, peerTitle: (rows: string) => `同业：${rows}`,
  metric: (title: string) => `指标：${title}`, close: "关闭",
  trend: "走势", parts: "构成", figures: "数据", related: "要点", peerTable: "同业", sources: "来源",
  current: "最新", conditions: "触发条件", met: "已达到", unmet: "未达标", open: (title: string) => `打开${title}`,
  chartLabel: (name: string) => `${name}，最近若干季度`, metrics: "指标", panel: "面板", flags: "命中规则",
  analysis: "分析", earlier: "往期财报", currentReport: "本期财报", filed: (form: string, period: string) => `${form} · ${period}`,
});
export const LEVEL_LABEL = labels({ alert: "Alert", watch: "Watch", note: "Note" }, { alert: "警示", watch: "留意", note: "提示" });
export const DIMENSION_LABEL = labels<StatementDimension>({
  growth: "Growth", profitability: "Profitability", earningsQuality: "Earnings quality", capitalEfficiency: "Capital efficiency", safety: "Financial safety", valuation: "Valuation",
}, {
  growth: "成长", profitability: "盈利", earningsQuality: "盈利质量", capitalEfficiency: "资本效率", safety: "财务安全", valuation: "估值",
});
const LEVELS: FlagLevel[] = ["alert", "watch", "note"];
const RANK: Record<FlagLevel, number> = { alert: 0, watch: 1, note: 2 };
export const metricLabel = (id: string) => METRIC_DEFS.get(id)?.label[zh() ? 1 : 0] ?? id;
const metricValue = (metric: Pick<AssessedMetric, "form" | "current">, value = metric.current.value) => formatMetric(value, metric.form, getLocale(), metric.current.resolved.currency ?? "USD");
type StatementView = FindingView;

/** The level as a shape as well as a colour: a triangle warns, a dot asks to watch, a ring notes. */
export function LevelMark({ level, label }: { level: FlagLevel; label?: string }) {
  return <svg className="level-mark" data-level={level} viewBox="0 0 12 12" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    {level === "alert" ? <path d="M6 1.2 11 10.4H1Z" /> : level === "watch" ? <circle cx="6" cy="6" r="4.2" /> : <circle cx="6" cy="6" r="3.6" fill="none" strokeWidth="1.8" />}
  </svg>;
}

/** Counts by level, each with its mark; levels without a flag are left out. */
export function LevelCounts({ flags }: { flags: Flag[] }) {
  return <span className="level-counts">{LEVELS.map(level => { const n = flags.filter(f => f.level === level).length; return n ? <span key={level} data-level={level} title={LEVEL_LABEL[level]}><LevelMark level={level} />{n}</span> : null; })}</span>;
}
/** The width an element is given, kept current, for charts that draw text at its real size. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/* ---------- Charts ---------- */

type Series = { id: string; label: string; color: string; points: MetricPoint[] };
const niceStep = (span: number) => { const raw = span / 3, mag = 10 ** Math.floor(Math.log10(raw || 1)), n = raw / mag; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag; };

/**
 * Quarterly series as lines or grouped bars over shared period columns, with threshold lines drawn as dashes and the
 * quarters a rule held shaded. Text is drawn at its real size from the measured width.
 */
function SeriesChart({ series, form, kind, height, thresholds = [], since = null, level, label }: {
  series: Series[]; form: MetricForm; kind: "line" | "bar"; height: number; thresholds?: number[]; since?: string | null; level?: FlagLevel; label: string;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const ends = [...new Set(series.flatMap(s => s.points.map(p => p.periodEnd)))].sort();
  const values = [...series.flatMap(s => s.points.map(p => p.value)), ...thresholds];
  const fmt = (v: number) => form === "money" ? compactMoney(v, "USD", getLocale()) : formatMetric(v, form, getLocale());
  const left = 54, right = 12, top = 10, bottom = 22, plotW = Math.max(40, width - left - right), plotH = height - top - bottom;
  let lo = Math.min(...values), hi = Math.max(...values);
  if (kind === "bar" || form === "money") { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  if (lo === hi) { lo -= 1; hi += 1; }
  const step = niceStep(hi - lo), y0 = Math.floor(lo / step) * step, y1 = Math.ceil(hi / step) * step;
  const y = (v: number) => top + plotH - (v - y0) / (y1 - y0) * plotH;
  const col = plotW / Math.max(1, ends.length), x = (end: string) => left + col * (ends.indexOf(end) + 0.5);
  const ticks: number[] = []; for (let t = y0; t <= y1 + step / 2; t += step) ticks.push(Number(t.toFixed(10)));
  const labelEvery = Math.max(1, Math.ceil(ends.length / Math.max(1, Math.floor(plotW / 44))));
  const barW = Math.min(22, col * 0.7 / Math.max(1, series.length));
  return <div ref={box} className="checkup-chart" style={{ height }} role="img" aria-label={label}>
    {width > 0 && ends.length > 0 && <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {since && ends.some(e => e >= since) && <rect className="checkup-band" data-level={level} x={x(ends.find(e => e >= since)!) - col / 2} y={top} width={col * ends.filter(e => e >= since).length} height={plotH} />}
      {ticks.map(t => <g key={t}><line className="checkup-gridline" x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} data-zero={t === 0 || undefined} /><text className="checkup-tick" x={left - 6} y={y(t) + 3.5} textAnchor="end">{fmt(t)}</text></g>)}
      {ends.map((end, i) => i % labelEvery === (ends.length - 1) % labelEvery ? <text key={end} className="checkup-tick" x={x(end)} y={height - 6} textAnchor="middle">{shortPeriod(end).slice(2)}</text> : null)}
      {kind === "bar" ? series.map((s, si) => s.points.map(p => { const bx = x(p.periodEnd) - barW * series.length / 2 + barW * si; return <rect key={`${s.id}-${p.periodEnd}`} x={bx + 1} width={Math.max(1, barW - 2)} y={Math.min(y(p.value), y(0))} height={Math.max(1, Math.abs(y(p.value) - y(0)))} rx={2} fill={s.color}><title>{`${s.label} ${shortPeriod(p.periodEnd)} ${fmt(p.value)}`}</title></rect>; }))
        : series.map(s => <g key={s.id}>
          <polyline fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" points={s.points.map(p => `${x(p.periodEnd)},${y(p.value)}`).join(" ")} />
          {s.points.map((p, i) => <circle key={p.periodEnd} cx={x(p.periodEnd)} cy={y(p.value)} r={i === s.points.length - 1 ? 4 : 2.5} fill={s.color}><title>{`${s.label} ${shortPeriod(p.periodEnd)} ${fmt(p.value)}`}</title></circle>)}
        </g>)}
      {thresholds.map(t => <g key={t} className="checkup-threshold" data-level={level}><line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} /><text x={left + plotW} y={y(t) - 4} textAnchor="end">{fmt(t)}</text></g>)}
    </svg>}
  </div>;
}

/** A metric's last quarters as a small line, its threshold dashed; no text, so it scales to any width. */
function Spark({ metric, thresholds, level }: { metric: AssessedMetric; thresholds: number[]; level?: FlagLevel }) {
  const pts = metric.series;
  if (pts.length < 2) return <span className="checkup-spark checkup-spark--empty" aria-hidden="true" />;
  const vals = [...pts.map(p => p.value), ...thresholds];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const y = (v: number) => 30 - (v - lo) / (hi - lo) * 28, x = (i: number) => i / (pts.length - 1) * 100;
  return <svg className="checkup-spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
    {thresholds.map(t => <line key={t} className="checkup-spark-threshold" data-level={level} x1={0} x2={100} y1={y(t)} y2={y(t)} vectorEffect="non-scaling-stroke" />)}
    <polyline points={pts.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")} vectorEffect="non-scaling-stroke" />
  </svg>;
}

/* ---------- Profit to cash, and the capital chain ---------- */

/** Running position of each step: a total stands from zero, a movement from where the last one ended. */
function placeSteps(steps: BridgeStep[]) {
  const placed: Array<{ step: BridgeStep; from: number; to: number }> = [];
  let at = 0;
  for (const step of steps) {
    const from = step.total ? 0 : at, to = step.total ? step.value : at + step.value;
    placed.push({ step, from, to });
    at = to;
  }
  return placed;
}

function Bridge({ bridge }: { bridge: CashBridge }) {
  const placed = useMemo(() => placeSteps(bridge.steps), [bridge]);
  const lo = Math.min(0, ...placed.flatMap(p => [p.from, p.to])), hi = Math.max(0, ...placed.flatMap(p => [p.from, p.to]));
  const pct = (v: number) => (v - lo) / ((hi - lo) || 1) * 100;
  const money = (v: number) => compactMoney(v, bridge.currency, getLocale());
  const tone = (s: BridgeStep) => s.total ? "total" : s.value >= 0 ? "in" : "out";
  return <div className="cash-bridge">
    <ol className="cash-bridge-rows">
      {placed.map(({ step, from, to }) => <li key={step.id} className="cash-bridge-row" data-tone={tone(step)}>
        <span className="cash-bridge-label">{step.label}</span>
        <span className="cash-bridge-track"><i className="cash-bridge-zero" style={{ left: `${pct(0)}%` }} /><b style={{ left: `${pct(Math.min(from, to))}%`, width: `${Math.max(0.4, Math.abs(pct(to) - pct(from)))}%` }} /></span>
        <span className="cash-bridge-value">{step.total ? money(step.value) : `${step.value > 0 ? "+" : ""}${money(step.value)}`}</span>
      </li>)}
    </ol>
    <p className="cash-bridge-foot">
      {bridge.openingCash != null && <span>{m.openingCash} {money(bridge.openingCash)}</span>}
      {bridge.closingCash != null && <span>{m.closingCash} {money(bridge.closingCash)}</span>}
      {!bridge.closes && <span className="cash-bridge-unreconciled">{m.unreconciled}</span>}
    </p>
  </div>;
}

const CHAIN_COLOR: Record<CapitalChain["series"][number]["id"], string> = { capex: "var(--flow-expense)", productive: "var(--biz-1)", revenue: "var(--flow-revenue-strong, var(--foreground))", operatingCashFlow: "var(--flow-profit)" };
function Chain({ chain }: { chain: CapitalChain }) {
  const series: Series[] = chain.series.map(s => ({ id: s.id, label: s.label, color: CHAIN_COLOR[s.id], points: s.points.map(p => ({ periodEnd: p.periodEnd, value: p.index / 100 })) }));
  return <div className="chain">
    <ul className="chain-legend">{chain.series.map(s => <li key={s.id}><i style={{ background: CHAIN_COLOR[s.id] }} />{s.label}<b>{formatMetric(s.points.at(-1)!.index / 100, "multiple", getLocale())}</b></li>)}</ul>
    <SeriesChart series={series} form="multiple" kind="line" height={170} thresholds={[1]} label={m.chain} />
    <p className="cash-bridge-foot"><span>{m.base(shortPeriod(chain.base))}</span></p>
  </div>;
}


/* ---------- What each statement view carries ---------- */

/** The statement a metric is read from; a valuation multiple belongs to none. */
export const metricView = (metric: Pick<AssessedMetric, "ref">): StatementView | null => refView(metric.ref);

/** A view's metrics, the flagged ones first by level, then in the catalogue's order. */
export function viewMetrics(assessment: StatementAssessment | null, view: StatementView, flagged: Map<string, Flag>): AssessedMetric[] {
  const all = (assessment?.dimensions.flatMap(d => d.metrics) ?? []).filter(metric => metricView(metric) === view);
  const level = (metric: AssessedMetric) => { const f = flagged.get(metric.id); return f ? RANK[f.level] : 3; };
  return all.map((metric, i) => ({ metric, i })).sort((a, b) => level(a.metric) - level(b.metric) || a.i - b.i).map(x => x.metric);
}

/** A view's tripped rules, the most pressing first. */
export const viewFlags = (flags: Flag[], view: StatementView) => flags.filter(f => f.anchors.view === view);

/**
 * The view's tripped rules as one row under its tiles: each names the metric, its value and the rule, in the level's
 * colour and shape. Hovering one lights what it is about on the chart; a click opens it.
 */
export function ViewFlags({ flags, metrics, noted, focus, onOpen, onHover }: {
  flags: Flag[]; metrics: Map<string, AssessedMetric>; /** Metrics with a written analysis. */ noted: Set<string>; focus: string | null; onOpen: (metricId: string) => void; onHover: (flag: Flag | null) => void;
}) {
  if (!flags.length) return null;
  return <ul className="view-flags" aria-label={m.flags} onMouseLeave={() => onHover(null)}>
    {flags.map(f => { const metric = metrics.get(f.metricId), copy = flagCopy(f, metric, metric?.evidence.periodEnd ?? f.evidence[0]?.periodEnd ?? f.since, getLocale()); return <li key={f.ruleId}>
      <Button variant="unstyled" type="button" className="view-flag" data-level={f.level} aria-pressed={focus === f.metricId} aria-label={`${LEVEL_LABEL[f.level]} · ${copy.sentence}`} title={`${LEVEL_LABEL[f.level]} · ${DIMENSION_LABEL[f.dimension]} · ${m.since(shortPeriod(f.since))}`}
        onClick={() => onOpen(f.metricId)} onMouseEnter={() => onHover(f)} onFocus={() => onHover(f)} onBlur={() => onHover(null)}>
        <LevelMark level={f.level} />
        <span className="view-flag-text"><span className="view-flag-name">{copy.name}</span> <b>{metric ? metricValue(metric, f.value) : copy.value}</b>{copy.sentence.slice(`${copy.name} ${copy.value}`.length)}</span>
        {noted.has(f.metricId) && <i className="view-flag-noted">{m.analysis}</i>}
      </Button>
    </li>; })}
  </ul>;
}

/** Switches the panel under the chart between its trend and the view's metrics. */
export function PanelSwitch({ value, onChange }: { value: "trend" | "metrics"; onChange: (next: "trend" | "metrics") => void }) {
  return <span className="periods periods--small panel-switch" role="radiogroup" aria-label={m.panel}>
    <Button variant="unstyled" type="button" role="radio" aria-checked={value === "trend"} onClick={() => onChange("trend")}>{m.trend}</Button>
    <Button variant="unstyled" type="button" role="radio" aria-checked={value === "metrics"} onClick={() => onChange("metrics")}>{m.metrics}</Button>
  </span>;
}

/** The view's metrics in the panel under its chart: one cell each, flagged ones first; any cell opens. */
export function ViewMetrics({ metrics, flagged, ranks, noted, onOpen, switcher }: {
  metrics: AssessedMetric[]; flagged: Map<string, Flag>; ranks: Record<string, PeerRank>; /** Metrics with a written analysis. */ noted: Set<string>; onOpen: (metricId: string) => void; switcher?: React.ReactNode;
}) {
  const flags = metrics.flatMap(metric => flagged.get(metric.id) ?? []);
  return <section className="trend view-metrics" aria-label={m.metrics}>
    <header className="trend-head"><div className="trend-heading"><div className="trend-title"><h2>{m.metrics}</h2></div><LevelCounts flags={flags} />{switcher}</div></header>
    <div className="view-metrics-row">{metrics.map(metric => <MetricCell key={metric.id} metric={metric} flag={flagged.get(metric.id) ?? null} rank={ranks[metric.id] ?? null} noted={noted.has(metric.id)} onOpen={onOpen} />)}</div>
  </section>;
}

function MetricCell({ metric, flag, rank, noted, onOpen }: { metric: AssessedMetric; flag: Flag | null; rank: PeerRank | null; noted: boolean; onOpen: (metricId: string) => void }) {
  const thresholds = flag ? thresholdsOf(flag) : [];
  const change = metric.measure === "value" && metric.yoy != null ? `${yoyLabel(getLocale())} ${formatMetricChange(metric.yoy, metric.form, getLocale())}` : null;
  return <Button variant="unstyled" type="button" className="checkup-cell" data-level={flag?.level} onClick={() => onOpen(metric.id)} aria-label={m.open(metric.label)}>
    <span className="checkup-cell-label">{flag && <LevelMark level={flag.level} label={LEVEL_LABEL[flag.level]} />}{metric.label}</span>
    <strong className="checkup-cell-value">{metricValue(metric)}</strong>
    <Spark metric={metric} thresholds={thresholds} level={flag?.level} />
    <span className="checkup-cell-note">
      {change && <span>{change}</span>}
      {flag && <span className="checkup-cell-rule">{flagCopy(flag, metric, metric.evidence.periodEnd, getLocale()).verdict}</span>}
      {noted && <span className="checkup-cell-noted">{m.analysis}</span>}
      {rank && <span title={m.peerTitle(rank.rows.map(r => `${r.ticker} ${formatMetric(r.value, metric.form, getLocale())}`).join(" · "))}>{m.peers(rank.rank, rank.of)}</span>}
    </span>
  </Button>;
}

/* ---------- One metric holding the stage ---------- */

/* ---------- One flag holding the stage ---------- */

const BASE_COLORS = ["var(--flow-expense)", "var(--biz-1)"];
/** The figures a ratio or a spread is made of, each over the shown quarters, in their own display terms. */
function partsOf(data: FindingData, metric: AssessedMetric): { series: Series[]; form: MetricForm } | null {
  const def = METRIC_DEFS.get(metric.id);
  const ends = metric.series.map(p => p.periodEnd);
  if (!def || !ends.length) return null;
  const read = (ref: FindingRef, span: FindingSpan) => ends.flatMap(end => { const r = resolveRef(data, ref, end, span); return r && !r.range ? [{ periodEnd: end, value: r.value }] : []; });
  const growth = (ref: FindingRef) => ends.flatMap(end => { const r = resolveEvidence(data, { ref, periodEnd: end, span: def.span, compare: "yoy" }); return r?.delta != null ? [{ periodEnd: end, value: r.current.unit === "ratio" ? r.delta * 100 : r.delta }] : []; });
  if (def.measure === "spread" && def.against) {
    const series = [def.ref, def.against].map((ref, i) => ({ id: String(i), label: `${refLabel(data, ref, getLocale())} · ${yoyLabel(getLocale())}`, color: BASE_COLORS[i]!, points: growth(ref) }));
    return series.every(s => s.points.length > 1) ? { series, form: "percent" } : null;
  }
  if ("ratio" in def.ref) {
    const sides = [def.ref.ratio.numerator, def.ref.ratio.denominator] as FindingRef[];
    const series = sides.map((ref, i) => ({ id: String(i), label: refLabel(data, ref, getLocale()), color: BASE_COLORS[i]!, points: read(ref, def.span) }));
    const units = sides.map(ref => resolveRef(data, ref, ends.at(-1)!, def.span)?.unit);
    return units.every(u => u === "USD") && series.every(s => s.points.length > 1) ? { series, form: "money" } : null;
  }
  return null;
}

/** Findings of the report whose evidence cites the figure the metric is about, so the reader can go from the rule to the explanation. */
export function relatedFindings(metricId: string, periodEnd: string, findings: VerifiedFinding[]): VerifiedFinding[] {
  const { metrics, capital } = flagFigures({ metricId });
  const hits = (ref: FindingRef): boolean => "ratio" in ref ? hits(ref.ratio.numerator) || hits(ref.ratio.denominator)
    : "metric" in ref ? metrics.includes(ref.metric) : "capital" in ref ? capital.includes(ref.capital) : false;
  return findings.filter(f => f.periodEnd === periodEnd && f.evidence.some(e => hits(e.ref)));
}


/** Metrics whose story is how profit became cash, and those whose story is what the capital bought. */
const BRIDGE_METRICS = new Set(["cash-conversion", "accruals", "working-capital-share", "free-cash-flow", "fcf-margin", "self-funding", "external-funding", "cash-runway"]);
const CHAIN_METRICS = new Set(["capex-to-depreciation", "capex-intensity", "asset-formation", "incremental-return", "roic", "asset-turnover"]);

/**
 * One metric holding the stage: its trend against every threshold its rules test, its figures, what it is made of, the
 * peers when they rank it, the profit-to-cash bridge or the capital chain when that is its story, the findings that
 * cite it, and the filings it was read from.
 */
export function MetricLens({ metric, flags, rank, data, findings, sources, bridge, chain, note, onClose, onFinding }: {
  metric: AssessedMetric; flags: Flag[]; rank: PeerRank | null; data: FindingData; findings: VerifiedFinding[]; sources: FlowSource[];
  /** The written analysis, verified against the figures and the filings as served now. */ note: VerifiedNote | null;
  bridge: { quarter: CashBridge | null; year: CashBridge | null }; chain: CapitalChain | null; onClose: () => void; onFinding: (id: string) => void;
}) {
  const title = metric.label, top = flags[0] ?? null;
  const parts = useMemo(() => partsOf(data, metric), [data, metric]);
  const related = useMemo(() => relatedFindings(metric.id, metric.evidence.periodEnd, findings), [metric, findings]);
  const thresholds = [...new Set(flags.flatMap(thresholdsOf))];
  const figures: Array<[string, string]> = [[m.current, metricValue(metric)]];
  const rules = metricRules(metric.id, flags, getLocale());
  if (metric.measure === "value" && metric.yoy != null) figures.push([yoyLabel(getLocale()), formatMetricChange(metric.yoy, metric.form, getLocale())]);
  if (metric.measure === "value" && metric.qoq != null) figures.push([qoqLabel(getLocale()), formatMetricChange(metric.qoq, metric.form, getLocale())]);
  for (const s of parts?.series ?? []) { const last = s.points.at(-1); if (last) figures.push([s.label, parts!.form === "money" ? compactMoney(last.value, "USD", getLocale()) : formatMetric(last.value, parts!.form, getLocale())]); }
  const story = BRIDGE_METRICS.has(metric.id) && (bridge.year ?? bridge.quarter) ? "bridge" : CHAIN_METRICS.has(metric.id) && chain ? "chain" : null;
  return <section className="lens flag-lens" data-level={top?.level} aria-label={m.metric(title)} key={metric.id}>
    <header className="lens-head">
      <div className="lens-title">
        {top && <b className="lens-kind"><LevelMark level={top.level} />{LEVEL_LABEL[top.level]}</b>}
        <h2>{title}</h2>
        <span className="lens-basis">{m.report(shortPeriod(metric.evidence.periodEnd))} · {DIMENSION_LABEL[metric.dimension]}{top ? ` · ${m.since(shortPeriod(top.since))}` : ""}</span>
      </div>
      <div className="lens-nav"><Button variant="unstyled" type="button" className="lens-close" aria-label={m.close} onClick={onClose}>✕</Button></div>
    </header>
    <div className="lens-doc">
      <div className="lens-doc-row">
        <div className="lens-doc-cell"><h3 className="lens-row-title">{m.trend}</h3>
          <SeriesChart series={[{ id: "metric", label: title, color: top ? "var(--kind)" : "var(--foreground)", points: metric.series }]} form={metric.form} kind={metric.form === "money" ? "bar" : "line"} height={230} thresholds={thresholds} since={top?.since ?? null} level={top?.level} label={m.chartLabel(title)} />
        </div>
        <div className="lens-doc-cell"><h3 className="lens-row-title">{m.figures}</h3>
          <Table className="lens-table lens-pairs"><TableBody>{figures.map(([label, value]) => <TableRow key={label}><TableHead scope="row">{label}</TableHead><TableCell><b>{value}</b></TableCell></TableRow>)}</TableBody></Table>
          {rules.length > 0 && <><h3 className="lens-row-title">{m.conditions}</h3>
          <ul className="rule-status">{rules.map(r => <li key={r.rule.id} data-level={r.met ? r.level : "unmet"}>
            <span className="rule-status-mark">{r.met ? <><LevelMark level={r.level} />{m.met}</> : m.unmet}</span>
            <span className="rule-status-text">{r.criteria}</span>
          </li>)}</ul></>}
        </div>
      </div>
      {note && <div className="lens-doc-row">
        <h3 className="lens-row-title">{m.analysis}<SourceLanguage of={note.paragraphs.map(p => p.text)} /></h3>
        <div className="lens-doc-cell">{note.paragraphs.map((p, i) => <p key={i} className="lens-prose" lang={langOf(p.text)}>{p.text}</p>)}</div>
        {note.quotes.length > 0 && <div className="lens-doc-cell">{note.quotes.map((q, i) => <figure key={i} className="lens-quote" data-earlier={q.earlier || undefined}>
          <blockquote lang="en">{q.text}</blockquote>
          <figcaption data-kind="sec"><span className="lens-quote-said">{q.earlier ? m.earlier : m.currentReport}</span>
            <a href={q.passage.url} target="_blank" rel="noopener noreferrer">{m.filed(q.passage.form, (/(\d{4}-\d{2}-\d{2})\s*$/.exec(q.material.title)?.[1] ?? q.passage.filedAt).slice(0, 7).replace("-", "."))}</a>
            {q.passage.path.length > 0 && <small>{q.passage.path.slice(1).join(" › ")}</small>}</figcaption>
        </figure>)}</div>}
      </div>}
      {(parts || rank) && <div className="lens-doc-row">
        {parts && <div className="lens-doc-cell"><h3 className="lens-row-title">{m.parts}</h3>
          <ul className="chain-legend">{parts.series.map(s => <li key={s.id}><i style={{ background: s.color }} />{s.label}</li>)}</ul>
          <SeriesChart series={parts.series} form={parts.form} kind={parts.form === "money" ? "bar" : "line"} height={190} label={parts.series.map(s => s.label).join(" · ")} />
        </div>}
        {rank && <div className="lens-doc-cell"><h3 className="lens-row-title">{m.peerTable}</h3>
          <table className="lens-table"><tbody>{rank.rows.map((r, i) => <tr key={r.ticker} data-own={r.own || undefined}><th scope="row">{i + 1}. {r.ticker}</th><td>{formatMetric(r.value, metric.form, getLocale())}<em>{shortPeriod(r.periodEnd)}</em></td></tr>)}</tbody></table>
        </div>}
      </div>}
      {story === "bridge" && <div className="lens-doc-row"><div className="lens-doc-cell"><BridgeCard bridge={bridge} /></div></div>}
      {story === "chain" && chain && <div className="lens-doc-row"><div className="lens-doc-cell"><h3 className="lens-row-title">{m.chain}</h3><Chain chain={chain} /></div></div>}
      {(related.length > 0 || sources.length > 0) && <div className="lens-doc-row">
        {related.length > 0 && <div className="lens-doc-cell"><h3 className="lens-row-title">{m.related}</h3>
          <ul className="flag-related">{related.map(f => <li key={f.id}><Button variant="unstyled" type="button" className="finding-row" data-kind={f.kind} onClick={() => onFinding(f.id)} title={KIND_LABEL[f.kind]}>
            <i className="finding-mark" aria-hidden="true">{f.severity}</i><span className="finding-title">{f.title}</span>
          </Button></li>)}</ul>
        </div>}
        {sources.length > 0 && <div className="lens-doc-cell"><h3 className="lens-row-title">{m.sources}</h3>
          <ul className="sources">{sources.map(s => <li key={s.url}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<span aria-hidden="true"> ↗</span></a></li>)}</ul>
        </div>}
      </div>}
    </div>
  </section>;
}

/** The profit-to-cash bridge with its span switch: the quarter, or the four quarters ending at it. */
function BridgeCard({ bridge }: { bridge: { quarter: CashBridge | null; year: CashBridge | null } }) {
  const [span, setSpan] = useState<"quarter" | "year">("year");
  const shown = span === "year" ? bridge.year ?? bridge.quarter : bridge.quarter ?? bridge.year;
  if (!shown) return null;
  const which = shown === bridge.year ? "year" : "quarter";
  return <>
    <h3 className="lens-row-title lens-row-title--with">{m.bridge}
      {bridge.year && bridge.quarter && <span className="periods periods--small" role="radiogroup" aria-label={m.span}>
        <Button variant="unstyled" type="button" role="radio" aria-checked={which === "quarter"} onClick={() => setSpan("quarter")}>{m.quarter}</Button>
        <Button variant="unstyled" type="button" role="radio" aria-checked={which === "year"} onClick={() => setSpan("year")}>{m.trailing}</Button>
      </span>}
    </h3>
    <Bridge bridge={shown} />
  </>;
}

export function checkupSources(data: FindingData, periodEnd: string): FlowSource[] {
  const near = (a: string) => Math.abs(Date.parse(a) - Date.parse(periodEnd)) <= 20 * 86_400_000;
  const out = new Map<string, FlowSource>();
  for (const s of data.quarters.find(q => near(q.periodEnd))?.sources ?? []) if (/^https:\/\//.test(s.url)) out.set(s.url, s);
  const capital = data.capital?.quarters.find(q => near(q.periodEnd));
  for (const s of [capital?.balanceSheet?.source, ...(capital?.cashFlow?.sources ?? [])]) if (s && !out.has(s.url)) out.set(s.url, { id: s.accession, title: `${s.form} ${s.accession}`, url: s.url });
  return [...out.values()].slice(0, 6);
}


/** The level a statement figure carries on the stage's tiles: the most pressing flag that is about it. */
export function figureLevel(flags: Flag[], figure: { metric?: string; capital?: string }): FlagLevel | undefined {
  return flags.find(f => { const p = flagFigures(f); return figure.metric ? (p.metrics as string[]).includes(figure.metric) : figure.capital ? (p.capital as string[]).includes(figure.capital) : false; })?.level;
}
