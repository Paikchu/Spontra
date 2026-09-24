"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ReportContentRenderer } from "@/components/earning-report/report-blocks/ReportContentRenderer";
import type { ResearchFeed, ResearchReport } from "@/shared/analysis-contract/research";
import { RESEARCH_REPORT_SCHEMA } from "@/shared/analysis-runtime/research-schema";

export function DailyReportsHome() {
  const [reports, setReports] = useState<ResearchReport[]>([]);
  const [monitor, setMonitor] = useState<ResearchFeed["monitor"] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const thread = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async (before?: string, signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/research/feed${before ? `?cursor=${encodeURIComponent(before)}` : ""}`, { cache: "no-store", signal });
      if (!response.ok) throw new Error("研究服务暂时无法连接，已保留已加载的报告。");
      const payload = await response.json() as ResearchFeed;
      if (!Array.isArray(payload.reports) || !payload.monitor) throw new Error("研究服务返回的数据暂无法读取。");
      const incoming = payload.reports.map(report => {
        const parsed = RESEARCH_REPORT_SCHEMA.safeParse(report);
        if (!parsed.success) throw new Error("一份报告暂无法读取，已保留此前汇报。");
        return parsed.data;
      });
      if (!mounted.current) return;
      const atBottom = !thread.current || thread.current.scrollHeight - thread.current.scrollTop - thread.current.clientHeight < 100;
      setReports(current => [...new Map([...current, ...incoming].map(report => [report.id, report])).values()]
        .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt) || a.id.localeCompare(b.id)));
      setMonitor(payload.monitor);
      if (before || !initialized.current) setCursor(payload.nextCursor);
      initialized.current = true;
      setError("");
      if (!before && atBottom) requestAnimationFrame(() => thread.current?.scrollTo({ top: thread.current.scrollHeight }));
    } catch (failure) {
      if (mounted.current && !signal?.aborted) setError(failure instanceof Error ? failure.message : "报告更新失败。");
    } finally { if (mounted.current) { setLoading(false); setLoadingOlder(false); } }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(undefined, controller.signal);
    const timer = setInterval(() => { if (!document.hidden) void refresh(undefined, controller.signal); }, 30_000);
    return () => { mounted.current = false; controller.abort(); clearInterval(timer); };
  }, [refresh]);

  function openReport(id: string) {
    setSelected(id);
    document.getElementById(`research-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return <section className="daily-reports" aria-labelledby="daily-reports-title">
    <div className="daily-reports-layout">
      <div className="daily-reports-conversation">
        <header className="daily-reports-heading"><div><h1 id="daily-reports-title">群聊</h1>
          <p>{monitor?.enabled ? `正在观察 ${monitor.tickers.length} 个持仓标的` : "等待后台监测接入"} · 有实质变化时汇报</p></div>
          <Link href="/ledger" className="sp-btn sp-btn-secondary sp-btn-sm">投资账本</Link></header>
        <div className="daily-reports-monitor" role="status">
          {monitor?.lastScanAt && <span>最近检查 {formatTime(monitor.lastScanAt)}{Date.now() - Date.parse(monitor.lastScanAt) > 10 * 60_000 ? " · 检查状态已过期" : ""}</span>}
          {monitor?.holdingsAsOf && <span> · 持仓快照 {formatTime(monitor.holdingsAsOf)}</span>}
          {error && <p>{error} <button type="button" onClick={() => void refresh()}>重试</button></p>}
          {!!monitor?.issues.length && <details><summary>{monitor.issues.length} 项数据覆盖缺口</summary><ul>{monitor.issues.map((issue, index) => <li key={`${issue.ticker}-${issue.source}-${index}`}>{issue.ticker} · {issue.message}</li>)}</ul></details>}
        </div>
        <div ref={thread} className="daily-reports-thread" aria-label="汇报对话">
          {cursor && <button className="sp-btn sp-btn-secondary sp-btn-sm" type="button" disabled={loadingOlder} onClick={() => { setLoadingOlder(true); void refresh(cursor); }}>{loadingOlder ? "加载中…" : "加载更早的汇报"}</button>}
          {loading && <p role="status">正在读取研究汇报…</p>}
          {!loading && !reports.length && !error && <p>尚无已发布的研究汇报。后台完成调查后，报告会自动出现在这里。</p>}
          {reports.map(report => <article id={`research-${report.id}`} key={report.id} className="daily-report-document sp-lit" aria-labelledby={`title-${report.id}`}>
            <div className="daily-reports-byline"><strong>Spontra 研究</strong><time dateTime={report.generatedAt}>{formatTime(report.generatedAt)}</time></div>
            <p className="daily-report-kicker">{report.tickers.join(" · ")} · {triggerName(report.trigger)}</p>
            <h2 id={`title-${report.id}`}>{report.title}</h2><p>{report.summary}</p>
            <ReportContentRenderer content={report.content} context={{ sources: report.sources }} surface="chat" />
            {!!report.hypotheses.length && <details className="daily-report-research-notes"><summary>关联假设与反证 · {report.hypotheses.length}</summary>{report.hypotheses.map((hypothesis, index) => <div key={index}><h3>{hypothesis.claim}</h3><p>{hypothesis.mechanism}</p><p>反证与限制：{hypothesis.counterEvidence}</p><p>待验证：{hypothesis.nextCheck}</p></div>)}</details>}
            {!!report.followups.length && <div className="daily-report-research-notes"><h3>继续观察</h3><ul>{report.followups.map((followup, index) => <li key={index}>{followup.question} · {formatTime(followup.dueAt)}</li>)}</ul></div>}
            {!!report.limitations.length && <details className="daily-report-research-notes"><summary>研究局限</summary><ul>{report.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></details>}
          </article>)}
        </div>
      </div>
      <aside className="daily-reports-queue" aria-labelledby="daily-reports-queue-title">
        <div className="daily-reports-queue-heading"><h2 id="daily-reports-queue-title">研究汇报</h2><span>{reports.length} 份已加载</span></div>
        <div className="daily-reports-tiles">{[...reports].reverse().map(report => <button className="daily-reports-tile" type="button" key={report.id} aria-pressed={selected === report.id} onClick={() => openReport(report.id)}><span className="daily-reports-tile-title">{report.title}</span><span className="daily-reports-tile-agent">{formatTime(report.generatedAt)}</span><span className="daily-reports-tile-subject">{report.tickers.join(" · ")}</span></button>)}</div>
      </aside>
    </div>
  </section>;
}
function formatTime(value: string) { return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }); }
function triggerName(trigger: ResearchReport["trigger"]) { return { baseline: "初始研究", price: "行情异动", filing: "新披露", news: "新闻变化", followup: "持续核查", discovery: "关联发现" }[trigger]; }
