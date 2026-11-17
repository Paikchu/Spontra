import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/packages/web/src/i18n";
import { safeReportUrl } from "@/packages/web/src/report/report-blocks/ReportMarkdown";
import type { PublicReportVersion, PublicResearchRead, ResearchClaim } from "@/shared/analysis-contract/public-research";
import { parsePublicResearchRead } from "@/shared/analysis-runtime/public-research";
import { LanguageToggle, ThemeToggle } from "./Sidebar";
import { ResearchList, usePublicResearchList } from "./PublicResearch";
import { claimKindWords, freshnessWords, observationBasisWords, observationStatusWords, researchHref, researchWords as m, scenarioWords } from "./public-research-ui";

/** Hash links also open evidence and version disclosures before the browser scrolls. */
function revealResearchTarget(id: string) {
  const target = document.getElementById(id);
  for (let element = target; element; element = element.parentElement) {
    if (element instanceof HTMLDetailsElement) element.open = true;
  }
  target?.scrollIntoView({ block: "start" });
  target?.focus({ preventScroll: true });
  return target !== null;
}

function ClaimLinks({ ids, report }: { ids: string[]; report: PublicReportVersion }) {
  return <ul className="public-research-claim-links">{ids.map(id => {
    const claim = report.claims.find(item => item.id === id);
    return claim ? <li key={id}><a href={`#claim-${id}`} onClick={() => revealResearchTarget(`claim-${id}`)}>{claim.title}</a></li> : null;
  })}</ul>;
}

function ReportClaim({ claim, report }: { claim: ResearchClaim; report: PublicReportVersion }) {
  const observations = report.observations.filter(observation => claim.observationIds.includes(observation.id));
  return <section className="public-research-claim" id={`claim-${claim.id}`} tabIndex={-1} aria-labelledby={`claim-title-${claim.id}`}>
    <p className="public-research-meta"><span>{claimKindWords[claim.kind]}</span>{report.claimStates[claim.id] !== "valid" && <span className="public-research-claim-state">{freshnessWords[report.claimStates[claim.id] ?? "unavailable"]}</span>}</p>
    <h3 id={`claim-title-${claim.id}`}>{claim.title}</h3>
    <p>{claim.statement}</p>
    <div className="public-research-transmission"><h4>{m.transmission}</h4><ul>{claim.impactChannels.map((channel, i) => <li key={i}>{channel}</li>)}</ul></div>
    <div className="public-research-counter"><h4>{m.counterEvidence}</h4><ul>{claim.counterEvidence.map((text, i) => <li key={i}>{text}</li>)}</ul></div>
    <p className="public-research-verification"><strong>{m.verification}</strong>{claim.verification}</p>
    {(observations.length > 0 || claim.assumptions.length > 0 || claim.premiseClaimIds.length > 0) && <details className="public-research-basis">
      <summary>{m.basis}</summary>
      {observations.length > 0 && <ul className="public-research-observations">{observations.map(observation => <li key={observation.id}>
        <p className="public-research-meta"><span>{observationBasisWords[observation.basis]}</span><span>{observationStatusWords[observation.status]}</span></p>
        <p>{observation.label} · <strong>{observation.value ?? observationStatusWords[observation.status]}</strong> {observation.unit}</p>
        <p className="public-research-observation-period"><time dateTime={observation.period.start}>{observation.period.start}</time> – <time dateTime={observation.period.end}>{observation.period.end}</time>{observation.currency && ` · ${observation.currency}`}</p>
        <p>{observation.definition}</p>{observation.missingReason && <p>{observation.missingReason}</p>}
      </li>)}</ul>}
      {claim.assumptions.length > 0 && <><h4>{m.assumptions}</h4><ul>{claim.assumptions.map((text, i) => <li key={i}>{text}</li>)}</ul></>}
      {claim.premiseClaimIds.length > 0 && <><h4>{m.premises}</h4><ClaimLinks ids={claim.premiseClaimIds} report={report} /></>}
    </details>}
    <p className="public-research-citations"><span>{m.sources}</span>{claim.sourceIds.map(sourceId => {
      const index = report.sources.findIndex(item => item.id === sourceId), source = report.sources[index];
      return source ? <a key={sourceId} href={`#source-${sourceId}`} aria-label={`${m.sources} ${index + 1} · ${source.title}`} title={source.title} onClick={() => revealResearchTarget(`source-${sourceId}`)}>[{index + 1}]</a> : null;
    })}</p>
  </section>;
}

