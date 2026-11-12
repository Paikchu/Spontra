import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/packages/web/src/ui/button";
import { messages, useLocale } from "@/packages/web/src/i18n";
import { SourceLanguage } from "@/packages/web/src/i18n/SourceLanguage";
import type { PublicFilingDetail } from "@/shared/analysis-contract/filings";
import { filingPresentation } from "@/packages/web/src/report-client";
import { SecReportDocument } from "@/packages/web/src/sec-report/SecReportDocument";
import { ArtifactFrame } from "./ArtifactFrame";
import { ArtifactLanguage } from "./ArtifactLanguage";
import { usePreview } from "./artifact-reads";
import "katex/dist/katex.min.css";
import "@/packages/web/src/styles/earning-report.css";
import "@/packages/web/src/report/report-blocks/report-content.css";
import "@/packages/web/src/report/figures/figures.css";

const m = messages({
  report: (title: string) => `Report: ${title}`, filed: (form: string, date: string) => `${form} · Filed ${date}`,
  close: "Close report", loadFailed: "Load failed", loading: "Loading",
}, {
  report: (title: string) => `财报：${title}`, filed: (form: string, date: string) => `${form} · 提交于 ${date}`,
  close: "关闭财报", loadFailed: "加载失败", loading: "加载中",
});

/** What a filing's row already knows, for the head of its report. */
export type FilingReportHead = { kind: string; title: string; titleLang?: string; form: string; filed: string; sourceTexts: Array<string | null | undefined> };

/**
 * A filing's one report, holding the stage: a periodic report and a current report read the same. `fallback` is what
 * the row keeps when the filing turns out to have no report. Loaded on demand so the map's bundle does not carry the
 * report's styles and renderer until one is opened.
 */
export default function FilingReport({ accession, snapshot, revision, head, ticker, onClose, fallback }: {
  accession: string;
  /** Changes when the report is published again, so an open report is read again. */
  revision?: string | null;
  snapshot?: { reportDate: string; reportVersion: string } | null;
  head: FilingReportHead;
  ticker: string;
  onClose: () => void;
  fallback?: ReactNode;
}) {
  const [detail, setDetail] = useState<PublicFilingDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const locale = useLocale();
  const preview = usePreview("filing-report", accession);
  const reportDate = snapshot?.reportDate, reportVersion = snapshot?.reportVersion;
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    // The response is cached by its URL for hours; the report's revision is part of the URL so a republished report is a new one.
    const params = new URLSearchParams({ schema: "artifact-i18n-v1", ...reportDate && reportVersion ? { reportDate, reportVersion } : {}, ...locale === "en" ? {} : { lang: locale }, ...revision ? { rev: revision } : {} }).toString();
    fetch(`/api/business/v1/companies/${encodeURIComponent(ticker)}/filings/${encodeURIComponent(accession)}${params ? `?${params}` : ""}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() as Promise<PublicFilingDetail> : Promise.reject(new Error(String(r.status))))
      .then(body => { if (!controller.signal.aborted) setDetail(body); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [ticker, accession, reportDate, reportVersion, revision, locale]);
  const artifact = preview ?? detail?.artifact ?? null;
  const title = artifact?.title ?? head.title;
  if (fallback && !artifact && (failed || detail && !detail.filing.summary?.report)) return <>{fallback}</>;
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
      {artifact ? <ArtifactFrame artifact={artifact} showLanguage={false} hostTitle={title} />
        : detail ? <SecReportDocument {...filingPresentation(detail, ticker)} embedded />
        : failed ? <p className="lens-empty">{m.loadFailed}</p>
        : <p className="lens-empty">{m.loading}</p>}
    </div>
  </section>;
}
