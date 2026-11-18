import type { ValuationResponse } from "@/shared/analysis-contract/valuation";
import { FilingImpactSummary, CompanyValuationReference } from "./FilingImpactSummary";
import "./filing-conclusions.css";
import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@/packages/web/src/ui/button";
import { messages, useLocale } from "@/packages/web/src/i18n";
import { SourceLanguage } from "@/packages/web/src/i18n/SourceLanguage";
import type { PublicFilingDetail } from "@/shared/analysis-contract/filings";
import type { PublishedArtifact } from "@/shared/analysis-contract/artifact";
import { filingPresentation } from "@/packages/web/src/report-client";
import { SecReportDocument } from "@/packages/web/src/sec-report/SecReportDocument";
import type { VerifiedFinding } from "./findings-model";
import { ArtifactFrame } from "./ArtifactFrame";
import { ArtifactLanguage } from "./ArtifactLanguage";
import { useFilingEditions, usePreviewRead } from "./artifact-reads";
import { COMPANY_READ_SCHEMA } from "./company-opening";
import "katex/dist/katex.min.css";
import "@/packages/web/src/styles/earning-report.css";
import "@/packages/web/src/report/report-blocks/report-content.css";
import "@/packages/web/src/report/figures/figures.css";

const m = messages({
  report: (title: string) => `Report: ${title}`, filed: (form: string, date: string) => `${form} · Filed ${date}`,
  close: "Close report", loadFailed: "Load failed", loading: "Loading", conclusions: "Research conclusions",
  citing: "Research citing this filing", researchPeriod: (date: string) => `Research period ended ${date}`,
}, {
  report: (title: string) => `财报：${title}`, filed: (form: string, date: string) => `${form} · 提交于 ${date}`,
  close: "关闭财报", loadFailed: "加载失败", loading: "加载中", conclusions: "研究结论",
  citing: "引用此文件的研究", researchPeriod: (date: string) => `研究期间截至 ${date}`,
});

/** What a filing's row already knows, for the head of its report. */
export type FilingReportHead = { kind: string; title: string; titleLang?: string; form: string; filed: string; sourceTexts: Array<string | null | undefined> };

/**
 * A filing's one report, holding the stage: a periodic report and a current report read the same. `fallback` is what
 * the row keeps when the filing turns out to have no report. Loaded on demand so the map's bundle does not carry the
 * report's styles and renderer until one is opened.
 */
