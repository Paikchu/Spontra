import { useEffect, useRef, useState } from "react";
import { Button } from "@/packages/web/src/ui/button";
import { messages } from "@/packages/web/src/i18n";
import type { PublicFilingDetail } from "@/shared/analysis-contract/filings";
import { filingPresentation } from "@/packages/web/src/report-client";
import { SecReportDocument } from "@/packages/web/src/sec-report/SecReportDocument";
import "katex/dist/katex.min.css";
import "@/packages/web/src/styles/earning-report.css";
import "@/packages/web/src/report/report-blocks/report-content.css";
import "@/packages/web/src/report/figures/figures.css";

const m = messages({
  label: "Full report", combined: (date: string) => `Combined report · Period ended ${date}`, close: "Close report", loadFailed: "Load failed", loading: "Loading",
}, {
  label: "完整财报", combined: (date: string) => `合并财报 · 截至 ${date}`, close: "关闭财报", loadFailed: "加载失败", loading: "加载中",
});

/**
 * The full published report, read in place: the same document the report page renders, inside a
 * modal over the map. Loaded on demand so the map's bundle does not carry the reader until it is
 * opened.
 */
export default function ReportDialog({ ticker, accession, snapshot, onClose }: {
  ticker: string;
  accession: string;
  snapshot: { reportDate: string; reportVersion: string } | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<PublicFilingDetail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const query = snapshot ? "?" + new URLSearchParams(snapshot) : "";
    fetch(`/api/business/v1/companies/${encodeURIComponent(ticker)}/filings/${encodeURIComponent(accession)}${query}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() as Promise<PublicFilingDetail> : Promise.reject(new Error(String(r.status))))
      .then(body => { if (!controller.signal.aborted) setDetail(body); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [ticker, accession, snapshot?.reportDate, snapshot?.reportVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  return <dialog ref={ref} className="report-dialog" aria-label={m.label} onClose={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="report-dialog-bar">
      <span>{ticker} · {detail?.filing.earningsGroup ? m.combined(detail.filing.earningsGroup.periodEnd) : `${detail?.filing.form ?? ""} ${accession}`}</span>
      <Button variant="unstyled" type="button" className="lens-close" aria-label={m.close} onClick={onClose}>✕</Button>
    </div>
    <div className="report-dialog-body earning-report">
      {detail ? <SecReportDocument {...filingPresentation(detail, ticker)} embedded />
        : failed ? <p className="lens-empty">{m.loadFailed}</p>
        : <p className="lens-empty">{m.loading}</p>}
    </div>
  </dialog>;
}
