import { FinancialStatementsInspector } from "./financial-statements-inspector";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, ChevronDown, Database, FileSearch, History, LoaderCircle, Plus, RefreshCw, Search, X } from "lucide-react";
import type {
  FinancialMaintenanceActionResponse, FinancialMaintenanceCompanyDetail,
  FinancialMaintenanceCompanyList, FinancialMaintenanceTask,
} from "@/shared/analysis-contract/financial-maintenance";
import { adminApi, AdminApiError } from "./admin-api";
import { CompanyLogo } from "@/packages/web/src/company-logo";
import { FinancialQuarterSummary } from "./financial-quarter-summary";
import { FinancialUpdateHistory, financialDate } from "./financial-update-history";
import { completeRequestId, normalizeCompanyTicker, pendingRequestId } from "./financial-maintenance-state";
import { useOnReturn, usePageActive } from "./admin-page";
import "./financial-maintenance.css";

type Action = "extract" | "analyze" | "reread" | "retry";
type Operation = { ticker: string; action: Action; retryTaskId?: string; accessionNumber?: string };
const actionLabels: Record<Action, string> = { extract: "更新财报数据", analyze: "生成财报分析", reread: "重新读取报告", retry: "重试更新" };
type Filing = { accession: string; form: string; filedAt: string; reportDate: string };
/** One entry per filing (a filing archives its primary document and exhibits separately), newest filing first. */
function filingsOf(detail: FinancialMaintenanceCompanyDetail): Filing[] {
  const byAccession = new Map<string, Filing>();
  for (const { source } of detail.documents) if (!byAccession.has(source.accessionNumber)) byAccession.set(source.accessionNumber, { accession: source.accessionNumber, form: source.form, filedAt: source.filedAt, reportDate: source.reportDate });
  return [...byAccession.values()].sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.accession.localeCompare(a.accession));
}
const filingLabel = (filing: Filing) => `${filing.filedAt} · ${filing.form}${filing.reportDate && filing.reportDate !== filing.filedAt ? ` · 期末 ${filing.reportDate}` : ""} · ${filing.accession}`;
const activeStatuses = new Set(["queued", "running", "cancel_requested"]);
const initialTicker = () => typeof window === "undefined" ? "" : normalizeCompanyTicker(new URL(window.location.href).searchParams.get("ticker") ?? "");
function storage(): Storage | undefined { try { return window.sessionStorage; } catch { return undefined; } }

