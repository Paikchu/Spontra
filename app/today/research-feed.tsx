"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, ChevronDown } from "lucide-react";
import { ReportContentRenderer } from "@/components/earning-report/report-blocks/ReportContentRenderer";
import { CompanyLogo } from "@/app/company-logo";
import { useLanguage } from "@/app/language-provider";
import type { ResearchFeed as Feed, ResearchReport } from "@/shared/analysis-contract/research";
import { RESEARCH_REPORT_SCHEMA } from "@/shared/analysis-runtime/research-schema";

/** Report IDs this browser has opened. Per device by design: the feed has no read state yet. */
const READ_KEY = "spontra:research:read";
const READ_LIMIT = 500;
const TIME_ZONE = "Asia/Shanghai";
const DESKTOP_QUERY = "(min-width: 1024px)";

type Filter = "all" | "unread";

const TRIGGER_LABEL: Record<ResearchReport["trigger"], string> = {
  baseline: "初始研究", price: "行情异动", filing: "新披露", news: "新闻变化", followup: "持续核查", discovery: "关联发现",
};

const dayKey = (value: string | Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
const clock = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
const stamp = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: TIME_ZONE, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));

function dayLabel(key: string, now: Date, language: string) {
  const date = new Date(`${key}T12:00:00+08:00`);
  const monthDay = new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { timeZone: TIME_ZONE, month: language === "en" ? "short" : "long", day: "numeric" }).format(date);
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000));
  if (key === today) return `${language === "en" ? "Today" : "今天"} · ${monthDay}`;
  if (key === yesterday) return `${language === "en" ? "Yesterday" : "昨天"} · ${monthDay}`;
  const weekday = new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { timeZone: TIME_ZONE, weekday: "short" }).format(date);
  return `${monthDay} ${weekday}`;
}

function readStoredIds(): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(READ_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === "string")) : null;
  } catch { return null; }
}

function storeIds(ids: Set<string>) {
  try { window.localStorage.setItem(READ_KEY, JSON.stringify([...ids].slice(-READ_LIMIT))); } catch { /* storage unavailable: unread state lasts for this visit */ }
}

const newestFirst = (a: ResearchReport, b: ResearchReport) => b.generatedAt.localeCompare(a.generatedAt) || b.id.localeCompare(a.id);

