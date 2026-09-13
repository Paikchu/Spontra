"use client";

import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyDescription } from "@/components/ui/empty";
import { useCallback, useEffect, useRef, useState } from "react";

import type { SecEventCategory } from "@/shared/analysis-contract/report.ts";
import { formatSecMetricLabel, formatSecMetricValue } from "@/lib/earning-report/web/sec-metric-format.ts";
import { formatFilingPeriodLabel } from "@/lib/earning-report/web/filing-period-label.ts";
import type { PublicSecFiling } from "@/shared/analysis-contract/filings.ts";



/** Distance from the end of the rail that starts the next page. */
const TIMELINE_PREFETCH_PX = 180;
const TIMELINE_PAGE_SIZE = 5;
/** Guard so a cursor that keeps returning nothing cannot page in a loop. */
const TIMELINE_EMPTY_PAGE_LIMIT = 6;

type Page = { filings: PublicSecFiling[]; nextCursor: string | null; checkedAt: string | null; total?: number | null };

export function SecFilingsSection({ ticker, title = "财报与独立事件" }: { ticker: string; title?: string }) {
  const [filings, setFilings] = useState<PublicSecFiling[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [openAccessions, setOpenAccessions] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const filingsRef = useRef<PublicSecFiling[]>([]);
  const railEndRef = useRef<HTMLParagraphElement | null>(null);
  const emptyPages = useRef(0);
  const requestPending = useRef(false);

  const load = useCallback(async (cursor: string | null, append: boolean) => {
    if (requestPending.current) return;
    requestPending.current = true;
    if (append) setLoadingMore(true);
    else setStatus("loading");
    try {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=${TIMELINE_PAGE_SIZE}` : `?limit=${TIMELINE_PAGE_SIZE}`;
      const response = await fetch(`/api/analysis/v1/companies/${encodeURIComponent(ticker)}/filings${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("SEC 数据读取失败。");
      const page = await response.json() as Page;
      const merged = append ? [...filingsRef.current, ...page.filings] : page.filings;
      filingsRef.current = merged;
      setFilings(merged);
      setNextCursor(page.nextCursor);
      // Only the first page carries a count, so an appended page keeps the total it already knows.
      setTotal((current) => Math.max(append ? current : 0, page.total ?? 0, merged.length));
      emptyPages.current = page.filings.length > 0 ? 0 : emptyPages.current + 1;
      if (!append) setOpenAccessions(new Set(defaultOpenAccessions(merged)));
      setStatus("ready");
    } catch {
      setStatus("error");
    } finally {
      requestPending.current = false;
      setLoadingMore(false);
    }
  }, [ticker]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(null, false); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const restoreDefaultSummary = () => {
      if (filingsRef.current.length === 0) return;
      setOpenAccessions(new Set(defaultOpenAccessions(filingsRef.current)));
    };
    window.addEventListener("pageshow", restoreDefaultSummary);
    return () => window.removeEventListener("pageshow", restoreDefaultSummary);
  }, []);

  // The rail is its own scroller beside the chart column but scrolls with the page once the layout
  // stacks, and a tall viewport can leave it shorter than its column. Watching the end of the rail
  // reach the viewport covers all three: no scroll offset of any single element is involved.
  useEffect(() => {
    const railEnd = railEndRef.current;
    if (!railEnd || !nextCursor || loadingMore || status !== "ready") return;
    if (emptyPages.current >= TIMELINE_EMPTY_PAGE_LIMIT) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((entry) => entry.isIntersecting)) void load(nextCursor, true); },
      { rootMargin: `${TIMELINE_PREFETCH_PX}px` },
    );
    observer.observe(railEnd);
    return () => observer.disconnect();
  }, [filings, load, loadingMore, nextCursor, status]);

  return (
    <section className="sec-filings-section" id="sec-filings" aria-labelledby="sec-filings-title">
      <div className="detail-section-heading">
        <h2 id="sec-filings-title">{title}</h2>
      </div>
      {status === "loading" && <div role="status" className="flex flex-col gap-3 py-5"><span className="sr-only">正在读取财报与事件…</span><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40 w-full" /></div>}
      {status === "error" && <Alert variant="destructive"><AlertDescription>SEC 数据读取失败。<Button variant="outline" size="sm" onClick={() => void load(null, false)}>重新读取</Button></AlertDescription></Alert>}
      {status === "ready" && filings.length === 0 && <Empty><EmptyHeader><EmptyDescription>暂未收录该股票的 SEC 报告。</EmptyDescription></EmptyHeader></Empty>}
      {status === "ready" && filings.length > 0 && (
        <div className="sec-filing-scroll">
          <Accordion type="multiple" value={[...openAccessions]} onValueChange={(values) => setOpenAccessions(new Set(values))} className="analysis-filing-list">
            {filings.map((filing, index) => (
              <SecFilingCard
                filing={filing}
                isLatestPeriodic={isPeriodicFiling(filing.form) && !filings.slice(0, index).some((candidate) => isPeriodicFiling(candidate.form))}
                key={filing.earningsGroup?.id ?? filing.accessionNumber}
              />
            ))}
          </Accordion>
          <p className="sec-filing-rail-status" ref={railEndRef} role="status">
            {loadingMore
              ? "正在载入更早报告…"
              : total > filings.length
                ? `已显示 ${filings.length} / ${total} 份`
                : `已显示全部 ${filings.length} 份报告与事件`}
          </p>
        </div>
      )}
    </section>
  );
}

