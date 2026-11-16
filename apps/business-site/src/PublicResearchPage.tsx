import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/packages/web/src/i18n";
import { ReportMarkdown, safeReportUrl } from "@/packages/web/src/report/report-blocks/ReportMarkdown";
import type { PublicReportVersion, PublicResearchRead } from "@/shared/analysis-contract/public-research";
import { parsePublicResearchRead } from "@/shared/analysis-runtime/public-research";
import { LanguageToggle, ThemeToggle } from "./Sidebar";
import { ResearchList, usePublicResearchList } from "./PublicResearch";
import { freshnessWords, researchHref, researchWords as m } from "./public-research-ui";

function ReportBody({ report }: { report: PublicReportVersion }) {
  const historical = new URLSearchParams(location.search).has("version");
  return <article className="public-research-document" lang={report.language}>
    <header>
      <p className="public-research-meta"><span>{m[report.type]}</span><span>{freshnessWords[report.freshnessStatus]}</span>{report.coverage === "limited" && <span>{m.limited}</span>}</p>
      <h1>{report.title}</h1>
      <p className="public-research-lead">{report.summary}</p>
      <dl className="public-research-facts">
        <div><dt>{m.scope}</dt><dd>{report.scope.description} · {report.scope.regions.join(" · ")} · {report.scope.currency}</dd></div>
        <div><dt>{m.asOf}</dt><dd><time dateTime={report.asOf}>{report.asOf.slice(0, 10)}</time></dd></div>
        <div><dt>{m.published}</dt><dd><time dateTime={report.publishedAt}>{report.publishedAt.slice(0, 10)}</time></dd></div>
        <div><dt>{m.version}</dt><dd><code>{report.version}</code></dd></div>
        <div><dt>{m.original}</dt><dd>{report.language === "en" ? "English" : "中文"}</dd></div>
      </dl>
      {historical && <p className="public-research-notice">{m.historical} <a href={researchHref(report.reportId)} data-nav>{m.latest}</a></p>}
      {report.freshnessStatus === "updating" && <p className="public-research-notice" role="status">{m.pending}</p>}
      {["stale", "review_required", "unavailable"].includes(report.freshnessStatus) && <p className="public-research-notice" role="status">{m.stale}</p>}
    </header>
    <section aria-labelledby="research-changes"><h2 id="research-changes">{m.changes}</h2><ul>{report.changes.map((change, i) => <li key={i}>{change}</li>)}</ul></section>
    <ReportMarkdown markdown={report.bodyMarkdown} />
    <section aria-labelledby="research-claims"><h2 id="research-claims">{m.notes}</h2>{report.claims.map(claim => <details key={claim.id} id={`claim-${claim.id}`}>
      <summary>{claim.title}</summary><p>{claim.statement}</p><p>{claim.verification}</p>
      <ul>{claim.counterEvidence.map((text, i) => <li key={i}>{text}</li>)}</ul>
      <ul>{claim.sourceIds.map(sourceId => { const source = report.sources.find(item => item.id === sourceId); return source ? <li key={sourceId}><a href={`#source-${sourceId}`} onClick={() => { const details = document.getElementById(`source-${sourceId}`); if (details instanceof HTMLDetailsElement) details.open = true; }}>{source.title} · {source.locator}</a></li> : null; })}</ul>
    </details>)}</section>
    {report.missingInputs.length > 0 && <section aria-labelledby="research-limitations"><h2 id="research-limitations">{m.notes}</h2><ul>{report.missingInputs.map((gap, i) => <li key={i}>{gap}</li>)}</ul></section>}
    <section className="public-research-sources sources" aria-labelledby="research-sources"><h2 id="research-sources">{m.sources}</h2>
      {report.sources.map(source => <details key={source.id} id={`source-${source.id}`}>
        <summary>{source.title} · {source.locator}</summary>
        <blockquote>{source.excerpt}</blockquote>
        <p>{m.published} <time dateTime={source.publishedAt}>{source.publishedAt.slice(0, 10)}</time></p>
        {safeReportUrl(source.uri) && <a href={source.uri} target="_blank" rel="noopener noreferrer">{source.title} <span aria-hidden="true">↗</span></a>}
      </details>)}
    </section>
    {report.dependencies.length > 0 && <section><h2>{m.related}</h2><ul>{report.dependencies.map(dep => <li key={`${dep.reportId}:${dep.version}:${dep.claimId}`}><a href={`${researchHref(dep.reportId, dep.version)}#claim-${dep.claimId}`} data-nav>{dep.reportId} · {m.version} {dep.version}</a></li>)}</ul></section>}
  </article>;
}

