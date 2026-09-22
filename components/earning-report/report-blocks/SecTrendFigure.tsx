import { scaleLinear, scaleUtc } from "d3-scale";
import type { SecTrend } from "@/shared/analysis-contract/sec-presentation.ts";

type TrendProps = { id: string; title: string; trend: SecTrend; mark?: "line" | "bar"; caption?: string };

/** Stored reports also pass this guard: generation-time validation does not protect old snapshots. */
export function readableTrend(value: SecTrend | undefined): SecTrend | null {
  if (!value || !Array.isArray(value.points) || value.points.length > 60
    || typeof value.unit !== "string" || typeof value.basis !== "string"
    || !["annual", "quarter"].includes(value.periodScope)
    || value.points.some((p) => !p || !Number.isFinite(p.value) || typeof p.date !== "string"
      || !/^\d{4}-\d{2}-\d{2}$/.test(p.date) || !Number.isFinite(Date.parse(p.date)) || typeof p.accession !== "string")
    || new Set(value.points.map((p) => p.date)).size !== value.points.length) return null;
  return { ...value, points: [...value.points].sort((a, b) => a.date.localeCompare(b.date)) };
}

function valueText(value: number, trend: SecTrend, exact = false) {
  if (trend.unit === "ratio") return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 }).format(value);
  if (exact) return value.toLocaleString("zh-CN", { maximumFractionDigits: 10 });
  const magnitude = Math.abs(value);
  const suffix = magnitude >= 1e8 ? " 亿" : magnitude >= 1e4 ? " 万" : "";
  const divisor = magnitude >= 1e8 ? 1e8 : magnitude >= 1e4 ? 1e4 : 1;
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, minimumFractionDigits: divisor > 1 ? 2 : 0 }).format(value / divisor)}${suffix}`;
}

/** All figures share verified values; two observations are a comparison, never an interpolated trend. */
export function SecTrendFigure({ id, title, trend: input, mark = "line", caption }: TrendProps) {
  const trend = readableTrend(input);
  if (!trend || !trend.points.length) return <div className="report-content-fallback" id={id}>{title}：暂无可绘制的可比数据。</div>;
  const { points } = trend;
  const comparison = points.length === 2;
  const unit = trend.unit === "ratio" ? "%" : trend.unit;
  const min = Math.min(0, ...points.map((p) => p.value));
  const max = Math.max(0, ...points.map((p) => p.value));
  const domain: [number, number] = min === max ? [0, 1] : [min, max];
  const bar = scaleLinear().domain(domain).range([0, 100]);
  const x = scaleUtc().domain([new Date(points[0].date), new Date(points.at(-1)!.date)]).range([45, 535]);
  const y = scaleLinear().domain(domain).range([180, 25]);
  return <figure id={id} className="report-content-figure" data-chart-kind={points.length === 1 ? "single" : comparison ? "comparison" : "timeline"}>
    <figcaption><strong>{title}</strong><small>{unit} · {trend.periodScope === "annual" ? "年度" : "季度"} · {trend.basis.toUpperCase()} · SEC XBRL</small></figcaption>
    {points.length === 1 ? <div className="report-content-single"><strong>{valueText(points[0].value, trend)}</strong><span>{points[0].date}</span></div>
      : comparison ? <div className="report-content-comparison" role="img" aria-label={`${title}；${points.map((p) => `${p.date}：${valueText(p.value, trend)} ${unit}`).join("；")}`}>
        {points.map((p, index) => <div className="report-content-comparison-row" key={p.date} data-current={index === points.length - 1}>
          <div><span>{p.date}</span><strong data-chart-value={p.value}>{valueText(p.value, trend)}</strong></div>
          <svg viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true">
            <line x1={bar(0)} x2={bar(0)} y1="0" y2="18" className="report-content-chart-zero" vectorEffect="non-scaling-stroke" />
            <rect x={Math.min(bar(0), bar(p.value))} y="2" width={Math.abs(bar(p.value) - bar(0))} height="14" rx="1" className="report-content-chart-bar" />
          </svg>
        </div>)}
      </div> : <div className="report-content-timeline">
        <svg viewBox="0 0 580 220" preserveAspectRatio="none" role="img" aria-labelledby={`${id}-description`}>
          <title id={`${id}-description`}>{`${title}；${points.map((p) => `${p.date}：${valueText(p.value, trend)}`).join("；")}`}</title>
          <line x1="25" x2="555" y1={y(0)} y2={y(0)} className="report-content-chart-zero" vectorEffect="non-scaling-stroke" />
          {mark === "line" && <polyline points={points.map((p) => `${x(new Date(p.date))},${y(p.value)}`).join(" ")} fill="none" className="report-content-chart-line" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
          {points.map((p, index) => <g key={p.date} data-current={index === points.length - 1}>
            {mark === "bar" ? <rect x={x(new Date(p.date)) - Math.min(12, 180 / points.length)} y={Math.min(y(0), y(p.value))} width={Math.min(24, 360 / points.length)} height={Math.abs(y(p.value) - y(0))} className="report-content-chart-bar" />
              : <circle cx={x(new Date(p.date))} cy={y(p.value)} r="3" className="report-content-chart-point" />}
          </g>)}
        </svg>
        {points.map((p, index) => <span key={p.date} className="report-content-chart-label" data-sparse-hidden={points.length > 6 && index > 0 && index < points.length - 1 && (index % 2 !== 0 || index === points.length - 2) || undefined} data-compact-hidden={points.length > 4 && index > 0 && index < points.length - 1 || undefined} style={{ left: `${x(new Date(p.date)) / 580 * 100}%`, top: `${Math.max(0, y(p.value) - 24) / 220 * 100}%` }}>{valueText(p.value, trend)}</span>)}
        <div className="report-content-chart-dates"><span>{points[0].date}</span><span>{points.at(-1)!.date}</span></div>
      </div>}
    {caption && <p className="report-content-caption">{caption}</p>}
  </figure>;
}

/** Kept outside floating media so opening a source table never squeezes the article. */
export function SecTrendSource({ title, trend: input }: Pick<TrendProps, "title" | "trend">) {
  const trend = readableTrend(input);
  if (!trend?.points.length) return null;
  const unit = trend.unit === "ratio" ? "%" : trend.unit;
  return <details className="report-content-source"><summary>{title} · 查看数据与来源</summary><div className="report-content-table-scroll" tabIndex={0} role="region" aria-label={`${title}原始数据`}>
    <table><thead><tr><th scope="col">期间</th><th scope="col">数值（{unit}）</th><th scope="col">SEC accession</th></tr></thead>
      <tbody>{trend.points.map((p) => <tr key={p.date}><th scope="row">{p.date}</th><td data-chart-value={p.value}>{valueText(p.value, trend, true)}</td><td>{p.accession}</td></tr>)}</tbody>
    </table></div></details>;
}