export function ResearchFeed() {
  const { t, language } = useLanguage();
  const [reports, setReports] = useState<ResearchReport[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<"list" | "reader">("list");
  const [readIds, setReadIds] = useState<Set<string> | null>(null);
  const [now, setNow] = useState(() => new Date());
  const section = useRef<HTMLElement>(null);
  const readerScroll = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const mounted = useRef(true);
  const storageChecked = useRef(false);

  const refresh = useCallback(async (before?: string, signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/research/feed${before ? `?cursor=${encodeURIComponent(before)}` : ""}`, { cache: "no-store", signal });
      if (!response.ok) throw new Error("研究服务暂时无法连接，已保留已加载的汇报。");
      const payload = await response.json() as Feed;
      if (!Array.isArray(payload.reports) || !payload.monitor) throw new Error("研究服务返回的数据暂无法读取。");
      const incoming = payload.reports.map(report => {
        const parsed = RESEARCH_REPORT_SCHEMA.safeParse(report);
        if (!parsed.success) throw new Error("一份汇报暂无法读取，已保留此前的汇报。");
        return parsed.data;
      });
      if (!mounted.current) return;
      setReports(current => [...new Map([...current, ...incoming].map(report => [report.id, report])).values()].sort(newestFirst));
      const newest = [...incoming].sort(newestFirst)[0]?.id ?? null;
      setSelected(current => current ?? newest);
      if (!storageChecked.current && incoming.length) {
        // First visit on this device: everything already published counts as read, so only new reports get a dot.
        storageChecked.current = true;
        const stored = readStoredIds();
        const next = stored ?? new Set(incoming.map(report => report.id));
        // On desktop the newest report opens straight into the reader, so it has been seen.
        if (newest && window.matchMedia(DESKTOP_QUERY).matches) next.add(newest);
        storeIds(next);
        setReadIds(next);
      }
      if (before || !initialized.current) setCursor(payload.nextCursor);
      initialized.current = true;
      setNow(new Date());
      setError("");
    } catch (failure) {
      if (mounted.current && !signal?.aborted) setError(failure instanceof Error ? failure.message : "汇报更新失败。");
    } finally { if (mounted.current) { setLoading(false); setLoadingOlder(false); } }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    // Start from a task, not the effect body, so the first response never renders synchronously inside the effect.
    const first = setTimeout(() => void refresh(undefined, controller.signal), 0);
    const timer = setInterval(() => { if (!document.hidden) void refresh(undefined, controller.signal); }, 30_000);
    return () => { mounted.current = false; controller.abort(); clearTimeout(first); clearInterval(timer); };
  }, [refresh]);

  const markRead = useCallback((id: string) => {
    setReadIds(current => {
      if (!current || current.has(id)) return current;
      const next = new Set(current).add(id);
      storeIds(next);
      return next;
    });
  }, []);

  useEffect(() => { readerScroll.current?.scrollTo({ top: 0 }); }, [selected]);

  function open(id: string) {
    setSelected(id);
    markRead(id);
    if (!window.matchMedia(DESKTOP_QUERY).matches) {
      setView("reader");
      requestAnimationFrame(() => section.current?.scrollIntoView({ block: "start" }));
    }
  }

  function back() {
    setView("list");
    requestAnimationFrame(() => document.getElementById(`research-tile-${selected}`)?.focus({ preventScroll: false }));
  }

  const isUnread = useCallback((report: ResearchReport) => readIds !== null && !readIds.has(report.id), [readIds]);
  const unreadCount = reports.filter(isUnread).length;
  const groups = useMemo(() => {
    const visible = filter === "unread" ? reports.filter(isUnread) : reports;
    const byDay = new Map<string, ResearchReport[]>();
    for (const report of visible) {
      const key = dayKey(report.generatedAt);
      byDay.set(key, [...(byDay.get(key) ?? []), report]);
    }
    return [...byDay.entries()].map(([key, items]) => ({ key, label: dayLabel(key, now, language), items }));
  }, [filter, reports, isUnread, now, language]);

  const active = reports.find(report => report.id === selected) ?? null;

  return (
    <section ref={section} className="research" data-view={view} aria-labelledby="research-title">
      <div className="research-head">
        <div className="research-heading">
          <h2 id="research-title">{t("研究汇报")}</h2>
          {reports.length > 0 && <span className="research-count">{reports.length} {t("份")}{unreadCount ? ` · ${unreadCount} ${t("份未读")}` : ""}</span>}
        </div>
      </div>

      {error && <div className="research-error" role="alert"><p>{t(error)}</p><button type="button" className="sp-btn sp-btn-secondary sp-btn-sm" onClick={() => void refresh()}>{t("重试")}</button></div>}

      <div className="research-layout">
        <div className="research-list">
          <div className="sp-seg" role="group" aria-label={t("筛选汇报")}>
            {(["all", "unread"] as const).map(key => (
              <button key={key} type="button" className={`sp-seg-item${filter === key ? " is-on" : ""}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                {t(key === "all" ? "全部" : "未读")}<span className="sp-seg-count">{key === "all" ? reports.length : unreadCount}</span>
              </button>
            ))}
          </div>
          <div className="research-tiles">
            {loading && <p className="research-note" role="status">{t("正在读取研究汇报…")}</p>}
            {!loading && !reports.length && !error && <div className="research-empty"><strong>{t("尚无已发布的研究汇报")}</strong><p>{t("研究 Agent 完成调查后，汇报会出现在这里。持仓有实质变化时才会汇报。")}</p></div>}
            {!loading && reports.length > 0 && !groups.length && <div className="research-empty"><p>{t("没有未读的汇报。")}</p></div>}
            {groups.map(group => (
              <div className="research-group" key={group.key}>
                <p className="research-day">{group.label}</p>
                {group.items.map(report => (
                  <button key={report.id} id={`research-tile-${report.id}`} type="button" className="research-tile" aria-pressed={selected === report.id} onClick={() => open(report.id)}>
                    <span className="research-tile-meta">
                      <CompanyLogo symbol={report.tickers[0]} />
                      <span className="research-tile-tickers">{report.tickers.join(" · ")}</span>
                      <span className="research-tile-trigger">· {t(TRIGGER_LABEL[report.trigger])}</span>
                      <time dateTime={report.generatedAt}>{clock(report.generatedAt)}</time>
                      {isUnread(report) && <span className="research-unread" role="img" aria-label={t("未读")} />}
                    </span>
                    <span className="research-tile-title">{report.title}</span>
                    <span className="research-tile-summary">{report.summary}</span>
                  </button>
                ))}
              </div>
            ))}
            {cursor && <div className="research-more"><button className="sp-btn sp-btn-secondary sp-btn-sm" type="button" disabled={loadingOlder} onClick={() => { setLoadingOlder(true); void refresh(cursor); }}>{t(loadingOlder ? "加载中…" : "加载更早的汇报")}</button></div>}
          </div>
        </div>

        <article className="sp-card research-reader" aria-labelledby={active ? `research-title-${active.id}` : undefined} aria-label={active ? undefined : t("汇报正文")}>
          {active ? <>
            <div className="research-reader-bar">
              <button type="button" className="sp-btn sp-btn-sm research-back" onClick={back}><ArrowLeft aria-hidden="true" />{t("研究汇报")}</button>
              <p className="research-byline"><strong>Spontra {t("研究")}</strong><time dateTime={active.generatedAt}>{stamp(active.generatedAt)}</time></p>
              <Link href={`/positions/${encodeURIComponent(active.tickers[0])}`} className="sp-btn sp-btn-secondary sp-btn-sm research-open">
                <span className="research-open-label">{t("打开")} {active.tickers[0]} {t("详情")}</span><ArrowUpRight aria-hidden="true" />
              </Link>
            </div>
            <div className="research-reader-scroll" ref={readerScroll}>
              <div className="research-reader-body">
                <header className="research-reader-head">
                  <div className="research-chips">
                    {active.tickers.map(ticker => <span key={ticker} className="research-chip">{ticker}</span>)}
                    <span className="research-trigger">{t(TRIGGER_LABEL[active.trigger])}</span>
                  </div>
                  <h3 id={`research-title-${active.id}`}>{active.title}</h3>
                </header>
                <section className="research-conclusion" aria-label={t("一句话结论")}>
                  <p className="research-label">{t("一句话结论")}</p>
                  <p>{active.summary}</p>
                </section>
                <ReportContentRenderer content={active.content} context={{ sources: active.sources }} surface="chat" />
                <div className="research-folds">
                  {!!active.hypotheses.length && (
                    <details className="research-fold">
                      <summary>{t("关联假设与反证")} · {active.hypotheses.length}<ChevronDown aria-hidden="true" /></summary>
                      <div className="research-fold-body">
                        {active.hypotheses.map((hypothesis, index) => (
                          <div className="research-hypothesis" key={index}>
                            <h4>{hypothesis.claim}</h4>
                            <p>{hypothesis.mechanism}</p>
                            <p><strong>{t("反证与限制")}</strong>{hypothesis.counterEvidence}</p>
                            <p><strong>{t("待验证")}</strong>{hypothesis.nextCheck}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  {!!active.followups.length && (
                    <details className="research-fold" open>
                      <summary>{t("继续观察")} · {active.followups.length}<ChevronDown aria-hidden="true" /></summary>
                      <ul className="research-fold-body research-followups">
                        {active.followups.map((followup, index) => <li key={index}><time dateTime={followup.dueAt}>{stamp(followup.dueAt)}</time>{followup.question}</li>)}
                      </ul>
                    </details>
                  )}
                  {!!active.limitations.length && (
                    <details className="research-fold">
                      <summary>{t("研究局限")}<ChevronDown aria-hidden="true" /></summary>
                      <ul className="research-fold-body research-limitations">{active.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
                    </details>
                  )}
                </div>
              </div>
            </div>
          </> : (
            <p className="research-reader-empty">{loading ? t("正在读取研究汇报…") : t("选择左侧的一份汇报开始阅读。")}</p>
          )}
        </article>
      </div>
    </section>
  );
}
