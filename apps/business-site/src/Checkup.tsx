import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, useReducedMotion } from "motion/react";
import { Button } from "@/packages/web/src/ui/button";
import { getLocale, labels, messages } from "@/packages/web/src/i18n";
import type { AssessedMetric, BridgeStep, CapitalChain, CashBridge, Flag, FlagLevel, MetricForm, MetricPoint, PeerRank, StatementAssessment, StatementDimension } from "@/shared/analysis-contract/statement-analysis";
import type { FindingRef, FindingSpan } from "@/shared/analysis-contract/findings";
import type { FlowSource } from "@/shared/analysis-contract/business-flow";
import { refLabel, resolveEvidence, resolveRef, type FindingData } from "@/shared/analysis-runtime/findings";
import { flagFigures, formatMetric, formatMetricChange, METRIC_DEFS, thresholdsOf } from "@/shared/analysis-runtime/statement-analysis";
import { compactMoney, qoqLabel, shortPeriod, yoyLabel } from "@/shared/analysis-runtime/locale";
import { RailSection } from "./RailSection";
import { arrivalStyle, RailRow, rowExit, useArrivals } from "./arrivals";
import { KIND_LABEL, type VerifiedFinding } from "./findings-model";

const m = messages({
  flags: "Checkup", report: (period: string) => `${period} report`, walk: "Walk through", stop: "Stop walk-through", walkKeys: "Walk through (← →)",
  none: "No rule tripped", covered: (n: number, of: number) => `${n}/${of}`, coverage: (n: number, of: number) => `${n} of ${of} metrics resolved`,
  since: (period: string) => `Since ${period}`, dimensions: "Dimensions",
  bridge: "Profit to cash", chain: "Capital chain", quarter: "Quarter", trailing: "Trailing 4 quarters", span: "Span",
  openingCash: "Cash and short-term investments at start", closingCash: "at end", unreconciled: "Not reconciled", base: (period: string) => `Base ${period}`,
  peers: (rank: number, of: number) => `Peers ${rank}/${of}`, peerTitle: (rows: string) => `Peers: ${rows}`,
  flag: (title: string) => `Checkup: ${title}`, previous: "Previous", next: "Next", close: "Close",
  trend: "Trend", parts: "Components", figures: "Figures", related: "Findings", peerTable: "Peers", sources: "Sources",
  current: "Latest", threshold: "Threshold", openFlag: (title: string) => `Open checkup: ${title}`, hide: "Hide", level: "Level",
  chartLabel: (name: string) => `${name}, last quarters`,
}, {
  flags: "三表体检", report: (period: string) => `${period} 财报`, walk: "逐条浏览", stop: "停止逐条浏览", walkKeys: "逐条浏览（← →）",
  none: "无命中规则", covered: (n: number, of: number) => `${n}/${of}`, coverage: (n: number, of: number) => `${of} 项指标中 ${n} 项可解析`,
  since: (period: string) => `自 ${period}`, dimensions: "维度",
  bridge: "利润到现金", chain: "资本链路", quarter: "本季度", trailing: "近四季", span: "口径",
  openingCash: "期初现金及短期投资", closingCash: "期末", unreconciled: "未合拢", base: (period: string) => `基期 ${period}`,
  peers: (rank: number, of: number) => `同业 ${rank}/${of}`, peerTitle: (rows: string) => `同业：${rows}`,
  flag: (title: string) => `体检：${title}`, previous: "上一条", next: "下一条", close: "关闭",
  trend: "走势", parts: "构成", figures: "数据", related: "要点", peerTable: "同业", sources: "来源",
  current: "最新", threshold: "阈值", openFlag: (title: string) => `打开体检项：${title}`, hide: "隐藏", level: "级别",
  chartLabel: (name: string) => `${name}，最近若干季度`,
});
export const LEVEL_LABEL = labels({ alert: "Alert", watch: "Watch", note: "Note" }, { alert: "警示", watch: "留意", note: "提示" });
export const DIMENSION_LABEL = labels<StatementDimension>({
  growth: "Growth", profitability: "Profitability", earningsQuality: "Earnings quality", capitalEfficiency: "Capital efficiency", safety: "Financial safety", valuation: "Valuation",
}, {
  growth: "成长", profitability: "盈利", earningsQuality: "盈利质量", capitalEfficiency: "资本效率", safety: "财务安全", valuation: "估值",
});
const LEVELS: FlagLevel[] = ["alert", "watch", "note"];
const zh = () => getLocale() === "zh-CN";
export const flagLabel = (flag: Pick<Flag, "metricId">) => METRIC_DEFS.get(flag.metricId)?.label[zh() ? 1 : 0] ?? flag.metricId;
export const flagKey = (flag: Pick<Flag, "ruleId">) => flag.ruleId;
const metricValue = (metric: Pick<AssessedMetric, "form" | "current">, value = metric.current.value) => formatMetric(value, metric.form, getLocale(), metric.current.resolved.currency ?? "USD");

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

