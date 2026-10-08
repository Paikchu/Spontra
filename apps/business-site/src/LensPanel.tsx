import { Button } from "@/components/ui/button";
import { useMemo, useState, type CSSProperties } from "react";
import type { BusinessFlowQuarter } from "@/shared/analysis-contract/business-flow";
import type { ExplainerSource } from "@/shared/analysis-contract/business-explainer";
import type { FindingRef } from "@/shared/analysis-contract/findings";
import { compactFlowValue } from "@/lib/earning-report/web/business-flow-layout";
import { spanLabel, watchPeriod, type FindingData, type ResolvedEvidence, type ResolvedValue } from "@/shared/analysis-runtime/findings";
import { KIND_LABEL, VIEW_LABEL, lensColumns, lensLadder, lensShares, type LensColumns, type LensLadder, type LensShares, type VerifiedFinding } from "./findings-model";

const shortPeriod = (end: string) => end.slice(0, 7).replace("-", ".");
const percent = (v: number | null, digits = 1) => v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}%`;
const trend = (v: number | null) => v == null || v === 0 ? undefined : v > 0 ? "up" : "down";
const money = (v: number, currency = "USD") => compactFlowValue(v, { currency, scale: 1 } as BusinessFlowQuarter);
const VERDICT = { above: "高于指引", within: "落在指引内", below: "低于指引" } as const;

/** One figure in the unit it was resolved in; signed amounts keep their sign. */
export function formatValue(v: ResolvedValue): string {
  if (v.range && v.range.low !== v.range.high) return v.unit === "USD" ? `${money(v.range.low, v.currency ?? "USD")}–${money(v.range.high, v.currency ?? "USD")}` : `${v.range.low}–${v.range.high}%`;
  if (v.unit === "USD") return (v.value < 0 ? "−" : "") + money(Math.abs(v.value), v.currency ?? "USD");
  if (v.unit === "percent") return `${Number(v.value.toFixed(1))}%`;
  if (v.unit === "per_share") return `$${v.value.toFixed(2)}`;
  if (v.unit === "ratio") return v.value.toFixed(2);
  return String(Number(v.value.toFixed(2)));
}

/** Series colour follows what the figure is: revenue neutral, profit and operating cash teal, costs and capital spending amber. */
function refColor(ref: FindingRef, nodeColor: (id: string) => string, index: number): string {
  if ("nodeId" in ref) return nodeColor(ref.nodeId);
  if ("metric" in ref) return ref.metric === "revenue" ? "var(--flow-revenue)" : ["gross", "operating", "pretax", "net"].includes(ref.metric) ? "var(--flow-profit)" : "var(--flow-expense)";
  if ("capital" in ref) return ref.capital === "operatingCashFlow" || ref.capital === "cash" || ref.capital === "equity" ? "var(--flow-profit)" : ref.capital === "freeCashFlow" || ref.capital === "totalAssets" ? "var(--biz-1)" : "var(--flow-expense)";
  return ["var(--biz-3)", "var(--biz-4)", "var(--biz-2)", "var(--biz-0)"][index % 4];
}

/**
 * The finding in focus: its chart on the left, bound to the same figures the stage shows, and its
 * judgment, evidence and what to watch next on the right. Replaces the revenue trend while open.
 */
export function LensPanel({ finding, data, sources, nodeColor, pair, story, index, count, onPair, onStep, onClose, split = false, compact = false, onFocusThis }: {
  finding: VerifiedFinding;
  data: FindingData;
  sources: ExplainerSource[];
  nodeColor: (id: string) => string;
  pair: VerifiedFinding | null;
  story: boolean;
  index: number;
  count: number;
  /** Opens or closes the side-by-side view with the paired finding. */
  onPair: () => void;
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
  split?: boolean;
  /** The second panel of a pair: chart and figures, with the judgment folded. */
  compact?: boolean;
  onFocusThis?: () => void;
}) {
  const cited = finding.judgment.sourceIds.map(id => sources.find(s => s.id === id)).filter(s => s != null);
  const columns = useMemo(() => finding.lens.type === "share_area" || finding.lens.type === "ladder" ? null : lensColumns(finding.lens, finding.periodEnd, data), [finding, data]);
  const shares = useMemo(() => finding.lens.type === "share_area" ? lensShares(finding.lens, finding.periodEnd, data) : null, [finding, data]);
  const ladder = useMemo(() => finding.lens.type === "ladder" ? lensLadder(finding.periodEnd, data) : null, [finding, data]);
  const watch = finding.watch, outcome = finding.watchOutcome;
  return <section className="lens" data-kind={finding.kind} data-compact={compact || undefined} aria-label={`要点：${finding.title}`} key={finding.id}>
    <header className="lens-head">
      <div className="lens-title">
        <b className="lens-kind" data-kind={finding.kind}>{KIND_LABEL[finding.kind]}<i aria-label={`重要程度 ${finding.severity}`}>{"●".repeat(finding.severity)}</i></b>
        <h2>{finding.title}</h2>
        <span className="lens-basis">基于 {shortPeriod(finding.periodEnd)} 财报 · 图中显示{VIEW_LABEL[finding.anchors.view]}视图</span>
      </div>
      <div className="lens-nav">
        {compact ? <Button variant="unstyled" type="button" className="lens-pair" onClick={onFocusThis}>聚焦此项</Button> : <>
          {pair && <Button variant="unstyled" type="button" className="lens-pair" aria-pressed={split} onClick={onPair} title={pair.title}>{split ? "退出对照" : `对照 · ${KIND_LABEL[pair.kind]}`}</Button>}
          {story && <span className="lens-steps"><Button variant="unstyled" type="button" aria-label="上一条" disabled={index <= 0} onClick={() => onStep(-1)}>‹</Button><span>{index + 1} / {count}</span><Button variant="unstyled" type="button" aria-label="下一条" disabled={index >= count - 1} onClick={() => onStep(1)}>›</Button></span>}
          <Button variant="unstyled" type="button" className="lens-close" aria-label="关闭要点" onClick={onClose}>✕</Button>
        </>}
      </div>
    </header>
    <div className="lens-body">
      <div className="lens-chart">
        {columns && <Bars columns={columns} nodeColor={nodeColor} />}
        {shares && <Shares shares={shares} nodeColor={nodeColor} />}
        {ladder && <Ladder ladder={ladder} nodeColor={nodeColor} />}
      </div>
      <div className="lens-text">
        <p className="lens-judgment">{compact ? finding.judgment.text.split(/(?<=。)/)[0] : finding.judgment.text}<span className="cites">{finding.judgment.sourceIds.map(id => { const i = cited.findIndex(s => s.id === id); return i < 0 ? null : <a key={id} href={cited[i].url} target="_blank" rel="noopener noreferrer" title={cited[i].title}>{i + 1}</a>; })}</span></p>
        <dl className="lens-evidence">
          {finding.resolved.map((r, i) => <Evidence key={i} r={r} />)}
        </dl>
        {watch && <div className="lens-watch" data-settled={outcome ? "" : undefined}>
          <p><b>{watch.horizon === "next_quarter" ? "下季跟踪" : "全年跟踪"}</b>{watch.condition}</p>
          {outcome ? <p className="lens-outcome"><b>{shortPeriod(outcome.periodEnd)} 已披露</b><Outcome r={outcome.resolved} /></p>
            : <p className="lens-outcome lens-outcome--pending">等待 {shortPeriod(watchPeriodOf(finding))} 财报</p>}
        </div>}
        {cited.length > 0 && <ol className="sources sources--numbered">{cited.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<span aria-hidden="true"> ↗</span></a></li>)}</ol>}
      </div>
    </div>
  </section>;
}

const watchPeriodOf = (f: VerifiedFinding) => watchPeriod(f.periodEnd, f.watch!);

/** The watched figure as it came in: value, comparison and, against guidance, whether it landed inside. */
function Outcome({ r }: { r: ResolvedEvidence }) {
  return <span className="lens-outcome-body">
    <span>{r.label} <b data-trend={r.current.value < 0 && r.current.unit === "USD" ? "down" : undefined}>{formatValue(r.current)}</b></span>
    {r.guidance ? <em data-verdict={r.guidance.verdict}>{r.guidance.unit === "percent" && r.current.unit !== "percent" ? `同比 ${percent(r.guidance.measured)} · ` : ""}{VERDICT[r.guidance.verdict]}{r.compare ? ` ${formatValue(r.compare)}` : ""}</em>
      : r.compare ? <em data-trend={trend(r.delta)}>{r.compareLabel} {formatValue(r.compare)} · {r.current.unit === "percent" || r.current.unit === "ratio" ? `${percent(r.delta)} 点` : percent(r.delta)}</em> : null}
  </span>;
}

function Evidence({ r }: { r: ResolvedEvidence }) {
  const note = r.guidance ? <em data-verdict={r.guidance.verdict}>{VERDICT[r.guidance.verdict]}{r.compare ? ` ${formatValue(r.compare)}` : ""}</em>
    : r.compare ? <em data-trend={trend(r.delta)}>{r.compareLabel} {formatValue(r.compare)} · {r.current.unit === "percent" || r.current.unit === "ratio" ? `${percent(r.delta)} 点` : percent(r.delta)}</em> : null;
  return <div className="lens-row">
    <dt>{r.label}<small>{spanLabel(r.current)}</small></dt>
    <dd><b data-trend={r.current.value < 0 && r.current.unit === "USD" ? "down" : undefined}>{formatValue(r.current)}</b>{note}</dd>
  </div>;
}

/** Grouped bars per period, one group per series, standing on a shared zero line so a negative figure reads as one. */
function Bars({ columns, nodeColor }: { columns: LensColumns; nodeColor: (id: string) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = columns.series.flatMap(s => s.values.map(v => v?.value ?? 0));
  const top = Math.max(0, ...values), bottom = Math.min(0, ...values), range = top - bottom || 1;
  const y = (v: number) => (v - bottom) / range * 100;
  const zero = y(0);
  const colors = columns.series.map((s, i) => refColor(s.ref, nodeColor, i));
  const unit = columns.series[0]?.unit ?? "USD", currency = columns.series[0]?.values.find(v => v)?.currency ?? "USD";
  const fmt = (v: number) => unit === "USD" ? (v < 0 ? "−" : "") + money(Math.abs(v), currency) : unit === "percent" ? `${Number(v.toFixed(1))}%` : unit === "ratio" ? v.toFixed(2) : String(Number(v.toFixed(2)));
  const label = columns.span === "fiscal_year" ? (end: string) => `FY 至 ${shortPeriod(end)}` : shortPeriod;
  return <div className="lens-bars" role="list" style={{ "--cols": columns.periods.length } as CSSProperties} onMouseLeave={() => setHover(null)}>
    <div className="lens-legend">{columns.series.map((s, i) => <span key={i}><i style={{ background: colors[i] }} />{s.label}</span>)}{columns.rateLabel && <span className="lens-legend-rate">{columns.rateLabel}</span>}</div>
    <div className="lens-plot">
      <i className="lens-zero" style={{ bottom: `${zero}%` }} aria-hidden="true" />
      {columns.periods.map((end, c) => {
        const shown = hover === c || (hover == null && c === columns.periods.length - 1);
        return <div key={end} className="lens-col" role="listitem" data-current={c === columns.periods.length - 1 || undefined} onMouseEnter={() => setHover(c)}
          aria-label={`${label(end)}：${columns.series.map((s, i) => `${s.label} ${s.values[c] ? fmt(s.values[c]!.value) : "未披露"}`).join("，")}${columns.rates[c] != null ? `，${columns.rateLabel} ${percent(columns.rates[c])}` : ""}`}>
          <div className="lens-group">
            {columns.series.map((s, i) => {
              const v = s.values[c]?.value ?? null;
              const lo = v == null ? zero : Math.min(y(v), zero), hi = v == null ? zero : Math.max(y(v), zero);
              return <span key={i} className="lens-slot"><i className="lens-bar" data-missing={v == null || undefined} data-negative={v != null && v < 0 || undefined}
                style={{ bottom: `${lo}%`, height: v == null ? "2px" : `max(2px, ${hi - lo}%)`, background: v != null && v < 0 ? "var(--loss)" : colors[i], "--i": c } as CSSProperties}>
                {shown && v != null && <span className="lens-value">{fmt(v)}</span>}
              </i></span>;
            })}
          </div>
          <span className="lens-period">{label(end)}{columns.rates[c] != null && <b data-trend={trend(columns.rates[c])}>{percent(columns.rates[c])}</b>}</span>
        </div>;
      })}
    </div>
  </div>;
}

/** Contracted revenue not yet recognised: its quarterly path on top, and below it when the latest balance is expected to convert. */
function Ladder({ ladder, nodeColor }: { ladder: LensLadder; nodeColor: (id: string) => string }) {
  const latest = ladder.latest;
  const span = (s: { from: number; to: number | null }) => s.from === 0 && s.to != null ? `${s.to} 个月内` : s.to == null ? `${s.from + 1} 个月以后` : `${s.from + 1}–${s.to} 个月`;
  return <div className="lens-ladder">
    <Bars columns={ladder.columns} nodeColor={nodeColor} />
    {latest ? <div className="lens-rungs" role="list" aria-label={`截至 ${shortPeriod(latest.asOf)} 的 RPO ${money(latest.total, latest.currency)} 的确认节奏`}>
      <span className="lens-rungs-title">确认节奏 · {shortPeriod(latest.asOf)}</span>
      <div className="lens-rungs-bar" aria-hidden="true">
        {latest.steps.map((s, i) => s.share != null && <i key={i} style={{ flexGrow: s.share, "--i": i } as CSSProperties} />)}
        {latest.remainder != null && <i className="lens-rung--rest" style={{ flexGrow: latest.remainder } as CSSProperties} />}
      </div>
      <div className="lens-rungs-legend">
        {latest.steps.map((s, i) => <span key={i} role="listitem"><i style={{ "--i": i } as CSSProperties} /><b>{span(s)}</b>{s.share != null ? `${Number(s.share.toFixed(1))}%` : ""}{s.amount != null ? ` · ${money(s.amount, latest.currency)}` : ""}</span>)}
        {latest.remainder != null && <span role="listitem"><i className="lens-rung--rest" /><b>之后</b>{Number(latest.remainder.toFixed(1))}% · {money(latest.total * latest.remainder / 100, latest.currency)}</span>}
      </div>
    </div> : <p className="lens-empty">该期财报未标注 RPO 的确认节奏</p>}
  </div>;
}

/** Stacked share of revenue by business over the disclosed quarters; the newest column carries each share. */
function Shares({ shares, nodeColor }: { shares: LensShares; nodeColor: (id: string) => string }) {
  const periods = shares.periods.map((end, i) => ({ end, row: shares.shares[i] })).filter(p => p.row.every(v => Number.isFinite(v)));
  if (periods.length < 2) return <div className="lens-empty">可比的分业务季度不足，无法绘制占比。</div>;
  const x = (i: number) => i / (periods.length - 1) * 100;
  const stack = periods.map(p => p.row.reduce<number[]>((acc, v) => [...acc, (acc.at(-1) ?? 0) + v], []));
  const area = (n: number) => {
    const upper = periods.map((_, i) => `${x(i).toFixed(2)},${(100 - stack[i][n] * 100).toFixed(2)}`);
    const lower = periods.map((_, i) => `${x(i).toFixed(2)},${(100 - (n ? stack[i][n - 1] : 0) * 100).toFixed(2)}`).reverse();
    return `M${upper.join("L")}L${lower.join("L")}Z`;
  };
  const last = periods.at(-1)!;
  return <div className="lens-shares" role="img" aria-label={`各业务占总收入的比例，${shortPeriod(periods[0].end)} 至 ${shortPeriod(last.end)}：${shares.nodes.map((n, i) => `${n.label} ${(last.row[i] * 100).toFixed(0)}%`).join("，")}`}>
    <div className="lens-legend">{shares.nodes.map((n, i) => <span key={n.id}><i style={{ background: nodeColor(n.id) }} />{n.label}<b>{(last.row[i] * 100).toFixed(0)}%</b></span>)}</div>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {shares.nodes.map((n, i) => <path key={n.id} d={area(i)} style={{ fill: nodeColor(n.id), "--i": i } as CSSProperties} />)}
      {[0.25, 0.5, 0.75].map(t => <line key={t} x1="0" x2="100" y1={100 - t * 100} y2={100 - t * 100} vectorEffect="non-scaling-stroke" />)}
    </svg>
    <div className="lens-axis">{periods.map((p, i) => <span key={p.end} style={{ left: `${x(i)}%` }} data-edge={i === 0 ? "start" : i === periods.length - 1 ? "end" : undefined}>{shortPeriod(p.end)}</span>)}</div>
  </div>;
}
