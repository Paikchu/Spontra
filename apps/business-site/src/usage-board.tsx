import { VITAL_METRICS, type TelemetryRange, type TelemetrySummary, type VitalMetric } from "./telemetry.ts";
import "./usage-board.css";

export type UsageLabels = {
  title: string;
  empty: string;
  unavailable: string;
  retry: string;
  utc: string;
  sessions: string;
  pageViews: string;
  companies: string;
  searches: string;
  events: string;
  expand: string;
  errors: string;
  none: string;
  ranges: Record<TelemetryRange, string>;
  eventName: Record<string, string>;
  vitals: string;
  samples: string;
  vitalRoute: Record<"home" | "company", string>;
  vitalName: Record<VitalMetric, string>;
};

function vital(key: VitalMetric, value: number | null): string {
  if (value == null) return "—";
  if (key === "cls") return (value / 1000).toFixed(3);
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;
}

function percent(value: number | null): string {
  if (value == null) return "—";
  return `${Math.round(value * 1000) / 10}%`;
}

/** Product-usage cards for the admin dashboard. */
export function UsageBoard({ summary, range, onRange, labels, pending, failed, onRetry }: {
  summary: TelemetrySummary | null;
  range: TelemetryRange;
  onRange: (range: TelemetryRange) => void;
  labels: UsageLabels;
  pending?: boolean;
  failed?: boolean;
  onRetry?: () => void;
}) {
  const empty = !pending && !failed && !!summary && summary.events.every(item => item.count === 0);
  const maxSeries = Math.max(1, ...(summary?.series.map(item => item.pageViews) ?? [1]));
  const maxEvent = Math.max(1, ...(summary?.events.map(item => item.count) ?? [1]));
  const figure = (value: string) => <b className="usage-num" key={`${range}:${value}`}>{value}</b>;
  return <section className="usage-board" aria-label={labels.title} aria-busy={pending || undefined}>
    <div className="usage-head">
      <p className="usage-utc">{labels.utc}</p>
      <div className="usage-ranges" role="group" aria-label={labels.title}>
        {(["24h", "7d", "4w"] as const).map(key => <button key={key} type="button" aria-pressed={range === key} onClick={() => onRange(key)}>{labels.ranges[key]}</button>)}
      </div>
    </div>
    {failed ? <div className="usage-card"><p className="usage-empty">{labels.unavailable}</p>{onRetry && <button type="button" className="usage-retry" onClick={onRetry}>{labels.retry}</button>}</div>
      : empty ? <div className="usage-card"><p className="usage-empty">{labels.empty}</p></div>
        : <>
          <div className="usage-kpis">
            <article className="usage-card"><h2>{labels.sessions}</h2>{figure(pending || !summary ? "—" : String(summary.sessions))}</article>
            <article className="usage-card"><h2>{labels.pageViews}</h2>{figure(pending || !summary ? "—" : String(summary.pageViews))}</article>
            <article className="usage-card"><h2>{labels.expand}</h2>{figure(pending || !summary ? "—" : percent(summary.expandRate))}</article>
            <article className="usage-card"><h2>{labels.errors}</h2>{figure(pending || !summary ? "—" : percent(summary.errorRate))}</article>
          </div>
          <div className="usage-columns">
            <article className="usage-card">
              <h2>{labels.pageViews}</h2>
              <ul className="usage-meters">
                {(summary?.series ?? []).map((item, index) => <li key={item.label} className="usage-meter">
                  <span>{item.label}</span>
                  <span className="usage-bar" aria-hidden="true"><i data-tone={(index % 4) + 1} style={{ ["--w" as string]: `${(item.pageViews / maxSeries) * 100}%` }} /></span>
                  <b>{item.pageViews}</b>
                </li>)}
              </ul>
            </article>
            <article className="usage-card">
              <h2>{labels.companies}</h2>
              {summary && summary.topCompanies.length === 0 ? <p className="usage-empty">{labels.none}</p> : <ul className="usage-list">
                {summary?.topCompanies.map(item => <li key={item.ticker} className="usage-row"><span lang="en">{item.ticker}</span><b>{item.views}</b></li>)}
              </ul>}
            </article>
            <article className="usage-card">
              <h2>{labels.searches}</h2>
              {summary && summary.emptySearches.length === 0 ? <p className="usage-empty">{labels.none}</p> : <ol className="usage-list">
                {summary?.emptySearches.map(item => <li key={item.query} className="usage-row"><span>{item.query}</span><b>{item.count}</b></li>)}
              </ol>}
            </article>
            <article className="usage-card">
              <h2>{labels.events}</h2>
              <ul className="usage-meters">
                {(summary?.events ?? []).map((item, index) => <li key={item.name} className="usage-meter">
                  <span>{labels.eventName[item.name] ?? item.name}</span>
                  <span className="usage-bar" aria-hidden="true"><i data-tone={(index % 4) + 1} style={{ ["--w" as string]: `${(item.count / maxEvent) * 100}%` }} /></span>
                  <b>{item.count}</b>
                </li>)}
              </ul>
            </article>
            <article className="usage-card usage-vitals">
              <h2>{labels.vitals}</h2>
              {!summary?.vitals?.length ? <p className="usage-empty">{labels.none}</p> : <table>
                <thead><tr><th scope="col" />{summary.vitals.map(item => <th scope="col" key={item.route}>{labels.vitalRoute[item.route]}</th>)}</tr></thead>
                <tbody>
                  {VITAL_METRICS.map(key => <tr key={key}><th scope="row">{labels.vitalName[key]}</th>{summary.vitals!.map(item => <td key={item.route}>{vital(key, item.p75[key])}</td>)}</tr>)}
                  <tr><th scope="row">{labels.samples}</th>{summary.vitals.map(item => <td key={item.route}>{item.samples}</td>)}</tr>
                </tbody>
              </table>}
            </article>
          </div>
        </>}
  </section>;
}
