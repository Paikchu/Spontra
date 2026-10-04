import { FinancialStatementsInspector } from "./financial-statements-inspector";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Database, ExternalLink, FileSearch, LoaderCircle, Pause, Play, Plus, RefreshCw, Search, X } from "lucide-react";
import type {
  FinancialMaintenanceActionResponse, FinancialMaintenanceCompanyDetail,
  FinancialMaintenanceCompanyList, FinancialMaintenanceTask,
} from "@/shared/analysis-contract/financial-maintenance";
import { adminApi, AdminApiError } from "./admin-api";
import { DisclosureInspector } from "./disclosure-inspector";
import { completeRequestId, displayFinancialValue, normalizeCompanyTicker, pendingRequestId, safeEvidenceUrl } from "./financial-maintenance-state";
import "./financial-maintenance.css";

type Action = "extract" | "analyze" | "retry";
type Operation = { ticker: string; action: Action; retryTaskId?: string };
const taskLabels: Record<string, string> = { queued: "排队中", running: "执行中", succeeded: "已完成", partial: "部分完成", failed: "失败", cancel_requested: "取消中", cancelled: "已取消" };
const actionLabels: Record<Action, string> = { extract: "补全财报数据", analyze: "分析公司", retry: "重试任务" };
const activeStatuses = new Set(["queued", "running", "cancel_requested"]);
const basisLabels: Record<string, string> = { reported: "原始披露", derived: "计算所得", missing: "未提取" };
const stageLabels: Record<string, string> = { queued: "等待执行", waiting_issuer: "等待同公司维护任务完成", identify: "确认公司身份", backup: "保留可恢复备份", history: "补全历史季度", audit: "归档原始披露", analysis_dispatch: "提交分析任务", analysis_wait: "等待分析工作流完成", finalize: "核对完成情况", cancelled: "已取消", discover: "发现原始财报", discovery: "发现原始财报", extract: "提取财报数据", collect: "收集原始来源", analyze: "分析财报", analysis: "分析财报", complete: "已完成", completed: "已完成", dispatch: "提交工作流", "refresh-data": "更新财报数据" };
const date = (value?: string | null) => value ? value.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC") : "—";
const initialTicker = () => typeof window === "undefined" ? "" : normalizeCompanyTicker(new URL(window.location.href).searchParams.get("ticker") ?? "");
function storage(): Storage | undefined { try { return window.sessionStorage; } catch { return undefined; } }

