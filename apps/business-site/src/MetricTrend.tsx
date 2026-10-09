import { Button } from "@/packages/web/src/ui/button";
import { ChartContainer, ChartLegendContent, ChartTooltipContent, type ChartConfig } from "@/packages/web/src/ui/chart";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/packages/web/src/ui/native-select";
import { ToggleGroup, ToggleGroupItem } from "@/packages/web/src/ui/toggle-group";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { BusinessFlowQuarter } from "@/shared/analysis-contract/business-flow";
import { compactFlowValue } from "@/packages/web/src/model/business-flow-layout";
import { REVENUE_METRIC, metricChanges, metricTicks, type MetricOption, type MetricTrend } from "./metric-model";
import { growth, rateTicks } from "./trend-model";

const DAY = 86_400_000;
const shortPeriod = (end: string) => end.slice(0, 7).replace("-", ".");
const periodLabel = (end: string) => <time dateTime={end}><span>{end.slice(0, 4)}</span><span className="trend-period-month">{end.slice(5, 7)}</span></time>;
const sign = (v: number) => v > 0 ? "+" : v < 0 ? "−" : "";
const percent = (v: number | null) => v == null ? "—" : `${sign(v)}${Math.abs(v).toFixed(1)}%`;
const points = (v: number | null) => v == null ? "—" : `${sign(v)}${Math.abs(v).toFixed(1)} 个百分点`;
const axisPercent = (v: number) => `${v < 0 ? "−" : ""}${Number(Math.abs(v).toFixed(1))}%`;
const direction = (v: number | null) => v == null || v === 0 ? undefined : v > 0 ? "up" : "down";
/** Flow quarters and SEC periods may end a few days apart (52/53-week years); they are the same quarter. */
const sameQuarter = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 20 * DAY;

/** The trend's metric picker: revenue (by business) first, then the SEC series grouped as the statements present them. */
export function MetricPicker({ value, groups, revenue, onChange }: { value: string; groups: Array<{ group: string; options: MetricOption[] }>; revenue: boolean; onChange: (key: string) => void }) {
  if (!groups.length) return null;
  return <span className="metric-select">
    <NativeSelect appearance="native" aria-label="图表指标" value={value} onChange={event => onChange(event.target.value)}>
      {revenue && <NativeSelectOption value={REVENUE_METRIC}>收入 · 按业务</NativeSelectOption>}
      {groups.map(g => <NativeSelectOptGroup key={g.group} label={g.group}>
        {g.options.map(o => <NativeSelectOption key={o.key} value={o.key}>{o.label}</NativeSelectOption>)}
      </NativeSelectOptGroup>)}
    </NativeSelect>
  </span>;
}

function formatter(trend: MetricTrend) {
  const unit = { currency: trend.currency || "USD", scale: 1 } as BusinessFlowQuarter;
  return (v: number | null): string => {
    if (v == null || !Number.isFinite(v)) return "—";
    switch (trend.unitFamily) {
      case "percent": return `${v.toFixed(1)}%`;
      case "multiple": return `${v.toFixed(1)}×`;
      case "per_share": return `${v < 0 ? "−" : ""}${trend.currency === "USD" || !trend.currency ? "$" : ""}${Math.abs(v).toFixed(2)}${trend.currency && trend.currency !== "USD" ? ` ${trend.currency}` : ""}`;
      case "shares": return `${compactFlowValue(v, { currency: "", scale: 1 } as BusinessFlowQuarter).trim()} 股`;
      default: return compactFlowValue(v, unit);
    }
  };
}

/**
 * One company-level SEC series over the same quarters as the revenue trend: bars from a zero line (losses and negative cash
 * flow hang below it), and for amounts a growth line on the right axis. Rates are already in points, so their change is
 * stated in points and drawn as no second line. Gaps stay gaps.
 */
