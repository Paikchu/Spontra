import { useEffect, useState } from "react";
import { useLocale } from "@/packages/web/src/i18n";
import type { PublicReportSummary, PublicResearchList } from "@/shared/analysis-contract/public-research";
import { parsePublicResearchList } from "@/shared/analysis-runtime/public-research";
import { freshnessWords, researchHref, researchWords as m } from "./public-research-ui";
import "./public-research.css";

export function usePublicResearchList() {
  const [result, setResult] = useState<PublicResearchList | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/business/v1/research", { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async response => { if (!response.ok) throw new Error(String(response.status)); const body = parsePublicResearchList(await response.json()); if (!body) throw new Error("Invalid research response"); return body; })
      .then(body => { if (!controller.signal.aborted) { setResult(body); setError(false); } })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [attempt]);
  return { result, error, retry: () => { setError(false); setResult(null); setAttempt(n => n + 1); } };
}

export function ResearchList({ reports }: { reports: PublicReportSummary[] }) {
  useLocale();
  return <ol className="public-research-list">{reports.map(report => <li key={`${report.reportId}:${report.version}`}>
    <a href={researchHref(report.reportId, report.version)} data-nav lang={report.language}>
      <span className="public-research-meta"><span>{report.scope.regions.join(" · ")} · {report.scope.currency}</span><span>{freshnessWords[report.freshnessStatus]}</span></span>
      <h3>{report.title}</h3>
      <p>{report.summary}</p>
      <span className="public-research-meta"><span>{m.asOf} <time dateTime={report.asOf}>{report.asOf.slice(0, 10)}</time></span>{report.coverage === "limited" && <span>{m.limited}</span>}</span>
    </a>
  </li>)}</ol>;
}

export function HomeResearch() {
  useLocale();
  const { result, error, retry } = usePublicResearchList();
  return <section className="home-research" aria-label={m.research}>
    {(["macro", "industry"] as const).map(type => <section key={type} aria-labelledby={`research-${type}`}>
      <div className="home-section-head"><h2 id={`research-${type}`}><a href={`/research?type=${type}`} data-nav>{m[type]}</a></h2></div>
      {error ? <p className="public-research-status" role="status">{m.error} <button type="button" onClick={retry}>{m.retry}</button></p>
        : !result ? <p className="public-research-status" role="status">{m.loading}</p>
        : result.reports.filter(report => report.type === type).length ? <ResearchList reports={result.reports.filter(report => report.type === type).slice(0, 2)} />
        : <p className="public-research-status">{m.unavailable}</p>}
      <a className="public-research-browse" href={`/research?type=${type}`} data-nav>{m.browse} <span aria-hidden="true">→</span></a>
    </section>)}
  </section>;
}
