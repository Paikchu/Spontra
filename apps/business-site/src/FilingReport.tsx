import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/packages/web/src/ui/button";
import { getLocale, messages } from "@/packages/web/src/i18n";
import { SourceLanguage } from "@/packages/web/src/i18n/SourceLanguage";
import type { PublicFilingDetail } from "@/shared/analysis-contract/filings";
import { filingPresentation } from "@/packages/web/src/report-client";
import { SecReportDocument } from "@/packages/web/src/sec-report/SecReportDocument";
import type { PublishedArtifact } from "@/shared/analysis-contract/artifact";
import { ArtifactFrame } from "./ArtifactFrame";
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
export default function FilingReport({ accession, snapshot, head, ticker, onClose, fallback }: {
  accession: string;
  snapshot?: { reportDate: string; reportVersion: string } | null;
  head: FilingReportHead;
  ticker: string;
  onClose: () => void;
  fallback?: ReactNode;
}) {
  const [detail, setDetail] = useState<PublicFilingDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const preview = usePreview("filing-report", accession);
  const reportDate = snapshot?.reportDate, reportVersion = snapshot?.reportVersion;
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ ...reportDate && reportVersion ? { reportDate, reportVersion } : {}, ...getLocale() === "en" ? {} : { lang: getLocale() } }).toString();
    fetch(`/api/business/v1/companies/${encodeURIComponent(ticker)}/filings/${encodeURIComponent(accession)}${params ? `?${params}` : ""}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() as Promise<PublicFilingDetail> : Promise.reject(new Error(String(r.status))))
      .then(body => { if (!controller.signal.aborted) setDetail(body); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [ticker, accession, reportDate, reportVersion]);
  const artifact = preview ?? detail?.artifact ?? null;
  if (fallback && !artifact && (failed || detail && !detail.filing.summary?.report)) return <>{fallback}</>;
  return <section className="lens report-lens" aria-label={m.report(head.title)}>
    <header className="lens-head">
      <div className="lens-title">
        <b className="lens-kind report-kind">{head.kind}</b>
        <h2 lang={head.titleLang}>{head.title}</h2>
        <span className="lens-basis">{m.filed(head.form, head.filed)}<SourceLanguage of={head.sourceTexts} /></span>
      </div>
      <div className="lens-nav"><Button variant="unstyled" type="button" className="lens-close" aria-label={m.close} onClick={onClose}>✕</Button></div>
    </header>
    <div className="report-document earning-report">
      {artifact ? <ArtifactFrame artifact={artifact} />
        : detail ? <SecReportDocument {...filingPresentation(detail, ticker)} embedded />
        : failed ? <p className="lens-empty">{m.loadFailed}</p>
        : <p className="lens-empty">{m.loading}</p>}
    </div>
  </section>;
}
