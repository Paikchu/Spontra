import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { MANUAL_PIPELINE_EVENTS, type ManualPipelineEvent, type PipelineLogEntry, type PipelineOverview, type PipelineTrail } from "@/shared/analysis-contract/pipeline-admin";
import { adminApi, AdminApiError } from "./admin-api";
import "./ai-runs.css";
import "./pipeline.css";

const NAMES: Record<string, string> = {
  "collect": "财报采集", "history": "历史营收", "reproject": "重算资本结构", "maintenance": "财务维护", "transcript": "电话会文字稿",
  "map-derive": "地图快照", "archive-prune": "清理替换的存档", "archive-prune-scan": "全量清理存档",
  "sec-report": "SEC 财报分析", "guidance": "业绩指引", "events": "事件与内幕交易",
  "memory": "财报记忆", "company-analysis": "公司分析", "explainer": "业务解读", "tree": "业务脑图", "findings": "要点",
  "filing.discovered": "发现新申报", "collection.requested": "请求采集", "maintenance.requested": "维护任务更新",
  "financials.published": "财报发布", "filing.archived": "文件归档", "archive.superseded": "存档被替换", "archive.prune.requested": "请求全量清理",
  "map.derived": "地图快照完成", "filings.indexed": "申报列表更新", "report.published": "报告发布", "analysis.published": "公司分析发布",
  "fundamentals.updated": "SEC 基本面更新", "guidance.published": "指引发布", "task.version_changed": "任务版本变化",
  "transcript.stored": "文字稿入库", "explainer.published": "业务解读发布", "tree.published": "业务脑图发布", "findings.published": "要点发布", "events.published": "事件更新",
};
const OUTCOMES: Record<string, string> = { done: "完成", later: "稍后继续", failed: "失败", superseded: "已被更新的触发取代", deferred: "延后" };
const name = (value: string | null) => value ? NAMES[value] ?? value : "—";
const outcome = (value: string) => value.startsWith("routed:") ? `分发给 ${value.slice(7)} 个任务` : OUTCOMES[value] ?? value;
const date = (value?: string | null) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—";

