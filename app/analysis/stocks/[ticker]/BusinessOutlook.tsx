"use client";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useEffect, useState } from "react";

import type { PublicCompanyAnalysisResponse } from "@/shared/analysis-contract/company-analysis.ts";
import type { PublicFundamentalsResponse } from "@/shared/analysis-contract/fundamentals.ts";
import { companyAnalysisNotice, shouldPollCompanyAnalysis } from "@/lib/earning-report/web/company-analysis-display-state.ts";
import { ReportBlockList } from "@/components/earning-report/report-blocks/ReportBlocks.tsx";
import { OutlookParagraph } from "@/app/analysis/stocks/[ticker]/OutlookParagraph.tsx";

type RequestStatus = "loading" | "ready" | "empty" | "error";

export function BusinessOutlook({ ticker }: { ticker: string }) {
  return <BusinessOutlookContent key={ticker} ticker={ticker} />;
}

function BusinessOutlookContent({ ticker }: { ticker: string }) {
  const [status, setStatus] = useState<RequestStatus>("loading");
  const [analysis, setAnalysis] = useState<PublicCompanyAnalysisResponse | null>(null);
  // Fetched beside the analysis rather than with it: a chart block names series, and the points are
  // resolved here from verified fundamentals. Its absence costs a chart, never the judgments.
  const [fundamentals, setFundamentals] = useState<PublicFundamentalsResponse | null>(null);

  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    async function loadOverview() {
      try {
        const value = await requestOverview(ticker, controller.signal);
        if (controller.signal.aborted) return;
        setAnalysis(value);
        setStatus(value.overview ? "ready" : "empty");
        // Read-only bounded polling, never generation from a page view.
        if (shouldPollCompanyAnalysis(value.latestRun) && polls++ < 20) {
          timer = setTimeout(() => void loadOverview(), 60_000);
        }
      } catch {
        if (controller.signal.aborted) return;
        // Retain an already displayed publication when a background read fails.
        setStatus((previous) => previous === "ready" ? previous : "error");
      }
    }
    void loadOverview();
    void requestFundamentals(ticker, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setFundamentals(value); })
      .catch(() => undefined);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [ticker, refresh]);

  if (status !== "ready" || !analysis?.overview) {
    return (
      <section className="stock-outlook stock-outlook--state" aria-labelledby="stock-outlook-heading">
        <span className="stock-outlook__eyebrow" id="stock-outlook-heading">公司业务拆解</span>
        {status === "loading" && <div role="status" className="flex flex-col gap-3 py-4"><span className="sr-only">正在读取业务拆解…</span><Skeleton className="h-16 w-full" /><Skeleton className="h-24 w-full" /></div>}
        {status === "empty" && (
          <div className="stock-outlook__state-row" role="status">
            <p className="stock-outlook__state">{companyAnalysisNotice(analysis?.latestRun)}</p>
            <Button variant="outline" size="sm" type="button" onClick={() => setRefresh((value) => value + 1)}>重新读取</Button>
          </div>
        )}
        {status === "error" && (
          <Alert variant="destructive"><AlertDescription>
            <p className="stock-outlook__state">公司业务拆解暂时不可用。</p>
            <Button variant="outline" size="sm" type="button" onClick={() => setRefresh((value) => value + 1)}>重新读取</Button>
          </AlertDescription></Alert>
        )}
      </section>
    );
  }

  const { overview } = analysis;
  if (overview.deepDive) {
    const report = overview.deepDive;
    const sourceNumber = new Map(report.sources.map((source, index) => [source.id, index + 1]));
    return (
      <article className="stock-outlook stock-outlook__deep" aria-labelledby="stock-outlook-heading" data-analysis-status={analysis.status}>
        <div className="stock-outlook__meta">
          <span className="stock-outlook__eyebrow" id="stock-outlook-heading">公司业务拆解</span>
          <span>{analysis.period?.label}</span>
        </div>
        <h2 className="stock-outlook__headline" data-length={headlineLength(report.headline)}>{report.headline}</h2>
        <p className="stock-outlook__deep-intro">{report.introduction}</p>
        {companyAnalysisNotice(analysis.latestRun, true) && <p className="stock-outlook__updating" role="status">{companyAnalysisNotice(analysis.latestRun, true)}</p>}
        <div className="stock-outlook__deep-sections">
          {report.sections.map((section, index) => (
            <section key={section.key} className="stock-outlook__deep-section" aria-labelledby={`business-${section.key}`}>
              <div className="stock-outlook__deep-heading"><span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><h3 id={`business-${section.key}`}>{section.title}</h3></div>
              {section.paragraphs.map((paragraph, paragraphIndex) => (
                <p key={`${section.key}-${paragraphIndex}`}>{paragraph.text}{paragraph.sourceIds.map((id) => {
                  const number = sourceNumber.get(id);
                  const source = report.sources.find((item) => item.id === id);
                  return number && source ? <a className="stock-outlook__citation" key={id} href={source.url} rel="noopener noreferrer" target="_blank" aria-label={`来源 ${number}：${source.title}`}>[{number}]</a> : null;
                })}</p>
              ))}
            </section>
          ))}
        </div>
        {report.limitations.length > 0 && <aside className="stock-outlook__limitations"><h3>尚待核实</h3><ul>{report.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></aside>}
        <footer className="stock-outlook__sources"><h3>资料来源</h3><ol>{report.sources.map((source) => <li key={source.id}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>{source.publishedAt && <time dateTime={source.publishedAt}> · {source.publishedAt.slice(0, 10)}</time>}</li>)}</ol></footer>
      </article>
    );
  }
  return (
    <section className="stock-outlook" aria-labelledby="stock-outlook-heading" data-analysis-status={analysis.status}>
      <div className="stock-outlook__meta">
        <span className="stock-outlook__eyebrow" id="stock-outlook-heading">业务前瞻 · 历史版本</span>
        <span>{analysis.period?.label}</span>
      </div>
      <h2 className="stock-outlook__headline" data-length={headlineLength(overview.headline)}>{overview.headline}</h2>
      <OutlookParagraph key={overview.introduction} className="stock-outlook__lede" text={overview.introduction} label="背景说明" />
      {companyAnalysisNotice(analysis.latestRun, true) && <p className="stock-outlook__updating" role="status">{companyAnalysisNotice(analysis.latestRun, true)}</p>}

      <ol className="stock-outlook__clues" aria-label={`未来走向的 ${overview.highlights.length} 项判断`}>
        {overview.highlights.map((highlight) => (
          // Title and body are direct children so a two-column row can align them through subgrid:
          // a judgment whose title runs to two lines would otherwise start its body a line below
          // the one beside it. A judgment carrying a chart takes the full width instead — a chart
          // in a half-width column is a picture of a chart, not a readable one.
          <li
            className="stock-outlook__clue"
            data-wide={highlight.blocks?.some((block) => block.type === "chart") ? "true" : undefined}
            key={highlight.ordinal}
          >
            <span className="stock-outlook__clue-index" aria-hidden="true">{highlight.ordinal}</span>
            <h3 className="stock-outlook__clue-title">{highlight.title}</h3>
            {/* Prose and blocks share the card's second row. The subgrid spans exactly two parent
                rows, so a third child here would fall outside the tracks it borrows. */}
            <div className="stock-outlook__clue-content">
              <OutlookParagraph key={highlight.body} className="stock-outlook__clue-desc" text={highlight.body} label={`第 ${highlight.ordinal} 项判断`} />
              {highlight.blocks?.length ? (
                <div className="stock-outlook__clue-blocks">
                  <ReportBlockList blocks={highlight.blocks} context={{ metrics: [], fundamentals }} />
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Headlines are written by the analysis, so their length is not a layout constant: one filing gets
 * a six-word verdict and the next gets a clause-by-clause one carrying three figures. Type scale
 * alone cannot answer that — a container query knows the column width but not how much text has to
 * fit in it — so the length picks the scale and the container query still adapts within it.
 */
function headlineLength(headline: string): "short" | "medium" | "long" {
  if (headline.length > 56) return "long";
  return headline.length > 28 ? "medium" : "short";
}

async function requestOverview(ticker: string, signal?: AbortSignal): Promise<PublicCompanyAnalysisResponse> {
  const response = await fetch(`/api/analysis/v1/companies/${encodeURIComponent(ticker)}/analysis`, { signal });
  if (!response.ok) throw new Error("公司分析读取失败。");
  return response.json() as Promise<PublicCompanyAnalysisResponse>;
}

async function requestFundamentals(ticker: string, signal?: AbortSignal): Promise<PublicFundamentalsResponse> {
  const response = await fetch(`/api/analysis/v1/companies/${encodeURIComponent(ticker)}/fundamentals`, { signal });
  if (!response.ok) throw new Error("基本面数据读取失败。");
  return response.json() as Promise<PublicFundamentalsResponse>;
}