export default function FilingReport({ accession, snapshot, revision, head, ticker, onClose, fallback, relatedFindings = [], sourceRelated = false, onFinding, valuation }: {
  accession: string;
  relatedFindings?: VerifiedFinding[];
  sourceRelated?: boolean;
  valuation?: ValuationResponse | null;
  onFinding?: (id: string) => void;
  /** Changes when the report is published again, so an open report is read again. */
  revision?: string | null;
  snapshot?: { reportDate: string; reportVersion: string } | null;
  head: FilingReportHead;
  ticker: string;
  onClose: () => void;
  fallback?: ReactNode;
}) {
  const locale = useLocale();
  const preview = usePreviewRead("filing-report", accession, ticker);
  const hasPreview = preview.token !== null;
  const reportDate = snapshot?.reportDate, reportVersion = snapshot?.reportVersion;
  const editionParams = new URLSearchParams(location.search);
  const artifactVersion = editionParams.get("artifactVersion"), artifactHash = editionParams.get("artifactHash");
  const params = new URLSearchParams({ schema: COMPANY_READ_SCHEMA, ...reportDate && reportVersion ? { reportDate, reportVersion } : {}, ...artifactVersion || artifactHash ? { artifactVersion: artifactVersion ?? "", artifactHash: artifactHash ?? "" } : {}, ...revision ? { rev: revision } : {} });
  const endpoint = hasPreview ? null : `/api/business/v1/companies/${encodeURIComponent(ticker)}/filings/${encodeURIComponent(accession)}?${params}`;
  const editions = useFilingEditions<PublicFilingDetail>(endpoint);
  const readKey = preview.token ?? endpoint;
  const [rendered, setRendered] = useState(() => ({ key: readKey, hashes: new Set<string>() }));
  if (rendered.key !== readKey) setRendered({ key: readKey, hashes: new Set() });
  const markRendered = useCallback((hash: string) => setRendered(current => ({ key: current.key, hashes: new Set(current.hashes).add(hash) })), []);
  const detail = editions[locale];
  const failed = detail === null;
  const sameEdition = (candidate: PublishedArtifact | null | undefined) => candidate?.ticker === ticker && candidate.subject === accession && (!artifactVersion || candidate.version === Number(artifactVersion)) && (!artifactHash || (candidate.sourceHash ?? candidate.hash) === artifactHash) ? candidate : null;
  const artifact = sameEdition(hasPreview ? preview.artifact : detail?.artifact);
  const other = sameEdition(editions[locale === "zh-CN" ? "en" : "zh-CN"]?.artifact);
  const frames = [artifact, other].filter((edition): edition is PublishedArtifact => !!edition && (edition === artifact || edition.hash !== artifact?.hash))
    .sort((a, b) => a.hash.localeCompare(b.hash));
  const visibleArtifact = artifact && rendered.hashes.has(artifact.hash) ? artifact : null;
  const title = artifact?.title ?? head.title;
  const historical = !!reportVersion || !!artifactVersion || new URLSearchParams(location.search).has("reportVersion");
  if (fallback && !hasPreview && !artifactVersion && !artifactHash && !artifact && (failed || detail && !detail.filing.summary?.report)) return <>{fallback}</>;
  return <section className="lens report-lens" aria-label={m.report(title)}>
    <header className="lens-head">
      <div className="lens-title">
        <b className="lens-kind report-kind">{head.kind}</b>
        <h2 lang={artifact?.lang ?? head.titleLang}>{title}</h2>
        <span className="lens-basis">{m.filed(head.form, head.filed)}{artifact ? <ArtifactLanguage artifact={artifact} /> : <SourceLanguage of={head.sourceTexts} />}</span>
      </div>
      <div className="lens-nav"><Button variant="unstyled" type="button" className="lens-close" aria-label={m.close} onClick={onClose}>✕</Button></div>
    </header>
    <div className="report-document earning-report">
      {!historical && relatedFindings.length > 0 && <section className="filing-conclusions" aria-label={sourceRelated ? m.citing : m.conclusions}>
        <h3>{sourceRelated ? m.citing : m.conclusions}</h3>
        <ul>{relatedFindings.map(f => <li key={f.id}><Button variant="unstyled" type="button" onClick={() => onFinding?.(f.id)}>{f.title}</Button>{sourceRelated && <> · <small>{m.researchPeriod(f.periodEnd)}</small></>}</li>)}</ul>
      </section>}
      {visibleArtifact && <FilingImpactSummary artifact={visibleArtifact} compact />}
      <CompanyValuationReference valuation={valuation} />
      {artifact && !visibleArtifact && <p className="lens-empty" role="status">{m.loading}</p>}
      {!artifact && (hasPreview ? <p className="lens-empty" role={preview.status === "failed" || preview.status === "ready" ? "alert" : "status"}>{preview.status === "loading" ? m.loading : m.loadFailed}</p>
        : detail ? <SecReportDocument {...filingPresentation(detail, ticker)} embedded />
        : failed ? <p className="lens-empty">{m.loadFailed}</p>
        : <p className="lens-empty" role="status">{m.loading}</p>)}
      {frames.length > 0 && <div className="filing-editions">{frames.map(edition => <div key={edition.hash} className="filing-edition" aria-hidden={edition !== visibleArtifact || undefined} inert={edition !== visibleArtifact || undefined}>
        <ArtifactFrame artifact={edition} showLanguage={false} hostTitle={edition.title} standby={edition !== visibleArtifact} onRendered={markRendered} />
      </div>)}</div>}
    </div>
  </section>;
}