export function FinancialMaintenance({ onUnauthorized, onAuthenticated }: { onUnauthorized: () => void; onAuthenticated: () => void }) {
  const [list, setList] = useState<FinancialMaintenanceCompanyList | null>(null);
  const [ticker, setTicker] = useState(initialTicker);
  const [search, setSearch] = useState("");
  const [newTicker, setNewTicker] = useState("");
  const [newAction, setNewAction] = useState<"extract" | "analyze">("extract");
  const [detail, setDetail] = useState<FinancialMaintenanceCompanyDetail | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState("");
  const [metricSearch, setMetricSearch] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [listRefresh, setListRefresh] = useState(0);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mutation, setMutation] = useState("");
  const [operation, setOperation] = useState<Operation | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const mutationLock = useRef(false);
  const mounted = useRef(true);
  const unauthorized = useRef(onUnauthorized);
  const authenticated = useRef(onAuthenticated);
  const selectedTicker = useRef(ticker);
  useEffect(() => { unauthorized.current = onUnauthorized; authenticated.current = onAuthenticated; }, [onUnauthorized, onAuthenticated]);
  useEffect(() => { selectedTicker.current = ticker; }, [ticker]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void adminApi<FinancialMaintenanceCompanyList>("financials/companies", { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setList(result);
      authenticated.current();
      setTicker(current => current || (result.companies.some(company => company.ticker === "ORCL") ? "ORCL" : result.companies[0]?.ticker ?? ""));
      if (!result.companies.length) setLoading(false);
    }).catch((err: Error) => {
      if (controller.signal.aborted) return;
      if (err instanceof AdminApiError && err.status === 401) unauthorized.current();
      else { setError(err.message); setLoading(false); }
    });
    return () => controller.abort();
  }, [listRefresh]);

  useEffect(() => {
    if (!ticker) return;
    const controller = new AbortController();
    const url = new URL(window.location.href);
    url.searchParams.set("ticker", ticker);
    window.history.replaceState(null, "", url.pathname + url.search);
    void adminApi<FinancialMaintenanceCompanyDetail>(`financials/companies/${ticker}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setDetail(result);
      setSelectedPeriod(current => result.periods.some(period => period.periodEnd === current) ? current : result.periods[0]?.periodEnd ?? "");
    }).catch((err: Error) => {
      if (controller.signal.aborted) return;
      if (err instanceof AdminApiError && err.status === 401) unauthorized.current();
      else setError(err.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ticker, refresh]);

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => {
      if (!document.hidden && !mutationLock.current) setRefresh(value => value + 1);
    }, 10_000);
    return () => clearInterval(timer);
  }, [paused]);
  useEffect(() => { if (operation) dialog.current?.showModal(); else dialog.current?.close(); }, [operation]);

  function chooseCompany(value: string) {
    if (value === selectedTicker.current) return;
    selectedTicker.current = value;
    setTicker(value); setLoading(true); setDetail(null); setSelectedPeriod(""); setMetricSearch(""); setError(""); setNotice("");
  }
  function addCompany(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeCompanyTicker(newTicker);
    if (!normalized) { setError("请输入有效的股票代码，例如 ORCL、MSFT 或 BRK.B。"); return; }
    setOperation({ ticker: normalized, action: newAction });
  }
  function requestRefresh() { setError(""); setRefresh(value => value + 1); setListRefresh(value => value + 1); }

  async function performOperation() {
    if (!operation || mutationLock.current) return;
    const current = operation;
    const key = `${current.ticker}:${current.action}:${current.retryTaskId ?? ""}`;
    const requestId = pendingRequestId(key, storage());
    mutationLock.current = true; setMutation(key); setError("");
    try {
      const result = await adminApi<FinancialMaintenanceActionResponse>(`financials/companies/${current.ticker}/actions`, {
        method: "POST", headers: { "idempotency-key": requestId }, body: JSON.stringify({ ...current, requestId }),
      });
      completeRequestId(key, storage());
      if (!mounted.current) return;
      setOperation(null);
      if (current.ticker !== selectedTicker.current) chooseCompany(current.ticker);
      else setDetail(previous => previous ? { ...previous, tasks: [result.task, ...previous.tasks.filter(task => task.id !== result.task.id)] } : previous);
      setNotice(result.reused ? "已连接到已有任务，没有重复提交。" : "任务已提交；刷新或关闭页面后仍在后台执行。");
      setNewTicker(""); setRefresh(value => value + 1); setListRefresh(value => value + 1);
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof AdminApiError && err.status === 401) unauthorized.current();
      else {
        const definiteRejection = err instanceof AdminApiError && err.status >= 400 && err.status < 500;
        if (definiteRejection) completeRequestId(key, storage());
        setError(`${(err as Error).message}${definiteRejection ? "" : " 提交结果待核对。请刷新任务列表；再次确认将复用同一操作编号。"}`);
        setRefresh(value => value + 1);
      }
    } finally {
      mutationLock.current = false;
      if (mounted.current) setMutation("");
    }
  }

  async function cancelTask(task: FinancialMaintenanceTask) {
    if (mutationLock.current) return;
    mutationLock.current = true; setMutation(task.id); setError("");
    try {
      const result = await adminApi<{ task: FinancialMaintenanceTask }>(`financials/tasks/${task.id}/cancel`, { method: "POST", body: "{}" });
      if (!mounted.current) return;
      setDetail(previous => previous ? { ...previous, tasks: previous.tasks.map(item => item.id === task.id ? result.task : item) } : previous);
      setNotice(result.task.status === "cancelled" ? "任务已取消，已保存的数据保留。" : "已请求取消。已完成的数据保留，正在执行的步骤结束后停止。");
      setRefresh(value => value + 1);
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof AdminApiError && err.status === 401) unauthorized.current();
      else setError((err as Error).message);
    } finally { mutationLock.current = false; if (mounted.current) setMutation(""); }
  }

  const companies = (list?.companies ?? []).filter(company => `${company.ticker} ${company.name}`.toLowerCase().includes(search.toLowerCase()));
  const period = detail?.periods.find(item => item.periodEnd === selectedPeriod);
  const metrics = (period?.metrics ?? []).filter(metric => (!onlyMissing || metric.value === null) && `${metric.id} ${metric.label}`.toLowerCase().includes(metricSearch.toLowerCase()));
  const activeTask = detail?.tasks.some(task => activeStatuses.has(task.status));
  // Manual maintenance is authorized independently of the scheduled collection switch.
  const canExtract = Boolean(list);
  const canAnalyze = list?.environment.aiEnabled && list.environment.workflowAvailable;

  return <div className="fm-workspace">
    {notice && <div className="ra-notice" role="status"><Check size={16} />{notice}<button aria-label="关闭数据通知" onClick={() => setNotice("")}><X size={16} /></button></div>}
    {error && <div className="ra-error ra-error-banner fm-error" role="alert">{error}<button onClick={requestRefresh}>刷新数据与任务</button></div>}
    <section className="fm-toolbar" aria-label="公司维护">
      <label className="ra-search"><Search size={17} /><input aria-label="筛选财报公司" value={search} onChange={event => setSearch(event.target.value)} placeholder="筛选公司" /></label>
      <form className="fm-new-company" onSubmit={addCompany}><label htmlFor="fm-new-ticker" className="sr-only">新公司股票代码</label><input id="fm-new-ticker" value={newTicker} maxLength={10} onChange={event => setNewTicker(event.target.value.toUpperCase())} placeholder="新公司代码，例如 MSFT" autoComplete="off" /><select aria-label="新增公司操作" value={newAction} onChange={event => setNewAction(event.target.value as "extract" | "analyze")}><option value="extract">补全数据</option><option value="analyze" disabled={!canAnalyze}>财报分析{!canAnalyze ? "（当前未启用）" : ""}</option></select><button className="ra-primary" disabled={!!mutation || !newTicker || !list || (newAction === "analyze" && !canAnalyze)}><Plus size={16} />新增公司</button></form>
      <button className="fm-button" onClick={requestRefresh} disabled={!!mutation} aria-label="刷新财报数据"><RefreshCw size={16} />刷新</button>
    </section>
    <div className="fm-columns">
      <aside className="fm-company-list" aria-label="财报公司">
        <div className="fm-list-caption">{list ? `${companies.length} 家公司` : "读取公司列表…"}</div>
        {companies.map(company => <button className="fm-company" key={company.ticker} aria-pressed={ticker === company.ticker} onClick={() => chooseCompany(company.ticker)}><strong>{company.ticker}<small>{company.tracked ? "持续跟踪" : "单次维护"}</small></strong><span>{company.name || company.ticker}</span><small>最近期间 {company.latestPeriodEnd || "待提取"}</small></button>)}
        {list && !companies.length && <p className="fm-muted">{search ? "没有匹配公司。" : "暂无已提取公司，可新增公司分析。"}</p>}
      </aside>
      <div className="fm-detail" aria-busy={loading}>
        {loading && !detail ? <div className="ra-empty" role="status"><LoaderCircle className="ra-spin" />正在读取财报数据</div> : detail ? <>
          <header className="fm-company-header"><div><h2>{detail.company.name || ticker}<span>{ticker}</span></h2><p>最近更新 {date(detail.company.lastUpdatedAt)}</p></div><div className="fm-actions"><button className="fm-button" disabled={!!mutation || activeTask || !canExtract} onClick={() => setOperation({ ticker, action: "extract" })}><Database size={16} />补全数据</button><button className="ra-primary" disabled={!!mutation || activeTask || !canAnalyze} onClick={() => setOperation({ ticker, action: "analyze" })}><FileSearch size={16} />分析公司</button></div></header>
          {list && (!list.environment.dataCollectionEnabled || !canAnalyze) && <p className="fm-boundary">{!list.environment.dataCollectionEnabled && "定时收集未启用，可手动补全数据。 "}{!canAnalyze && "当前环境未启用 AI 分析。"}已有数据仍可检查。</p>}
          <FinancialStatementsInspector key={`statements:${ticker}`} ticker={ticker} documents={detail.documents} onUnauthorized={onUnauthorized} />
          <h3>季度核心指标摘要（不是完整报表）</h3>
          <div className="fm-periods" aria-label="财报期间">{detail.periods.map(item => <button key={item.periodEnd} aria-pressed={item.periodEnd === selectedPeriod} onClick={() => { setSelectedPeriod(item.periodEnd); setMetricSearch(""); }}><strong>{item.fiscalLabel || item.periodEnd}</strong><span>{item.periodEnd}</span><small data-coverage={item.status}>{item.status === "complete" ? "清单已覆盖" : item.status === "partial" ? "部分缺失" : "尚无数据"}</small></button>)}</div>
          {period ? <section className="fm-metrics" aria-labelledby="fm-metrics-title"><div className="fm-section-heading"><div><h3 id="fm-metrics-title">指标与来源</h3><p>{period.periodStart ? `${period.periodStart} — ${period.periodEnd}` : `期末 ${period.periodEnd} · 起点待确认`} · {period.status === "missing" || !period.metrics.length ? "该期尚无结构化数据" : `已提取 ${period.metrics.filter(metric => metric.value !== null).length} / ${period.metrics.length} 项清单指标`}</p></div><label className="fm-checkbox"><input type="checkbox" checked={onlyMissing} onChange={event => setOnlyMissing(event.target.checked)} />只看缺失</label></div>
            {period.issues.length > 0 && <div className="fm-boundary"><strong>待核对</strong><ul>{period.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}
            <label className="ra-search fm-metric-search"><Search size={15} /><input aria-label="搜索财报指标" value={metricSearch} onChange={event => setMetricSearch(event.target.value)} placeholder="搜索指标名称或原始标签" /></label>
            <div className="fm-table-scroll" tabIndex={0} aria-label="财报指标表，可横向滚动"><table><thead><tr><th>指标</th><th>披露数值</th><th>单位 / 口径</th><th>来源 / 缺失原因</th></tr></thead><tbody>{metrics.map(metric => {
              const source = safeEvidenceUrl(metric.sourceUrl);
              return <tr key={metric.id} data-missing={metric.value === null}><th scope="row">{metric.label}<small>{metric.id}</small></th><td className="fm-value">{displayFinancialValue(metric.value)}</td><td>{metric.unit || "未说明"}{metric.scale !== 1 && ` × ${displayFinancialValue(String(metric.scale))}`}<small>{metric.value === null ? "口径待确认" : basisLabels[metric.basis] ?? metric.basis}</small>{metric.formula && <small>公式：{metric.formula}</small>}</td><td>{metric.value === null && <span className="fm-missing">{metric.missingReason || "当前来源未提取到此项，不代表数值为 0。"}</span>}{source && <a href={source} target="_blank" rel="noopener noreferrer">查看原文 <ExternalLink size={12} /></a>}{metric.sourceAccession && <small>{metric.sourceAccession}</small>}{!source && metric.value !== null && <span className="fm-missing">原文链接待补全</span>}</td></tr>;
            })}</tbody></table>{!metrics.length && <p className="fm-muted fm-table-empty">{period.status === "missing" || !period.metrics.length ? "该期尚无结构化数据，不能视为完整覆盖。请补全后重新核对。" : onlyMissing ? "当前筛选没有缺失指标。" : "当前筛选没有指标。"}</p>}</div>
          </section> : <div className="ra-empty"><Database size={28} /><h3>尚无可展示的财报期间</h3><p>补全任务将查询该公司的 SEC 财报和可用结构化数据。</p></div>}
          <details className="fm-coverage" open><summary>提取覆盖与能力边界</summary><div><h4>当前提取清单</h4><ul>{detail.coverage.scope.map(scope => <li key={scope}>{scope}</li>)}</ul><h4>仍需核对的内容</h4><ul>{detail.coverage.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></div></details>
          <DisclosureInspector key={`disclosures:${ticker}`} ticker={ticker} documents={detail.documents} onUnauthorized={() => unauthorized.current()} />
          <section className="fm-tasks" aria-labelledby="fm-tasks-title"><div className="fm-section-heading"><div><h3 id="fm-tasks-title">维护任务</h3><p>刷新、离开页面不会终止后台任务。{paused ? "自动刷新已暂停。" : "每 10 秒更新状态。"}</p></div><button className="fm-button" onClick={() => setPaused(value => !value)}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? "继续刷新" : "暂停刷新"}</button></div>
            {detail.tasks.length ? <ol>{detail.tasks.map(task => <li key={task.id}><div className="fm-task-top"><strong>{actionLabels[task.action as Action] ?? task.action}</strong><span className="ra-badge" data-status={task.status === "failed" || task.status === "partial" ? "failed" : task.status === "succeeded" ? "reviewed" : "processing"}>{taskLabels[task.status] ?? task.status}</span><div className="fm-task-actions">{task.canRetry && <button className="fm-button" disabled={!!mutation || activeTask} onClick={() => setOperation({ ticker, action: "retry", retryTaskId: task.id })}>重试任务</button>}{task.canCancel && <button className="fm-button" disabled={!!mutation} onClick={() => void cancelTask(task)}>取消任务</button>}</div></div><p>{stageLabels[task.stage] ?? task.stage} · {task.progress.completed} / {task.progress.total} 项 · 更新于 {date(task.updatedAt)}</p>{task.stage === "analysis_wait" && <p>分析工作流已提交，当前不支持取消。暂停刷新只停止页面轮询。</p>}{task.progress.total > 0 && <progress max={task.progress.total} value={task.progress.completed} aria-label={`${actionLabels[task.action as Action] ?? task.action}进度`} />}{task.errorCode && <p className="ra-error">错误代码：{task.errorCode}</p>}{task.issues.length > 0 && <ul className="fm-task-issues">{task.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}<details><summary>任务标识与时间</summary><code>{task.id}</code><p>创建于 {date(task.createdAt)}{task.completedAt && ` · 完成于 ${date(task.completedAt)}`}</p></details></li>)}</ol> : <p className="fm-muted">暂无维护任务。</p>}
          </section>
        </> : <div className="ra-empty"><Database size={28} /><h3>{error ? "财报数据暂时不可用" : "选择公司查看财报数据"}</h3><p>{error ? "可刷新重试；未载入的数据不会显示为空值。" : "也可在上方输入代码，新增一次公司分析。"}</p></div>}
      </div>
    </div>
    <dialog ref={dialog} className="ra-dialog" onCancel={event => { if (mutation) event.preventDefault(); else setOperation(null); }} onClose={() => { if (!mutation) setOperation(null); }} aria-labelledby="fm-confirm-title"><h2 id="fm-confirm-title">{operation && actionLabels[operation.action]} · {operation?.ticker}</h2><p>{operation?.action === "extract" ? "将重新检查原始财报并补全可提取数据，保留来源与任务记录。不会把未披露的指标写成 0。" : operation?.action === "retry" ? "将重试这次未完成的任务，已保存的数据保留。" : "将为这家公司收集财报并触发可用的分析流程。新增公司只执行本次维护，不自动加入持续跟踪名单。"}</p><p>任务在后台执行，可在下方查看进度及错误。</p>{error && <p className="ra-error" role="alert">{error}</p>}<div className="ra-dialog-actions"><button disabled={!!mutation} onClick={() => setOperation(null)}>取消</button><button className="ra-primary" disabled={!!mutation} onClick={() => void performOperation()}>{mutation && <LoaderCircle className="ra-spin" size={15} />}{mutation ? "正在提交…" : "确认提交"}</button></div></dialog>
  </div>;
}