function ReportBody({ report }: { report: PublicReportVersion }) {
  const historical = new URLSearchParams(location.search).has("version");
  const shownClaims = new Set<string>();
  return <article className="public-research-document" lang={report.language}>
    <header>
      <p className="public-research-meta"><span>{m[report.type]}</span><span>{freshnessWords[report.freshnessStatus]}</span><span>{m.asOf} <time dateTime={report.asOf}>{report.asOf.slice(0, 10)}</time></span></p>
      <h1>{report.title}</h1>
      {(report.coverage === "limited" || report.missingInputs.length > 0) && <p className="public-research-coverage"><a href="#research-limitations" onClick={() => revealResearchTarget("research-limitations")}>{report.coverage === "limited" && `${m.limited} · `}{m.gaps(report.missingInputs.length)} <span aria-hidden="true">↓</span></a></p>}
      {historical && <p className="public-research-notice">{m.historical} <a href={researchHref(report.reportId)} data-nav>{m.latest}</a></p>}
      {report.freshnessStatus === "updating" && <p className="public-research-notice" role="status">{m.pending}</p>}
      {["stale", "review_required", "unavailable"].includes(report.freshnessStatus) && <p className="public-research-notice" role="status">{m.stale}</p>}
      <div className="public-research-disclosures"><details className="public-research-summary"><summary>{m.summary}</summary><p className="public-research-lead">{report.summary}</p></details>
      <details id="research-context" className="public-research-context" tabIndex={-1}><summary>{m.context}</summary>
        <dl className="public-research-facts">
          <div><dt>{m.scope}</dt><dd>{report.scope.description} · {report.scope.regions.join(" · ")} · {report.scope.currency}</dd></div>
          <div><dt>{m.published}</dt><dd><time dateTime={report.publishedAt}>{report.publishedAt.slice(0, 10)}</time></dd></div>
          <div><dt>{m.version}</dt><dd><code>{report.version}</code></dd></div>
          <div><dt>{m.original}</dt><dd>{report.language === "en" ? "English" : "中文"}</dd></div>
        </dl>
        <p className="public-research-detail-label"><strong>{m.changes}</strong></p><ul>{report.changes.map((change, i) => <li key={i}>{change}</li>)}</ul>
      </details></div>
    </header>
    <div id="research-analysis" tabIndex={-1}>{report.sections.map(section => <section key={section.id} id={`section-${section.id}`} aria-labelledby={`section-title-${section.id}`}>
      <h2 id={`section-title-${section.id}`}>{section.title}</h2>{section.claimIds.map(id => {
        const claim = report.claims.find(item => item.id === id);
        if (!claim) return null;
        if (shownClaims.has(id)) return <p key={id}><a href={`#claim-${id}`} onClick={() => revealResearchTarget(`claim-${id}`)}>{claim.title}</a></p>;
        shownClaims.add(id);
        return <ReportClaim key={id} claim={claim} report={report} />;
      })}
    </section>)}</div>
    <section id="research-scenarios" tabIndex={-1} aria-labelledby="research-scenarios-title"><h2 id="research-scenarios-title">{m.scenarios}</h2>
      <ol className="public-research-scenarios">{report.scenarios.map(scenario => <li key={scenario.name}>
        <h3>{scenarioWords[scenario.name]}</h3><ul>{scenario.assumptions.map((text, i) => <li key={i}>{text}</li>)}</ul><ClaimLinks ids={scenario.claimIds} report={report} />
      </li>)}</ol>
    </section>
    {(report.coverage === "limited" || report.missingInputs.length > 0) && <section id="research-limitations" tabIndex={-1} aria-labelledby="research-limitations-title"><h2 id="research-limitations-title">{m.limitations}</h2><ul>{report.missingInputs.map((gap, i) => <li key={i}>{gap}</li>)}</ul></section>}
    <section className="public-research-sources sources" aria-labelledby="research-sources"><h2 id="research-sources" tabIndex={-1}>{m.sources}</h2>
      {report.sources.map((source, index) => <details key={source.id} id={`source-${source.id}`} tabIndex={-1}>
        <summary><span className="public-research-source-number">[{index + 1}]</span> {source.title}</summary>
        <blockquote>{source.excerpt}</blockquote>
        <p>{m.published} <time dateTime={source.publishedAt}>{source.publishedAt.slice(0, 10)}</time></p>
        {safeReportUrl(source.uri) && <a href={source.uri} target="_blank" rel="noopener noreferrer">{source.title} <span aria-hidden="true">↗</span></a>}
        <p className="public-research-source-locator"><strong>{m.locator}</strong>{source.locator}</p>
        <p className="public-research-detail-label"><strong>{m.citedBy}</strong></p><ClaimLinks ids={report.claims.filter(claim => claim.sourceIds.includes(source.id)).map(claim => claim.id)} report={report} />
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
    revealResearchTarget(location.hash.slice(1));
  }, [read]);
  if (failed !== null) return <div className="public-research-status" role="status"><h1>{failed === 401 || failed === 403 ? m.denied : failed === 404 ? m.missing : m.error}</h1><button type="button" onClick={() => { setFailed(null); setAttempt(n => n + 1); }}>{m.retry}</button></div>;
  if (!read) return <p className="public-research-status" role="status">{m.loading}</p>;
  return <>
    {read.status === "available" && read.report ? <ReportBody report={read.report} /> : <div className="public-research-status" role="status"><h1>{read.status === "withdrawn" ? m.withdrawn : m.missing}</h1></div>}
    {read.history.length > 0 && <details className="public-research-history" id="research-history" tabIndex={-1}><summary>{m.history}</summary><ol>{read.history.map(item => <li key={item.version}><a href={researchHref(item.reportId, item.version)} data-nav aria-current={read.report?.version === item.version ? "page" : undefined}>{item.publishedAt.slice(0, 10)} · {item.title}<small>{m.version} {item.version}</small></a></li>)}</ol></details>}
  </>;
}

export default function PublicResearchPage({ href, light, onToggleTheme }: { href: string; light: boolean; onToggleTheme: () => void }) {
  useLocale();
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!revealResearchTarget(location.hash.slice(1))) stage.current?.scrollTo(0, 0);
  }, [href]);
  useEffect(() => {
    const followHash = () => { revealResearchTarget(location.hash.slice(1)); };
    window.addEventListener("hashchange", followHash);
    return () => window.removeEventListener("hashchange", followHash);
  }, []);
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
      {id && <nav className="public-research-contents" aria-label={m.contents}><a href="#research-analysis">{m.analysis}</a><a href="#research-scenarios">{m.scenarios}</a><a href="#research-sources">{m.sources}</a><a href="#research-history">{m.history}</a></nav>}
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