export function MetricTrendPanel({ trend, picker, currentPeriod, periods, onPickPeriod }: {
  trend: MetricTrend; picker: ReactNode; currentPeriod: string | null; periods: Set<string>; onPickPeriod: (periodEnd: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [series, setSeries] = useState<"bar" | "line" | null>(null);
  const [chosenLag, setLag] = useState<1 | 4 | null>(null);
  const format = useMemo(() => formatter(trend), [trend]);
  const rate = trend.unitFamily !== "percent";
  const lag = chosenLag ?? (metricChanges(trend, 4).filter(v => v != null).length >= 2 ? 4 : 1);
  const changes = useMemo(() => metricChanges(trend, lag), [trend, lag]);
  const ticks = metricTicks(trend);
  const lo = ticks[0], hi = ticks[3];
  const y = (v: number) => (v - lo) / (hi - lo) * 100;
  const rateAxis = useMemo(() => rate ? rateTicks(changes) : null, [rate, changes]);
  const rateY = (v: number) => rateAxis ? (v - rateAxis[0]) / (rateAxis[3] - rateAxis[0]) * 100 : 0;
  const rateName = lag === 4 ? "同比增速" : "环比增速";
  const known = trend.points.filter(p => p.value != null);
  const last = trend.history.at(-1)?.value ?? null, yearAgo = trend.history.at(-5)?.value ?? null;
  const change = (a: number | null, b: number | null) => rate ? percent(growth(a, b)) : a != null && b != null ? points(a - b) : "—";
  const changeTrend = (a: number | null, b: number | null) => direction(rate ? growth(a, b) : a != null && b != null ? a - b : null);
  // The quarter shown in the flow chart; the newest when the series does not reach it.
  const shown = currentPeriod ? trend.points.findIndex(p => sameQuarter(p.periodEnd, currentPeriod)) : -1;
  const current = shown >= 0 ? shown : trend.points.length - 1;
  const flowPeriod = (end: string) => [...periods].find(p => sameQuarter(p, end)) ?? null;
  const config = useMemo<ChartConfig>(() => ({ [trend.key]: { label: trend.label, color: "var(--biz-0)" }, growth: { label: rateName, color: "var(--foreground)" } }), [trend, rateName]);

  return <ChartContainer asChild config={config}><section className="trend" data-view="metric" aria-label={`${trend.label} 近 ${trend.points.length} 季`} onMouseLeave={() => { setHover(null); setSeries(null); }}>
    <header className="trend-head">
      <div className="trend-title">
        <div className="trend-heading"><h2>公司整体</h2>{picker}</div>
        <ChartLegendContent asChild key={"legend" + trend.key}><div className="trend-legend">
          {rateAxis && <span className="trend-legend-line" style={{ "--line": "var(--foreground)" } as CSSProperties}><i />{rateName} · 右轴</span>}
          <span className="trend-basis">SEC XBRL 季度值 · 不按业务拆分</span>
          {rate && !rateAxis && <span className="trend-basis">比较期缺失或不为正，不计算增速</span>}
        </div></ChartLegendContent>
      </div>
      <div className="trend-kpis">
        <dl>
          <div><dt>同比</dt><dd data-trend={changeTrend(last, yearAgo)}>{change(last, yearAgo)}</dd></div>
          {known.length > 1 && <div><dt>{shortPeriod(known[0].periodEnd)} 以来</dt><dd data-trend={changeTrend(known.at(-1)!.value, known[0].value)}>{change(known.at(-1)!.value, known[0].value)}</dd></div>}
        </dl>
        {rate && <ToggleGroup type="single" variant="unstyled" rovingFocus={false} value={String(lag)} onValueChange={next => { if (next) setLag(next === "4" ? 4 : 1); }} asChild>
          <span className="periods periods--small" role="radiogroup" aria-label="比较基期">
            <ToggleGroupItem value="4" role="radio" aria-checked={lag === 4}>同比</ToggleGroupItem>
            <ToggleGroupItem value="1" role="radio" aria-checked={lag === 1}>环比</ToggleGroupItem>
          </span>
        </ToggleGroup>}
      </div>
    </header>
    <div className="trend-plot" role="list" data-series={series ?? undefined} data-rates={rateAxis ? "" : undefined} style={{ "--line": "var(--foreground)", "--cols": trend.points.length } as CSSProperties}
      onMouseMove={e => setSeries((e.target as Element).closest("[data-series-line]") ? "line" : (e.target as Element).closest(".trend-col") ? "bar" : null)}>
      <div className="trend-grid" key={trend.key + hi} aria-hidden="true">
        {ticks.map((t, k) => <div key={t} data-zero={t === 0 && k > 0 ? "" : undefined} style={{ bottom: `${y(t)}%` }}><span>{format(t)}</span>{rateAxis && <em>{axisPercent(rateAxis[k])}</em>}</div>)}
      </div>
      <i className="trend-sweep" key={"sweep" + trend.key} aria-hidden="true" />
      {trend.points.map((point, i) => {
        const v = point.value, delta = changes[i];
        const top = v == null ? 0 : y(Math.max(0, v)), bottom = v == null ? 0 : y(Math.min(0, v));
        const pick = flowPeriod(point.periodEnd);
        const line = rateAxis && delta != null ? { y: rateY(delta), next: changes[i + 1] != null ? rateY(changes[i + 1]!) : null } : null;
        const labelled = i === current || series === "line";
        const nearBar = line != null && Math.abs(line.y - top) < 16;
        return <div key={point.periodEnd} className="trend-col" role="listitem" data-state={v == null ? "missing" : "ok"} data-current={i === current || undefined}
          data-align={i < 2 ? "start" : i > trend.points.length - 3 ? "end" : undefined} style={{ "--i": i } as CSSProperties} onMouseEnter={() => setHover(i)}>
          <Button variant="unstyled" type="button" className="trend-hit" disabled={!pick} onClick={() => pick && onPickPeriod(pick)} onFocus={() => setHover(i)}
            aria-label={`${shortPeriod(point.periodEnd)} ${trend.label} ${v == null ? "未披露" : format(v)}${pick ? "，在流向图中查看该季度" : ""}`} />
          <span className="trend-value" data-below={v != null && v < 0 || undefined} data-quiet={rateAxis && i !== current && !(hover === i && series !== "line") ? "" : undefined}
            style={{ bottom: `${v == null ? 22 : v < 0 ? bottom : top}%` }}>{format(v)}</span>
          {v != null ? <span className="trend-stack" data-negative={v < 0 || undefined} aria-hidden="true" style={{ top: "auto", bottom: `${bottom}%`, height: `${top - bottom}%` }}>
            <i data-on="" style={{ height: "100%", background: v < 0 ? "var(--loss)" : "var(--biz-0)" }} />
          </span> : <span className="trend-stack" aria-hidden="true"><i className="trend-ghost" /></span>}
          {line && line.next != null && <svg className="trend-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" y1={100 - line.y} x2="100" y2={100 - line.next} vectorEffect="non-scaling-stroke" />
            <line className="trend-line-hit" data-series-line="" x1="0" y1={100 - line.y} x2="100" y2={100 - line.next} vectorEffect="non-scaling-stroke" />
          </svg>}
          {line && <i className="trend-dot" data-series-line="" data-hover={hover === i || undefined} aria-hidden="true" style={{ bottom: `${line.y}%` }} />}
          {line && labelled && <span className="trend-rate" data-trend={direction(delta)} data-below={delta! < 0 || nearBar || undefined} aria-hidden="true"
            style={{ bottom: `${nearBar ? Math.min(line.y, top) : line.y}%` }}>{percent(delta)}</span>}
          <span className="trend-period">{periodLabel(point.periodEnd)}{i === current && <b>本季</b>}</span>
          {hover === i && <ChartTooltipContent asChild><div className="trend-tip" role="presentation">
            <div className="trend-tip-title">{shortPeriod(point.periodEnd)} · {trend.label}</div>
            <div className="trend-tip-row trend-tip-lead"><span>{series === "line" && rate ? rateName : "本季"}</span><b data-trend={series === "line" ? direction(delta) : undefined}>{series === "line" && rate ? percent(delta) : format(v)}</b></div>
            {series !== "line" && delta != null && <div className="trend-tip-row"><span>{lag === 4 ? "同比" : "环比"}</span><b data-trend={direction(delta)}>{rate ? percent(delta) : points(delta)}</b></div>}
            {v == null && <p>该季度未取得可核验的 SEC 披露</p>}
            {v != null && delta == null && <p>{rate ? "比较期缺失或不为正，增速留空" : "比较期缺失"}</p>}
            {point.accession && <p className="trend-tip-source">SEC {point.accession}</p>}
          </div></ChartTooltipContent>}
        </div>;
      })}
    </div>
  </section></ChartContainer>;
}