function ReportReader({ id, version }: { id: string; version: string | null }) {
  const [read, setRead] = useState<PublicResearchRead | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const query = version ? `?version=${encodeURIComponent(version)}` : "";
    fetch(`/api/business/v1/research/${encodeURIComponent(id)}${query}`, { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async response => { if (!response.ok) { if (!controller.signal.aborted) setFailed(response.status); return; } const body = parsePublicResearchRead(await response.json()); if (!body) throw new Error("Invalid research response"); if (!controller.signal.aborted) setRead(body); })
      .catch(() => { if (!controller.signal.aborted) setFailed(0); });
    return () => controller.abort();
  }, [id, version, attempt]);
  useEffect(() => {
    if (!read?.report) return;
    document.title = `${read.report.title} · Business View`;
    const target = document.getElementById(location.hash.slice(1));
    if (target instanceof HTMLDetailsElement) target.open = true;
    target?.scrollIntoView();
  }, [read]);
  if (failed !== null) return <div className="public-research-status" role="status"><h1>{failed === 401 || failed === 403 ? m.denied : failed === 404 ? m.missing : m.error}</h1><button type="button" onClick={() => { setFailed(null); setAttempt(n => n + 1); }}>{m.retry}</button></div>;
  if (!read) return <p className="public-research-status" role="status">{m.loading}</p>;
  return <>
    {read.status === "available" && read.report ? <ReportBody report={read.report} /> : <div className="public-research-status" role="status"><h1>{read.status === "withdrawn" ? m.withdrawn : m.missing}</h1></div>}
    {read.history.length > 0 && <section className="public-research-history" aria-labelledby="research-history"><h2 id="research-history">{m.history}</h2><ol>{read.history.map(item => <li key={item.version}><a href={researchHref(item.reportId, item.version)} data-nav aria-current={read.report?.version === item.version ? "page" : undefined}>{item.publishedAt.slice(0, 10)} · {item.title}<small>{m.version} {item.version}</small></a></li>)}</ol></section>}
  </>;
}

export default function PublicResearchPage({ href, light, onToggleTheme }: { href: string; light: boolean; onToggleTheme: () => void }) {
  useLocale();
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = document.getElementById(location.hash.slice(1));
    if (target instanceof HTMLDetailsElement) target.open = true;
    if (target) target.scrollIntoView();
    else stage.current?.scrollTo(0, 0);
  }, [href]);
  const url = new URL(href, location.origin);
  const idPart = url.pathname.match(/^\/research\/([^/]+)\/?$/)?.[1];
  let id: string | null = null;
  try { id = idPart ? decodeURIComponent(idPart) : null; } catch { /* An invalid route has no report. */ }
  const type = url.searchParams.get("type");
  const [query, setQuery] = useState("");
  const { result, error, retry } = usePublicResearchList();
  const reports = (result?.reports ?? []).filter(report => (!type || report.type === type) && `${report.title} ${report.scope.industryId ?? ""} ${report.scope.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <main className="public-research-page" tabIndex={-1}>
    <aside className="public-research-rail" aria-label={m.research}>
      <div className="public-research-tools"><a href="/" data-nav>{m.home}</a><ThemeToggle light={light} onToggle={onToggleTheme} /><LanguageToggle /></div>
      <nav aria-label={m.research}><a href="/research" data-nav aria-current={!id && !type ? "page" : undefined}>{m.all}</a><a href="/research?type=macro" data-nav aria-current={!id && type === "macro" ? "page" : undefined}>{m.macro}</a><a href="/research?type=industry" data-nav aria-current={!id && type === "industry" ? "page" : undefined}>{m.industry}</a></nav>
    </aside>
    <div className="public-research-stage" ref={stage} tabIndex={0}>
      {id ? <ReportReader key={`${id}:${url.searchParams.get("version") ?? "current"}`} id={id} version={url.searchParams.get("version")} /> : <section className="public-research-index">
        <h1>{type === "macro" ? m.macro : type === "industry" ? m.industry : m.research}</h1>
        {type !== "macro" && <label className="public-research-search">{m.search}<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>}
        {error ? <p role="status">{m.error} <button type="button" onClick={retry}>{m.retry}</button></p> : !result ? <p role="status">{m.loading}</p> : reports.length ? <ResearchList reports={reports} /> : <p role="status">{query ? m.emptySearch : m.unavailable}</p>}
      </section>}
    </div>
  </main>;
}
