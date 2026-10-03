"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "@/packages/ui/src/navigation";
import { ArrowLeft, Check, ChevronRight, Clock3, FileText, History, Info, LoaderCircle, LogOut, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import type { ReportAdminDetail, ReportAdminItem, ReportAdminPage, ReportAdminStatus } from "@/shared/analysis-contract/admin";
import { CompanyLogo } from "@/app/company-logo";
import { SecReportDocument } from "@/app/analysis/stocks/[ticker]/sec/[accession]/SecReportDocument";
import { filingPresentation } from "@/packages/client/src/report";

const labels: Record<ReportAdminStatus, string> = { unreviewed: "待检查", reviewed: "已检查", processing: "生成中", failed: "生成失败", pending: "待生成" };
const stages: Record<string, string> = { queued: "等待执行", prepare: "解析原始财报", discovery: "扫描披露内容", context: "加载研究上下文", brief: "准备研究材料", manager: "规划分析", "nodes-round-0": "分析业务与财务", "manager-review": "核验分析结论", synthesis: "撰写报告", "editorial-review": "审校报告", "editorial-revision": "修订报告", presentation: "编排图文", published: "已发布", verification: "核验未通过" };
function date(value?: string | null) {
  if (!value) return "—";
  const parsed = new Date(value.includes("T") ? value : value.replace(" ", "T") + (value.length > 10 ? "Z" : ""));
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed);
}
function period(item: { reportDate: string; form: string }) { return `${item.reportDate || "报告期待确认"} · ${item.form}`; }
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/admin/${path}`, { ...options, cache: "no-store", credentials: "same-origin", headers: { "content-type": "application/json", ...options.headers } });
  const payload = await response.json().catch(() => ({ error: "服务暂时不可用。" })) as T & { error?: string };
  if (!response.ok) throw new ApiError(payload.error ?? "操作未完成，请重试。", response.status);
  return payload as T;
}
const identity = (item: Pick<ReportAdminItem, "ticker" | "accessionNumber">) => `${item.ticker}/${item.accessionNumber}`;

export function ReportAdminDashboard({ mainAppOrigin = "" }: { mainAppOrigin?: string }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [section, setSection] = useState("reports");
  const [reports, setReports] = useState<ReportAdminItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReportAdminDetail | null>(null);
  const [version, setVersion] = useState("");
  const [tab, setTab] = useState("content");
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [mutation, setMutation] = useState("");
  const [optimisticJob, setOptimisticJob] = useState<{ selected: string; jobId: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const listRequest = useRef(0);
  const selectedRef = useRef<string | null>(null);
  const detailRequestIdentity = useRef("");
  const reportsRef = useRef<ReportAdminItem[]>([]);
  const listFilter = useRef("");

  function chooseReport(next: string | null) {
    selectedRef.current = next; setSelected(next); setVersion(""); setDetail(null);
    setDetailError(""); setConfirming(false); setLoadingDetail(!!next);
  }

  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    if (authenticated === false) return;
    const sequence = ++listRequest.current;
    const controller = new AbortController();
    const filter = JSON.stringify([query, status]);
    const changedFilter = filter !== listFilter.current;
    listFilter.current = filter;
    queueMicrotask(() => { if (!controller.signal.aborted) { setLoading(true); setError(""); } });
    const parameters = new URLSearchParams({ search: query, status });
    void api<ReportAdminPage>(`reports?${parameters}`, { signal: controller.signal }).then(page => {
      if (sequence !== listRequest.current) return;
      const hadMorePages = !changedFilter && reportsRef.current.length > 40;
      const merged = hadMorePages ? [...page.reports, ...reportsRef.current.slice(40).filter(item => !page.reports.some(row => identity(row) === identity(item)))] : page.reports;
      reportsRef.current = merged;
      setAuthenticated(true); setReports(merged); if (!hadMorePages) setNextCursor(page.nextCursor);
      if (!merged.some(item => identity(item) === selectedRef.current)) chooseReport(merged[0] ? identity(merged[0]) : null);
    }).catch(error => {
      if (controller.signal.aborted || sequence !== listRequest.current) return;
      if (error instanceof ApiError && error.status === 401) { setAuthenticated(false); setReports([]); setDetail(null); setSelected(null); }
      else setError(error.message);
    }).finally(() => { if (!controller.signal.aborted && sequence === listRequest.current) setLoading(false); });
    return () => controller.abort();
  }, [authenticated, query, status, refresh]);

  useEffect(() => {
    if (!authenticated || !selected) return;
    const controller = new AbortController();
    const requestIdentity = `${selected}?${version}`;
    const changed = requestIdentity !== detailRequestIdentity.current;
    detailRequestIdentity.current = requestIdentity;
    queueMicrotask(() => { if (!controller.signal.aborted) { setDetailError(""); if (changed) { setLoadingDetail(true); setDetail(null); } } });
    void api<ReportAdminDetail>(`reports/${selected}${version ? `?version=${encodeURIComponent(version)}` : ""}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setDetail(result);
      setOptimisticJob(current => current && result.jobs.some(job => job.jobId.endsWith(current.jobId)) ? null : current);
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) setAuthenticated(false);
      else setDetailError(error.message);
    }).finally(() => { if (!controller.signal.aborted) setLoadingDetail(false); });
    return () => controller.abort();
  }, [authenticated, selected, version, refresh]);
  useEffect(() => {
    if (!authenticated) return;
    const interval = setInterval(() => { if (!document.hidden && !mutation && !confirming) setRefresh(value => value + 1); }, 15_000);
    return () => clearInterval(interval);
  }, [authenticated, mutation, confirming]);
  useEffect(() => {
    if (confirming) dialog.current?.showModal(); else dialog.current?.close();
  }, [confirming]);

  async function login(event: FormEvent) {
    event.preventDefault(); setLoginBusy(true); setError("");
    try { await api("session", { method: "POST", body: JSON.stringify({ key }) }); setKey(""); setAuthenticated(true); }
    catch (error) { setError((error as Error).message); }
    finally { setLoginBusy(false); }
  }
  async function logout() {
    try { await api("session", { method: "DELETE" }); setAuthenticated(false); setReports([]); setDetail(null); setSelected(null); setNotice(""); }
    catch (error) { setError((error as Error).message); }
  }
  async function loadMore() {
    if (!nextCursor || paging) return;
    const sequence = listRequest.current;
    setPaging(true);
    try {
      const page = await api<ReportAdminPage>(`reports?${new URLSearchParams({ search: query, status, cursor: nextCursor })}`);
      if (sequence === listRequest.current) { const merged = [...reportsRef.current, ...page.reports.filter(item => !reportsRef.current.some(existing => identity(existing) === identity(item)))]; reportsRef.current = merged; setReports(merged); setNextCursor(page.nextCursor); }
    } catch (error) { if ((error as ApiError).status === 401) setAuthenticated(false); else setError((error as Error).message); }
    finally { setPaging(false); }
  }
  async function markReviewed() {
    const reviewVersion = detail?.filing.reportVersion ?? detail?.filing.summary?.generatedAt;
    if (!selected || !reviewVersion || mutation) return;
    setMutation("review"); setDetailError("");
    try { await api(`reports/${selected}/review`, { method: "POST", body: JSON.stringify({ version: reviewVersion }) }); setNotice("这份报告已标记为已检查。"); setRefresh(value => value + 1); }
    catch (error) { if ((error as ApiError).status === 401) setAuthenticated(false); else setDetailError((error as Error).message); }
    finally { setMutation(""); }
  }
  async function regenerate() {
    if (!selected || mutation || !detail) return;
    setMutation("regenerate"); setDetailError("");
    try {
      const queued = await api<{ jobId: string }>(`reports/${selected}/regenerate`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() } });
      setOptimisticJob({ selected, jobId: queued.jobId }); setNotice("重新生成任务已提交。完成后可查看新版本，当前报告会保留。");
      setVersion(""); setTab("history"); setConfirming(false); setRefresh(value => value + 1);
    } catch (error) { setConfirming(false); if ((error as ApiError).status === 401) setAuthenticated(false); else setDetailError((error as Error).message); }
    finally { setMutation(""); }
  }
  function navigate(section: string) { setSection(section); setStatus(section === "tasks" ? "processing" : ""); setTab(section === "history" ? "history" : "content"); setVersion(""); }
  const selectedItem = reports.find(item => identity(item) === selected);
  const hasActiveJob = Boolean(selectedItem?.status === "processing" || optimisticJob?.selected === selected);
  const currentVersion = detail?.filing.reportVersion ?? detail?.filing.summary?.generatedAt;
  const title = section === "tasks" ? "生成任务" : section === "history" ? "生成记录" : "报告管理";

  return <div className="report-admin">
    <aside className="ra-sidebar">
      <a className="ra-brand" href="/admin/reports"><span><FileText size={21} /></span>财报工作台</a>
      <nav aria-label="财报后台导航">
        <button aria-current={section === "reports" ? "page" : undefined} onClick={() => navigate("reports")}><FileText size={19} />报告管理</button>
        <button aria-current={section === "tasks" ? "page" : undefined} onClick={() => navigate("tasks")}><Clock3 size={19} />生成任务</button>
        <button aria-current={section === "history" ? "page" : undefined} onClick={() => navigate("history")}><History size={19} />生成记录</button>
      </nav>
      <div className="ra-sidebar-bottom"><Link href={`${mainAppOrigin}/`}><ArrowLeft size={17} />返回 Spontra</Link><div><ShieldCheck size={23} /><span>管理员</span>{authenticated && <button onClick={() => void logout()} aria-label="退出登录" title="退出登录"><LogOut size={17} /></button>}</div></div>
    </aside>
    <main className="ra-main">
      <header className="ra-page-header"><div><p>工作台 <ChevronRight size={13} /> {title}</p><h1>{title}</h1><span>{section === "tasks" ? "查看生成进度，跟踪报告发布" : "检查分析内容，管理报告生成"}</span></div><div className="ra-header-actions"><div className="ra-live"><span />线上数据</div>{authenticated && <button className="ra-mobile-logout" onClick={() => void logout()} aria-label="退出登录"><LogOut size={17} /></button>}</div></header>
      {authenticated === false ? <div className="ra-login"><ShieldCheck size={34} /><h2>登录财报管理后台</h2><p>使用财报 Pipeline 的管理密钥登录。</p><form onSubmit={event => void login(event)}><label htmlFor="admin-key">管理密钥</label><input id="admin-key" type="password" autoComplete="current-password" value={key} onChange={event => setKey(event.target.value)} required placeholder="输入管理密钥" /><button className="ra-primary" disabled={loginBusy || !key}>{loginBusy && <LoaderCircle className="ra-spin" size={16} />}{loginBusy ? "正在登录" : "登录后台"}</button></form>{error && <p role="alert" className="ra-error">{error}</p>}<small>登录有效期 8 小时，密钥不会保存在浏览器本地存储。</small></div> : <>
        {notice && <div className="ra-notice" role="status"><Check size={16} />{notice}<button aria-label="关闭通知" onClick={() => setNotice("")}><X size={16} /></button></div>}
        {error && <div className="ra-error ra-error-banner" role="alert">{error}<button onClick={() => setRefresh(value => value + 1)}>重试</button></div>}
        <div className="ra-workspace">
          <section className="ra-list" aria-label="财报报告列表">
            <div className="ra-filters"><label className="ra-search"><Search size={17} /><input aria-label="搜索公司或报告" placeholder="搜索公司或报告" value={search} onChange={event => setSearch(event.target.value)} /></label><select aria-label="报告状态" value={status} onChange={event => { setStatus(event.target.value); setSection("reports"); }}><option value="">全部状态</option>{Object.entries(labels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
            <div className="ra-list-caption"><span>{loading ? "正在同步报告…" : `已加载 ${reports.length} 份报告`}</span><button onClick={() => setRefresh(value => value + 1)} aria-label="刷新报告列表" disabled={loading}><RefreshCw size={14} className={loading ? "ra-spin" : ""} /></button></div>
            <div className="ra-list-scroll">{loading && !reports.length ? <div className="ra-empty" role="status"><LoaderCircle className="ra-spin" />正在读取线上报告</div> : reports.length ? reports.map(item => <button key={identity(item)} className="ra-report-row" aria-pressed={selected === identity(item)} onClick={() => { chooseReport(identity(item)); setNotice(""); }}><CompanyLogo symbol={item.ticker} /><span className="ra-row-info"><strong>{item.companyName || item.ticker}</strong><small>{item.ticker}</small><span>{period(item)}</span></span><span className="ra-row-state"><span className="ra-badge" data-status={item.status}>{labels[item.status]}</span><small>{date(item.updatedAt)}</small></span></button>) : <div className="ra-empty"><FileText /><h3>{error ? "报告暂时无法加载" : "没有符合条件的报告"}</h3><p>{error ? "请重试，或检查财报服务连接。" : query || status ? "试试其他公司名称或状态。" : "财报分析生成后会出现在这里。"}</p></div>}{nextCursor && <button className="ra-load-more" disabled={paging || loading} onClick={() => void loadMore()}>{paging ? "加载中…" : "加载更多报告"}</button>}</div>
          </section>
          <section className="ra-detail" aria-label="报告内容检查" aria-busy={loadingDetail}>
            {loadingDetail ? <div className="ra-empty" role="status"><LoaderCircle className="ra-spin" />正在读取报告内容</div> : detail ? <>
              <header className="ra-detail-header"><div><h2>{detail.filing.companyName} · 财报分析</h2><p>{detail.filing.ticker} · {period(detail.filing)}</p><small>生成于 {date(detail.filing.summary?.generatedAt)}{detail.reviewedAt && ` · 已检查 ${date(detail.reviewedAt)}`}</small></div><div className="ra-actions"><button className="ra-primary" disabled={!!mutation || hasActiveJob || !detail.canRegenerate} onClick={() => setConfirming(true)} title={!detail.canRegenerate ? "该公司未启用 AI 财报分析" : undefined}><RefreshCw size={16} />{hasActiveJob ? "正在生成" : "重新生成"}</button><button className="ra-review" disabled={!!mutation || !!detail.reviewedAt || !currentVersion} onClick={() => void markReviewed()}>{mutation === "review" ? "正在保存…" : detail.reviewedAt ? <><Check size={15} />已检查</> : "标记已检查"}</button></div></header>
              {detailError && <div className="ra-error ra-error-banner" role="alert">{detailError}</div>}
              <div className="ra-tabbar"><div role="tablist" aria-label="报告视图"><button role="tab" aria-selected={tab === "content"} aria-controls="ra-content-panel" id="ra-content-tab" onClick={() => setTab("content")}>报告内容</button><button role="tab" aria-selected={tab === "history"} aria-controls="ra-history-panel" id="ra-history-tab" onClick={() => setTab("history")}>生成记录</button></div>{detail.versions.length > 0 && <label className="ra-version">版本<select aria-label="报告版本" value={version} onChange={event => setVersion(event.target.value)}><option value="">最新版本</option>{detail.versions.map((item, index) => <option value={item.reportVersion} key={item.reportVersion}>{`v${detail.versions.length - index} · ${date(item.generatedAt)}`}</option>)}</select></label>}</div>
              {tab === "content" ? <div role="tabpanel" id="ra-content-panel" aria-labelledby="ra-content-tab" className="ra-document"><div className="ra-source"><Info size={17} />来源：SEC EDGAR · {detail.filing.form} · {detail.filing.reportDate || detail.filing.filingDate}</div>{hasActiveJob && <p className="ra-progress" role="status"><LoaderCircle size={15} className="ra-spin" />正在重新生成，当前显示已保存的报告。</p>}<SecReportDocument embedded {...filingPresentation({ filing: detail.filing, ticker: detail.filing.ticker, company: { ticker: detail.filing.ticker, name: detail.filing.companyName, cik: "" }, apiSchemaVersion: "analysis-api.v1" }, detail.filing.ticker, detail.filing.companyName)} /><p className="ra-footnote">重新生成将创建新版本，当前报告会保留。新版本需要重新检查。</p></div> : <div role="tabpanel" id="ra-history-panel" aria-labelledby="ra-history-tab" className="ra-history"><h3>生成任务</h3>{!detail.jobs.length ? <p className="ra-muted">暂无生成任务记录。</p> : <ol>{detail.jobs.map(job => <li key={job.jobId}><span className="ra-badge" data-status={job.status === "failed" ? "failed" : job.status === "complete" ? "reviewed" : "processing"}>{job.status === "complete" ? "已完成" : job.status === "failed" ? "生成失败" : job.status === "queued" ? "排队中" : "生成中"}</span><div><strong>{stages[job.currentStage] ?? job.currentStage}</strong><p>{job.requestedBy === "manual" ? "手动生成" : "自动生成"} · 尝试 {job.attempt} 次 · {date(job.updatedAt)}</p>{job.errorCode && <p className="ra-error">错误代码：{job.errorCode}</p>}<details><summary>任务标识</summary><code>{job.jobId}</code></details></div></li>)}</ol>}<h3>报告版本</h3><ol>{detail.versions.map((item, index) => <li key={item.reportVersion}><FileText size={19} /><div><strong>v{detail.versions.length - index}{item.reviewedAt ? " · 已检查" : " · 待检查"}</strong><p>{date(item.generatedAt)} · {item.verificationStatus === "verified" ? "核验通过" : item.verificationStatus === "partial" ? "部分核验" : item.verificationStatus === "summary" ? "事件简析" : "核验失败"}</p><button className="ra-text-button" onClick={() => { setVersion(item.reportVersion); setTab("content"); }}>查看此版本</button></div></li>)}</ol></div>}
            </> : <div className="ra-empty"><FileText size={32} /><h3>{detailError ? "报告内容暂时不可用" : "选择一份报告开始检查"}</h3><p>{detailError || "查看完整分析内容，并管理生成版本。"}</p>{detailError && <button className="ra-text-button" onClick={() => setRefresh(value => value + 1)}>重新加载</button>}</div>}
          </section>
        </div>
      </>}
    </main>
    <dialog ref={dialog} className="ra-dialog" onCancel={() => { if (!mutation) setConfirming(false); }} onClose={() => setConfirming(false)} aria-labelledby="ra-confirm-title"><div><RefreshCw size={27} /><h2 id="ra-confirm-title">重新生成这份财报分析？</h2><p>{detail?.filing.companyName} · {detail ? period(detail.filing) : ""}</p><p>将根据这份财报的原始材料重新生成分析，可能需要数分钟。当前报告和历史版本会保留。</p><div className="ra-dialog-actions"><button disabled={!!mutation} onClick={() => setConfirming(false)}>取消</button><button className="ra-primary" disabled={!!mutation} onClick={() => void regenerate()}>{mutation === "regenerate" && <LoaderCircle className="ra-spin" size={15} />}{mutation === "regenerate" ? "正在提交…" : "确认重新生成"}</button></div></div></dialog>
  </div>;
}