export function Pipeline({ onUnauthorized, onAuthenticated }: { onUnauthorized: () => void; onAuthenticated: () => void }) {
  const [data, setData] = useState<PipelineOverview | null>(null), [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const [ticker, setTicker] = useState(""), [trail, setTrail] = useState<{ id: string; entries: PipelineLogEntry[] } | null>(null);
  const [eventType, setEventType] = useState<ManualPipelineEvent>(MANUAL_PIPELINE_EVENTS[0].type), [eventTicker, setEventTicker] = useState("");
  const [busy, setBusy] = useState(""), [notice, setNotice] = useState("");
  const callbacks = useRef({ onUnauthorized, onAuthenticated });
  useEffect(() => { callbacks.current = { onUnauthorized, onAuthenticated }; }, [onUnauthorized, onAuthenticated]);
  const fail = (e: unknown) => { if (e instanceof AdminApiError && e.status === 401) callbacks.current.onUnauthorized(); else setError((e as Error).message); };

  useEffect(() => {
    const c = new AbortController();
    void adminApi<PipelineOverview>(`pipeline${ticker ? `?${new URLSearchParams({ ticker })}` : ""}`, { signal: c.signal })
      .then(r => { setData(r); setError(""); callbacks.current.onAuthenticated(); setEventTicker(t => t || r.companies[0] || ""); })
      .catch(e => { if (!c.signal.aborted) fail(e); });
    return () => c.abort();
  }, [ticker, refresh]);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) setRefresh(n => n + 1); }, 15000);
    return () => clearInterval(timer);
  }, []);

  async function act(key: string, path: string, body?: unknown, done?: string) {
    setBusy(key); setNotice(""); setError("");
    try { await adminApi(path, { method: "POST", body: JSON.stringify(body ?? {}) }); setNotice(done ?? "已提交。"); setRefresh(n => n + 1); }
    catch (e) { fail(e); } finally { setBusy(""); }
  }
  async function openTrail(entry: PipelineLogEntry) {
    if (trail?.id === entry.messageId) { setTrail(null); return; }
    try { const r = await adminApi<PipelineTrail>(`pipeline/trail/${entry.messageId}`); setTrail({ id: entry.messageId, entries: r.entries }); }
    catch (e) { fail(e); }
  }
  const manual = MANUAL_PIPELINE_EVENTS.find(e => e.type === eventType)!;

  if (!data) return <div className="pl-page">{error ? <p className="ra-error" role="alert">{error}</p> : <p className="ai-empty" role="status"><LoaderCircle size={15} className="ra-spin" /> 正在读取…</p>}</div>;
  return <div className="pl-page">
    <div className="pl-stats">
      <div data-alert={data.discoveryStale || undefined}><span>SEC 申报发现</span><strong>{data.discoveryAt ? date(data.discoveryAt) : "尚未运行"}</strong>{data.discoveryStale && <small>超过 30 分钟未成功</small>}</div>
      <div data-alert={data.outbox.stale || undefined}><span>待发事件</span><strong>{data.outbox.pending}</strong>{data.outbox.oldestAt && <small>最早 {date(data.outbox.oldestAt)}</small>}</div>
      <div><span>待执行任务</span><strong>{data.due.length}</strong></div>
      <div data-alert={data.dead.length > 0 || undefined}><span>死信</span><strong>{data.dead.length}</strong></div>
      <button aria-label="刷新" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={15} /></button>
    </div>
    {error && <p className="ra-error" role="alert">{error}</p>}
    {notice && <p className="pl-notice" role="status">{notice}</p>}

    <section className="pl-section" aria-labelledby="pl-manual"><h3 id="pl-manual">手动发送事件</h3>
      <div className="ai-trigger">
        <label>事件<select value={eventType} onChange={e => setEventType(e.target.value as ManualPipelineEvent)}>{MANUAL_PIPELINE_EVENTS.map(e => <option key={e.type} value={e.type}>{e.label}</option>)}</select></label>
        {manual.scope === "company" && <label>公司<select value={eventTicker} onChange={e => setEventTicker(e.target.value)}>{data.companies.map(t => <option key={t}>{t}</option>)}</select></label>}
        <button className="ra-primary" disabled={!!busy} onClick={() => void act("manual", "pipeline/events", { type: eventType, ticker: eventTicker }, "事件已发送，任务将在去抖时间后执行。")}>{busy === "manual" ? "发送中…" : "发送"}</button>
      </div>
    </section>

    <section className="pl-section" aria-labelledby="pl-dead"><h3 id="pl-dead">死信</h3>
      {!data.dead.length ? <p className="ai-muted">没有死信。</p> : <div className="ai-table-wrap"><table className="ai-table"><thead><tr><th>时间</th><th>类型</th><th>公司</th><th>重试</th><th>操作</th></tr></thead><tbody>
        {data.dead.map(d => <tr key={d.id}><td>{date(d.createdAt)}</td><td>{name(d.name)}<small>{d.kind === "task" ? "任务" : "事件"}</small></td><td>{d.ticker ?? "—"}</td><td>{d.attempts}</td>
          <td className="pl-actions"><button className="ra-text-button" disabled={!!busy} onClick={() => void act(d.id, `pipeline/dead/${d.id}/replay`, undefined, "已重新投递。")}>重放</button><button className="ra-text-button" disabled={!!busy} onClick={() => void act(d.id, `pipeline/dead/${d.id}/dismiss`, undefined, "已关闭。")}>关闭</button></td></tr>)}
      </tbody></table></div>}
    </section>

    <section className="pl-section" aria-labelledby="pl-due"><h3 id="pl-due">待执行任务</h3>
      {!data.due.length ? <p className="ai-muted">没有待执行的任务。</p> : <div className="ai-table-wrap"><table className="ai-table"><thead><tr><th>任务</th><th>公司</th><th>执行时间</th><th>首次触发</th></tr></thead><tbody>
        {data.due.map(d => <tr key={`${d.ticker}:${d.task}`}><td>{name(d.task)}</td><td>{d.ticker === "*" ? "全部" : d.ticker}</td><td>{date(d.dueAt)}</td><td>{date(d.firstRequestedAt)}</td></tr>)}
      </tbody></table></div>}
    </section>

    <section className="pl-section" aria-labelledby="pl-log"><div className="ai-versions-head"><h3 id="pl-log">最近记录</h3>
      <label>公司<select value={ticker} onChange={e => setTicker(e.target.value)}><option value="">全部</option>{data.companies.map(t => <option key={t}>{t}</option>)}</select></label></div>
      <p className="ai-hint">点击一行查看它的触发链：从这条记录一路追溯到最初的事件。</p>
      {!data.log.length ? <p className="ai-muted">暂无记录。</p> : <div className="ai-table-wrap"><table className="ai-table pl-log"><thead><tr><th>时间</th><th>类型</th><th>公司</th><th>结果</th></tr></thead><tbody>
        {data.log.map(entry => <FragmentRow key={entry.id} entry={entry} open={trail?.id === entry.messageId} trail={trail?.id === entry.messageId ? trail.entries : null} onToggle={() => void openTrail(entry)} />)}
      </tbody></table></div>}
    </section>

    <section className="pl-section" aria-labelledby="pl-versions"><h3 id="pl-versions">任务版本</h3>
      <p className="ai-hint">版本变化后，新代码第一次运行时会对该任务覆盖的所有公司重跑一次。{data.versions.deployedAt ? `当前记录来自 ${date(data.versions.deployedAt)} 的部署。` : ""}</p>
      <div className="ai-table-wrap"><table className="ai-table"><thead><tr><th>任务</th><th>代码中的版本</th><th>已生效</th></tr></thead><tbody>
        {Object.entries(data.versions.current).map(([task, version]) => <tr key={task}><td>{name(task)}</td><td><code>{version}</code></td><td>{data.versions.announced?.[task] === version ? "是" : "等待下一次调用"}</td></tr>)}
      </tbody></table></div>
    </section>
  </div>;
}

function FragmentRow({ entry, open, trail, onToggle }: { entry: PipelineLogEntry; open: boolean; trail: PipelineLogEntry[] | null; onToggle: () => void }) {
  return <>
    <tr className="pl-row" aria-expanded={open} tabIndex={0} onClick={onToggle} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
      <td>{date(entry.createdAt)}</td><td>{name(entry.name)}<small>{entry.kind === "task" ? "任务" : "事件"}</small></td><td>{entry.ticker === "*" ? "全部" : entry.ticker}</td>
      <td data-outcome={entry.outcome}>{outcome(entry.outcome)}{entry.detail && <small className="pl-detail">{entry.detail}</small>}</td>
    </tr>
    {open && trail && <tr className="pl-trail"><td colSpan={4}><ol>{trail.map(t => <li key={t.id}><time>{date(t.createdAt)}</time>{name(t.name)} · {t.ticker === "*" ? "全部" : t.ticker} · {outcome(t.outcome)}</li>)}</ol>
      {trail.length && trail[trail.length - 1]!.causeId ? <small>更早的记录已超过保留期。</small> : null}</td></tr>}
  </>;
}