export function FinancialMaintenance({ onUnauthorized, onAuthenticated }: { onUnauthorized: () => void; onAuthenticated: () => void }) {
  const [list, setList] = useState<FinancialMaintenanceCompanyList | null>(null);
  const [ticker, setTicker] = useState(initialTicker);
  const [search, setSearch] = useState("");
  const [newTicker, setNewTicker] = useState("");
  const [newAction, setNewAction] = useState<"extract" | "analyze">("extract");
  const [detail, setDetail] = useState<FinancialMaintenanceCompanyDetail | null>(null);
  const [adding, setAdding] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [listRefresh, setListRefresh] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mutation, setMutation] = useState("");
  const [operation, setOperation] = useState<Operation | null>(null);
  const [rereadAccession, setRereadAccession] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const addDialog = useRef<HTMLDialogElement>(null);
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

  const shown = usePageActive();
  useEffect(() => {
    if (!ticker) return;
    const controller = new AbortController();
    if (shown.current) {
      const url = new URL(window.location.href);
      url.searchParams.set("ticker", ticker);
      window.history.replaceState(null, "", url.pathname + url.search);
    }
    void adminApi<FinancialMaintenanceCompanyDetail>(`financials/companies/${ticker}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setDetail(result);
      setList(previous => previous ? { ...previous, companies: previous.companies.map(company => company.ticker === result.company.ticker ? result.company : company) } : previous);

    }).catch((err: Error) => {
      if (controller.signal.aborted) return;
      if (err instanceof AdminApiError && err.status === 401) unauthorized.current();
      else setError(err.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ticker, refresh, shown]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && shown.current && !mutationLock.current) setRefresh(value => value + 1);
    }, 10_000);
    return () => clearInterval(timer);
  }, [shown]);
  useOnReturn(() => { if (!mutationLock.current) setRefresh(value => value + 1); });
  useEffect(() => { if (operation) dialog.current?.showModal(); else dialog.current?.close(); }, [operation]);
  useEffect(() => { if (adding) addDialog.current?.showModal(); else addDialog.current?.close(); }, [adding]);

  function chooseCompany(value: string) {
    if (value === selectedTicker.current) return;
    selectedTicker.current = value;
    setTicker(value); setLoading(true); setDetail(null); setHistoryOpen(false); setError(""); setNotice(""); setRereadAccession("");
  }
  function addCompany(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeCompanyTicker(newTicker);
    if (!normalized) { setError("股票代码无效"); return; }
    setAdding(false);
    setOperation({ ticker: normalized, action: newAction });
  }
  function requestRefresh() { setError(""); setRefresh(value => value + 1); setListRefresh(value => value + 1); }

  async function performOperation() {
    if (!operation || mutationLock.current) return;
    const current = operation;
    const key = `${current.ticker}:${current.action}:${current.retryTaskId ?? ""}:${current.accessionNumber ?? ""}`;
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
      setNotice(result.reused ? "更新进行中" : "更新已开始");
      setNewTicker(""); setRefresh(value => value + 1); setListRefresh(value => value + 1);
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof AdminApiError && err.status === 401) unauthorized.current();
      else {
        const definiteRejection = err instanceof AdminApiError && err.status >= 400 && err.status < 500;
        if (definiteRejection) completeRequestId(key, storage());
        setError(`${(err as Error).message}${definiteRejection ? "" : " · 状态未确认"}`);
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
      setNotice(result.task.status === "cancelled" ? "已停止" : "停止中");
      setRefresh(value => value + 1);
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof AdminApiError && err.status === 401) unauthorized.current();
      else setError((err as Error).message);
    } finally { mutationLock.current = false; if (mounted.current) setMutation(""); }
  }

  const companies = (list?.companies ?? []).filter(company => `${company.ticker} ${company.name}`.toLowerCase().includes(search.toLowerCase()));
  const activeTask = detail?.tasks.find(task => activeStatuses.has(task.status));
  const canAnalyze = Boolean(list?.environment.aiEnabled && list.environment.workflowAvailable);
  const filings = detail ? filingsOf(detail) : [];
  const rereadFiling = filings.find(filing => filing.accession === rereadAccession) ?? filings[0];
  const operationFiling = operation?.accessionNumber ? filings.find(filing => filing.accession === operation.accessionNumber) : undefined;

  return <div className="fm-workspace">
    <div className="fm-columns">
      <aside className="fm-company-list" aria-label="财报公司">
        <div className="fm-company-search"><label className="ra-search"><Search size={17} /><input aria-label="筛选财报公司" value={search} onChange={event => setSearch(event.target.value)} placeholder="筛选公司" /></label></div>
        <div className="fm-list-caption"><span>{list ? `${companies.length} 家公司` : "加载中"}</span><button className="fm-icon-button" aria-label="刷新" onClick={requestRefresh} disabled={!!mutation}><RefreshCw size={15} /></button></div>
        <div className="fm-company-scroll">
          {companies.map(company => <button className="fm-company" key={company.ticker} aria-pressed={ticker === company.ticker} onClick={() => chooseCompany(company.ticker)}><CompanyLogo symbol={company.ticker} /><span className="fm-company-copy"><strong>{company.ticker}</strong><small>{company.latestPeriodEnd || "暂无数据"}</small></span></button>)}
          {list && !companies.length && <p className="fm-muted">{search ? "无匹配公司" : "无公司"}</p>}
        </div>
        <button className="fm-add-company" onClick={() => setAdding(true)} disabled={!list || !!mutation}><Plus size={17} />添加公司</button>
      </aside>
      <div className="fm-detail" aria-busy={loading}>
        {notice && <div className="ra-notice fm-notice" role="status"><Check size={16} />{notice}<button aria-label="关闭" onClick={() => setNotice("")}><X size={16} /></button></div>}
        {error && <div className="ra-error ra-error-banner" role="alert">{error}<button onClick={requestRefresh}>重新加载</button></div>}
        {loading && !detail ? <div className="ra-empty" role="status"><LoaderCircle className="ra-spin" />加载中</div> : detail ? <>
          <header className="fm-company-header"><div><h2>{detail.company.name || ticker}<span>{ticker}</span></h2><p>{detail.company.lastUpdatedAt ? `最近更新 ${financialDate(detail.company.lastUpdatedAt)}` : "无数据"}</p></div><div className="fm-actions"><button className="ra-primary" disabled={!!mutation || !!activeTask || !list} onClick={() => setOperation({ ticker, action: "extract" })}>{activeTask ? <LoaderCircle className="ra-spin" size={16} /> : <RefreshCw size={16} />}{activeTask ? "更新中" : "更新数据"}</button><button className="fm-button" onClick={() => setHistoryOpen(true)}><History size={16} />更新记录</button></div></header>
          {activeTask && <div className="fm-update-status" role="status"><LoaderCircle className="ra-spin" size={15} /><span>更新中</span><button onClick={() => setHistoryOpen(true)}>查看进度</button></div>}
          <FinancialStatementsInspector key={`statements:${ticker}`} ticker={ticker} documents={detail.documents} onUnauthorized={() => unauthorized.current()} onRequestUpdate={activeTask || mutation ? undefined : () => setOperation({ ticker, action: "extract" })} />
          {filings.length > 0 && <div className="fm-reread"><label htmlFor="fm-reread-filing">重新读取单份报告</label><select id="fm-reread-filing" value={rereadFiling?.accession ?? ""} onChange={event => setRereadAccession(event.target.value)}>{filings.map(filing => <option key={filing.accession} value={filing.accession}>{filingLabel(filing)}</option>)}</select><button className="fm-button" disabled={!!mutation || !!activeTask || !rereadFiling} onClick={() => rereadFiling && setOperation({ ticker, action: "reread", accessionNumber: rereadFiling.accession })}><RefreshCw size={15} />重新读取</button></div>}
          <details className="fm-summary" key={`summary:${ticker}`}><summary><span>季度摘要</span><ChevronDown size={16} /></summary><FinancialQuarterSummary periods={detail.periods} /></details>
          {canAnalyze && <div className="fm-analysis-action"><button className="ra-text-button" disabled={!!mutation || !!activeTask} onClick={() => setOperation({ ticker, action: "analyze" })}><FileSearch size={15} />生成财报分析</button></div>}
          <FinancialUpdateHistory open={historyOpen} onClose={() => setHistoryOpen(false)} tasks={detail.tasks} ticker={ticker} busy={!!mutation} hasActiveTask={!!activeTask} onRetry={task => setOperation({ ticker, action: "retry", retryTaskId: task.id })} onCancel={task => void cancelTask(task)} />
        </> : <div className="ra-empty"><Database size={28} /><h3>{error ? "加载失败" : "未选择公司"}</h3></div>}
      </div>
    </div>
    <dialog ref={addDialog} className="ra-dialog fm-add-dialog" onCancel={() => setAdding(false)} onClose={() => setAdding(false)} aria-labelledby="fm-add-title"><div className="fm-dialog-heading"><h2 id="fm-add-title">添加公司</h2><button className="fm-icon-button" aria-label="关闭" onClick={() => setAdding(false)}><X size={19} /></button></div><form onSubmit={addCompany}><label htmlFor="fm-new-ticker">股票代码</label><input id="fm-new-ticker" value={newTicker} maxLength={10} onChange={event => setNewTicker(event.target.value.toUpperCase())} placeholder="MSFT" autoComplete="off" required />{canAnalyze && <label className="fm-add-action">获取内容<select aria-label="新增公司操作" value={newAction} onChange={event => setNewAction(event.target.value as "extract" | "analyze")}><option value="extract">财报数据</option><option value="analyze">财报数据与分析</option></select></label>}{error && <p role="alert" className="ra-error">{error}</p>}<div className="ra-dialog-actions"><button type="button" onClick={() => setAdding(false)}>取消</button><button className="ra-primary" disabled={!newTicker || !!mutation}>添加</button></div></form></dialog>
    <dialog ref={dialog} className="ra-dialog" onCancel={event => { if (mutation) event.preventDefault(); else setOperation(null); }} onClose={() => { if (!mutation) setOperation(null); }} aria-labelledby="fm-confirm-title"><h2 id="fm-confirm-title">{operation && actionLabels[operation.action]} · {operation?.ticker}？</h2>{operation?.accessionNumber && <p className="fm-confirm-filing">{operationFiling ? filingLabel(operationFiling) : operation.accessionNumber}</p>}{error && <p className="ra-error" role="alert">{error}</p>}<div className="ra-dialog-actions"><button disabled={!!mutation} onClick={() => setOperation(null)}>取消</button><button className="ra-primary" disabled={!!mutation} onClick={() => void performOperation()}>{mutation && <LoaderCircle className="ra-spin" size={15} />}{mutation ? "提交中" : "确认"}</button></div></dialog>
  </div>;
}