/** The six dimensions as one strip: each with its flags by level and how many of its metrics resolved. */
export function CheckupHead({ assessment, onDimension }: { assessment: StatementAssessment; onDimension: (id: StatementDimension) => void }) {
  return <nav className="checkup-dims" aria-label={m.dimensions}>
    {assessment.dimensions.filter(d => d.covered > 0).map(d => {
      const top = LEVELS.find(level => d.flags.some(f => f.level === level));
      return <Button key={d.id} variant="unstyled" type="button" className="checkup-dim" data-level={top} onClick={() => onDimension(d.id)} title={m.coverage(d.covered, d.total)}>
        <span className="checkup-dim-name">{DIMENSION_LABEL[d.id]}</span>
        <span className="checkup-dim-meta">{d.flags.length ? <LevelCounts flags={d.flags} /> : <span className="checkup-dim-clear" aria-hidden="true">—</span>}<small>{m.covered(d.covered, d.total)}</small></span>
      </Button>;
    })}
  </nav>;
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

/* ---------- The stage ---------- */

/** The checkup's stage: how profit became cash, how capital became revenue, and every metric by dimension. */
export function CheckupStage({ assessment, ranks, flagged, onFlag, sectionRef }: {
  assessment: StatementAssessment; ranks: Record<string, PeerRank>;
  /** The highest flag of each metric, for its cell's mark and its click. */
  flagged: Map<string, Flag>;
  onFlag: (flag: Flag) => void;
  sectionRef: (id: StatementDimension) => (el: HTMLElement | null) => void;
}) {
  const [span, setSpan] = useState<"quarter" | "year">("year");
  const bridge = span === "year" ? assessment.bridge.year ?? assessment.bridge.quarter : assessment.bridge.quarter ?? assessment.bridge.year;
  const shownSpan = bridge === assessment.bridge.year ? "year" : "quarter";
  return <div className="checkup">
    {(bridge || assessment.chain) && <div className="checkup-links">
      {bridge && <section className="checkup-card" aria-label={m.bridge}>
        <header><h3>{m.bridge}</h3>
          {assessment.bridge.year && assessment.bridge.quarter && <span className="periods periods--small" role="radiogroup" aria-label={m.span}>
            <Button variant="unstyled" type="button" role="radio" aria-checked={shownSpan === "quarter"} onClick={() => setSpan("quarter")}>{m.quarter}</Button>
            <Button variant="unstyled" type="button" role="radio" aria-checked={shownSpan === "year"} onClick={() => setSpan("year")}>{m.trailing}</Button>
          </span>}
        </header>
        <Bridge bridge={bridge} />
      </section>}
      {assessment.chain && <section className="checkup-card" aria-label={m.chain}><header><h3>{m.chain}</h3></header><Chain chain={assessment.chain} /></section>}
    </div>}
    {assessment.dimensions.filter(d => d.metrics.length).map(d => <section key={d.id} className="checkup-dimension" ref={sectionRef(d.id)} aria-label={DIMENSION_LABEL[d.id]}>
      <header><h3>{DIMENSION_LABEL[d.id]}</h3><LevelCounts flags={d.flags} /><small title={m.coverage(d.covered, d.total)}>{m.covered(d.covered, d.total)}</small></header>
      <div className="checkup-grid">{d.metrics.map(metric => <MetricCell key={metric.id} metric={metric} flag={flagged.get(metric.id) ?? null} rank={ranks[metric.id] ?? null} onFlag={onFlag} />)}</div>
    </section>)}
  </div>;
}

function MetricCell({ metric, flag, rank, onFlag }: { metric: AssessedMetric; flag: Flag | null; rank: PeerRank | null; onFlag: (flag: Flag) => void }) {
  const thresholds = flag ? thresholdsOf(flag) : [];
  const change = metric.measure === "value" && metric.yoy != null ? `${yoyLabel(getLocale())} ${formatMetricChange(metric.yoy, metric.form, getLocale())}` : null;
  const body = <>
    <span className="checkup-cell-label">{flag && <LevelMark level={flag.level} label={LEVEL_LABEL[flag.level]} />}{metric.label}</span>
    <strong className="checkup-cell-value">{metricValue(metric)}</strong>
    <Spark metric={metric} thresholds={thresholds} level={flag?.level} />
    <span className="checkup-cell-note">
      {change && <span>{change}</span>}
      {rank && <span title={m.peerTitle(rank.rows.map(r => `${r.ticker} ${formatMetric(r.value, metric.form, getLocale())}`).join(" · "))}>{m.peers(rank.rank, rank.of)}</span>}
    </span>
  </>;
  return flag ? <Button variant="unstyled" type="button" className="checkup-cell" data-level={flag.level} onClick={() => onFlag(flag)} aria-label={m.openFlag(metric.label)}>{body}</Button>
    : <div className="checkup-cell">{body}</div>;
}

/* ---------- Rail ---------- */

/** How many flags the rail shows before the section is opened. */
const DIGEST = 3;

/** The checkup's flags as a rail section, alerts first: the metric, its value and the rule it trips. */
export function FlagsList({ flags, metrics, updates, focus, story, periodEnd, expanded, onFocus, onStory, onExpand }: {
  flags: Flag[]; metrics: Map<string, AssessedMetric>; updates: number; focus: string | null; story: boolean; periodEnd: string; expanded: boolean;
  onFocus: (key: string | null) => void; onStory: () => void; onExpand: (open: boolean) => void;
}) {
  const ids = flags.map(flagKey);
  const arrived = useArrivals(ids, updates);
  const still = useReducedMotion();
  const extra = (f: Flag, i: number) => i >= DIGEST && flagKey(f) !== focus;
  return <RailSection name="flags" title={m.flags} hint={m.report(shortPeriod(periodEnd))} expandable={flags.some(extra)} expanded={expanded} focused={focus != null} onExpand={onExpand}
    actions={flags.length > 0 && <Button variant="unstyled" type="button" className="icon-button section-action" aria-pressed={story} aria-label={story ? m.stop : m.walk} title={story ? m.stop : m.walkKeys} onClick={onStory}>
      <svg viewBox="0 0 24 24" aria-hidden="true">{story ? <rect x="7" y="7" width="10" height="10" rx="2" /> : <path d="M8 6.5v11l9-5.5Z" />}</svg>
    </Button>}>
    <div className="findings-rows section-body" id="rail-flags" role="radiogroup" aria-label={m.flags}>
      {flags.length === 0 && <p className="flag-none">{m.none}</p>}
      <AnimatePresence initial={false} mode="popLayout">
        {flags.map((f, i) => {
          const metric = metrics.get(f.metricId), key = flagKey(f);
          return <RailRow variant="unstyled" type="button" key={key} role="radio" aria-checked={focus === key} className="finding-row flag-row" data-level={f.level}
            layout={still ? false : "position"} layoutDependency={ids.join()} exit={rowExit} data-arrived={arrived.has(key) ? "" : undefined} style={arrivalStyle(arrived.get(key))}
            data-extra={extra(f, i) ? "" : undefined} onClick={() => onFocus(focus === key ? null : key)} title={`${LEVEL_LABEL[f.level]} · ${DIMENSION_LABEL[f.dimension]}`}>
            <LevelMark level={f.level} label={LEVEL_LABEL[f.level]} />
            <span className="finding-title flag-title"><span>{flagLabel(f)}</span>{metric && <b>{metricValue(metric, f.value)}</b>}</span>
            <span className="flag-rule">{f.threshold}</span>
          </RailRow>;
        })}
      </AnimatePresence>
    </div>
  </RailSection>;
}

/** Up to three flags of the view in place of a lead finding, above the statement they light. */
export function LeadFlags({ flags, onOpen, onHide }: { flags: Flag[]; onOpen: (flag: Flag) => void; onHide: () => void }) {
  return <div className="lead-finding lead-flags" data-level={flags[0]!.level}>
    <div className="lead-flags-list">{flags.map(f => <Button key={flagKey(f)} variant="unstyled" type="button" className="lead-finding-open" data-level={f.level} aria-label={m.openFlag(flagLabel(f))} onClick={() => onOpen(f)}>
      <LevelMark level={f.level} /><span>{flagLabel(f)}<small>{f.threshold}</small></span><span aria-hidden="true">→</span>
    </Button>)}</div>
    <Button variant="unstyled" type="button" className="icon-button lead-finding-hide" aria-label={m.hide} title={m.hide} onClick={onHide}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>
    </Button>
  </div>;
}

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

/** Findings whose evidence cites the figure the flag is about, so the reader can go from the rule to the explanation. */
export function relatedFindings(flag: Flag, findings: VerifiedFinding[]): VerifiedFinding[] {
  const { metrics, capital } = flagFigures(flag);
  const hits = (ref: FindingRef): boolean => "ratio" in ref ? hits(ref.ratio.numerator) || hits(ref.ratio.denominator)
    : "metric" in ref ? metrics.includes(ref.metric) : "capital" in ref ? capital.includes(ref.capital) : false;
  return findings.filter(f => f.periodEnd === flag.evidence[0]?.periodEnd && f.evidence.some(e => hits(e.ref)));
}

export function FlagLens({ flag, metric, rank, data, findings, sources, story, index, count, onStep, onClose, onFinding }: {
  flag: Flag; metric: AssessedMetric; rank: PeerRank | null; data: FindingData; findings: VerifiedFinding[]; sources: FlowSource[];
  story: boolean; index: number; count: number; onStep: (delta: 1 | -1) => void; onClose: () => void; onFinding: (id: string) => void;
}) {
  const title = flagLabel(flag);
  const parts = useMemo(() => partsOf(data, metric), [data, metric]);
  const related = useMemo(() => relatedFindings(flag, findings), [flag, findings]);
  const thresholds = thresholdsOf(flag);
  const form = metric.form === "points" ? "points" : metric.form;
  const figures: Array<[string, string]> = [[m.current, metricValue(metric)], [m.threshold, flag.threshold]];
  if (metric.measure === "value" && metric.yoy != null) figures.push([yoyLabel(getLocale()), formatMetricChange(metric.yoy, metric.form, getLocale())]);
  if (metric.measure === "value" && metric.qoq != null) figures.push([qoqLabel(getLocale()), formatMetricChange(metric.qoq, metric.form, getLocale())]);
  for (const s of parts?.series ?? []) { const last = s.points.at(-1); if (last) figures.push([s.label, parts!.form === "money" ? compactMoney(last.value, "USD", getLocale()) : formatMetric(last.value, parts!.form, getLocale())]); }
  return <section className="lens flag-lens" data-level={flag.level} aria-label={m.flag(title)} key={flagKey(flag)}>
    <header className="lens-head">
      <div className="lens-title">
        <b className="lens-kind"><LevelMark level={flag.level} />{LEVEL_LABEL[flag.level]}</b>
        <h2>{title}</h2>
        <span className="lens-basis">{m.report(shortPeriod(flag.evidence[0]?.periodEnd ?? flag.since))} · {DIMENSION_LABEL[flag.dimension]} · {m.since(shortPeriod(flag.since))}</span>
      </div>
      <div className="lens-nav">
        {story && <span className="lens-steps"><Button variant="unstyled" type="button" aria-label={m.previous} disabled={index <= 0} onClick={() => onStep(-1)}>‹</Button><span>{index + 1} / {count}</span><Button variant="unstyled" type="button" aria-label={m.next} disabled={index >= count - 1} onClick={() => onStep(1)}>›</Button></span>}
        <Button variant="unstyled" type="button" className="lens-close" aria-label={m.close} onClick={onClose}>✕</Button>
      </div>
    </header>
    <div className="lens-doc">
      <div className="lens-doc-row" data-cells="2" data-lead="first">
        <div className="lens-doc-cell"><h3 className="lens-row-title">{m.trend}</h3>
          <SeriesChart series={[{ id: "metric", label: title, color: "var(--kind)", points: metric.series }]} form={form} kind={metric.form === "money" ? "bar" : "line"} height={230} thresholds={thresholds} since={flag.since} level={flag.level} label={m.chartLabel(title)} />
        </div>
        <div className="lens-doc-cell"><h3 className="lens-row-title">{m.figures}</h3>
          <dl className="lens-evidence">{figures.map(([label, value]) => <div key={label} className="lens-row"><dt>{label}</dt><dd><b>{value}</b></dd></div>)}</dl>
        </div>
      </div>
      {(parts || rank) && <div className="lens-doc-row" data-cells={parts && rank ? 2 : 1} data-lead={parts && rank ? "first" : undefined}>
        {parts && <div className="lens-doc-cell"><h3 className="lens-row-title">{m.parts}</h3>
          <ul className="chain-legend">{parts.series.map(s => <li key={s.id}><i style={{ background: s.color }} />{s.label}</li>)}</ul>
          <SeriesChart series={parts.series} form={parts.form} kind={parts.form === "money" ? "bar" : "line"} height={190} label={parts.series.map(s => s.label).join(" · ")} />
        </div>}
        {rank && <div className="lens-doc-cell"><h3 className="lens-row-title">{m.peerTable}</h3>
          <table className="lens-table"><tbody>{rank.rows.map((r, i) => <tr key={r.ticker} data-own={r.own || undefined}><th scope="row">{i + 1}. {r.ticker}</th><td>{formatMetric(r.value, metric.form, getLocale())}<em>{shortPeriod(r.periodEnd)}</em></td></tr>)}</tbody></table>
        </div>}
      </div>}
      {(related.length > 0 || sources.length > 0) && <div className="lens-doc-row" data-cells={related.length && sources.length ? 2 : 1}>
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

/** The statements behind the report's quarter: the flow's filings and the balance sheet's and cash flow's, each once. */
export function checkupSources(data: FindingData, periodEnd: string): FlowSource[] {
  const near = (a: string) => Math.abs(Date.parse(a) - Date.parse(periodEnd)) <= 20 * 86_400_000;
  const out = new Map<string, FlowSource>();
  for (const s of data.quarters.find(q => near(q.periodEnd))?.sources ?? []) if (/^https:\/\//.test(s.url)) out.set(s.url, s);
  const capital = data.capital?.quarters.find(q => near(q.periodEnd));
  for (const s of [capital?.balanceSheet?.source, ...(capital?.cashFlow?.sources ?? [])]) if (s && !out.has(s.url)) out.set(s.url, { id: s.accession, title: `${s.form} ${s.accession}`, url: s.url });
  return [...out.values()].slice(0, 6);
}

/** Flags of one view, the most pressing first: the view's own metrics only, three at most. */
export const viewFlags = (flags: Flag[], view: "profit" | "cash" | "balance") => flags.filter(f => f.anchors.view === view).slice(0, 3);

/** The level a statement figure carries on the stage's tiles: the most pressing flag that is about it. */
export function figureLevel(flags: Flag[], figure: { metric?: string; capital?: string }): FlagLevel | undefined {
  return flags.find(f => { const p = flagFigures(f); return figure.metric ? (p.metrics as string[]).includes(figure.metric) : figure.capital ? (p.capital as string[]).includes(figure.capital) : false; })?.level;
}