function SecFilingCard({ filing, isLatestPeriodic }: { filing: PublicSecFiling; isLatestPeriodic: boolean }) {
  const headline = filing.summary?.headline || filing.analysis?.headline || "";
  // The report page renders whatever narrative is stored, so the entry point
  // asks the same question it does. Requiring the current summary version made
  // the link disappear for the whole regeneration window after a version bump,
  // while the report it points at was still on file and still readable.
  const group = filing.earningsGroup;
  const published = filing.analysis?.publication;
  const fullReportHref = filing.summary?.report
    ? `/analysis/stocks/${encodeURIComponent(filing.ticker)}/sec/${encodeURIComponent(published?.filing.accessionNumber ?? group?.canonicalAccession ?? filing.accessionNumber)}`
      + (published ? `?${new URLSearchParams({ reportDate: published.filing.reportDate || published.filing.filingDate, reportVersion: filing.analysis!.reportVersion })}` : "")
    : null;
  return (
    <AccordionItem value={group?.id ?? filing.accessionNumber} className="analysis-filing-item">
      <AccordionTrigger>
        <span className="analysis-filing-heading">
          <span className="analysis-filing-meta">
            <Badge variant={isLatestPeriodic ? "default" : "secondary"}>{formatFilingPeriodLabel(filing)}</Badge>
            <span>{formatYear(group?.earningsDate ?? filing.filingDate)}年{formatMonthDay(group?.earningsDate ?? filing.filingDate)}</span>
            <span>{group ? `业绩发布 · 截至 ${group.periodEnd}` : formDescription(filing.form)}</span>
          </span>
          <span className="analysis-filing-headline">{headline || "AI 解读生成中"}</span>
        </span>
      </AccordionTrigger>
      <AccordionContent>
        {group && <div className="mb-3 text-sm text-muted-foreground">
          <ul aria-label="本期来源文件" className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {group.sources.map((source) => <li key={source.accessionNumber}><a href={source.indexUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">{source.form} · {source.filingDate} ↗</a></li>)}
          </ul>
        </div>}
        <FilingSummary filing={filing} />
        <div className="flex flex-wrap items-center gap-2 pt-4">
          {fullReportHref && <Button asChild size="sm"><a data-app-local-anchor href={fullReportHref}>阅读完整报告 →</a></Button>}
          <Button asChild variant="outline" size="sm"><a href={filing.edgarUrl} rel="noopener noreferrer" target="_blank">SEC EDGAR 原文 ↗</a></Button>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

function FilingSummary({ filing }: { filing: PublicSecFiling }) {
  if (filing.analysis) return <StructuredAnalysis filing={filing} />;
  const summary = filing.summary;
  if (!summary) return <p className="sec-summary-pending">AI 解读正在后台生成。</p>;
  if (!summary.headline && !summary.bullets.length && !summary.analystView) return <p className="sec-summary-error">AI 解读暂时不可用。</p>;
  const categoryLabel = summary.eventCategory ? EVENT_CATEGORY_LABELS[summary.eventCategory] : null;
  return (
    <div className="sec-summary">
      {categoryLabel && <Badge variant="secondary">{categoryLabel}</Badge>}
      {summary.bullets.length > 0 && (
        <ul>
          {summary.bullets.map((bullet, index) => (
            <li data-importance={bullet.importance} key={`${bullet.label}-${index}`}><i aria-hidden="true" /><span><strong>{bullet.label}</strong>{bullet.detail}</span></li>
          ))}
        </ul>
      )}
      {summary.report && <details className="sec-event-report"><summary className="cursor-pointer text-sm text-muted-foreground">补充分析</summary><p className="whitespace-pre-line">{summary.report}</p></details>}
      {summary.analystView && <p className="sec-analyst-view"><span>投资含义</span>{summary.analystView}</p>}
      {summary.discovery?.warnings.map((warning) => <p className="sec-analysis-warning" key={warning}>{warning}</p>)}
      <small className="sec-ai-note">AI 基于 filing 原文生成 · {formatDateTime(summary.generatedAt)}</small>
    </div>
  );
}

const EVENT_CATEGORY_LABELS: Record<SecEventCategory, string> = {
  "earnings_update": "业绩更新",
  "guidance": "业绩指引",
  "m&a": "并购重组",
  "executive": "管理层变动",
  "legal": "法律事项",
  "other": "其他事项",
};

function StructuredAnalysis({ filing }: { filing: PublicSecFiling }) {
  const report = filing.analysis!;
  const changes = [...report.changes.qoq.map((change) => ({ ...change, label: "环比" })), ...report.changes.yoy.map((change) => ({ ...change, label: "同比" }))].filter((change) => change.changeType !== "not_mentioned").slice(0, 8);
  return (
    <div className="sec-summary sec-analysis">
      {report.discovery && filing.summary?.bullets.length ? <ul aria-label="本期关键发现">{filing.summary.bullets.map((bullet,index) =>
        <li data-importance={bullet.importance} key={`${bullet.label}-${index}`}><i aria-hidden="true"/><span><strong>{bullet.label}</strong>{bullet.detail}</span></li>)}</ul> : null}
      {report.discovery && filing.summary?.analystView && <p className="sec-analyst-view"><span>投资含义与验证</span>{filing.summary.analystView}</p>}
      {report.keyMetrics.length > 0 && (
        <dl className="sec-analysis-metrics" aria-label="关键财务数据">
          {report.keyMetrics.slice(0, 6).map((metric) => (
            <div className="sec-analysis-metric" key={metric.metricKey}>
              <dt>{formatSecMetricLabel(metric.metricKey)}</dt>
              <dd>
                <strong>{formatSecMetricValue(metric.metricKey, metric.currentValue)}</strong>
                {metric.yoy && <small>同比 {metric.yoy}</small>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {!report.discovery && changes.length > 0 && <ul className="sec-analysis-changes">{changes.map((change, index) => <li key={`${change.label}-${change.topicKey}-${index}`}><i aria-hidden="true" /><span><strong>{change.label} · {change.topicKey}</strong>{change.currentStatement ?? change.priorStatement ?? ""}</span></li>)}</ul>}

    </div>
  );
}

function isPeriodicFiling(form: string): boolean { return /^(10-K|10-Q|20-F)(\/A)?$/.test(form); }
function formDescription(form: string): string { return form.startsWith("10-K") || form.startsWith("20-F") ? "年度报告" : form.startsWith("10-Q") ? "季度报告" : "重大事项报告"; }
/** Only the two most recent filings start expanded; the rest of the rail stays collapsed. */
const TIMELINE_DEFAULT_OPEN = 2;
function defaultOpenAccessions(filings: PublicSecFiling[]): string[] {
  return filings.slice(0, TIMELINE_DEFAULT_OPEN).map((filing) => filing.earningsGroup?.id ?? filing.accessionNumber);
}
function formatMonthDay(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${Number(match[2])}月${Number(match[3])}日` : value;
}
function formatYear(value: string): string {
  const match = /^(\d{4})/.exec(value);
  return match ? match[1]! : "";
}
function formatDateTime(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(date) : value; }
