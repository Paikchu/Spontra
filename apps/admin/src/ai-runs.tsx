import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw, Search } from "lucide-react";
import type { AiCompanies, AiCompanyDetail, AiRun, AiRunKind, AiRunStarted, AiRunStatus, AiVersionDetail } from "@/shared/analysis-contract/ai-runs-admin";
import type { AnalysisFinding, FindingsPublication } from "@/shared/analysis-contract/findings";
import type { BusinessExplainer } from "@/shared/analysis-contract/business-explainer";
import type { BusinessTree, TreeNode } from "@/shared/analysis-contract/business-tree";
import { adminApi, AdminApiError } from "./admin-api";
import { CompanyLogo } from "@/packages/web/src/company-logo";
import { completeRequestId, pendingRequestId } from "./financial-maintenance-state";
import "./ai-runs.css";

/** The BusinessView outputs this admin shows; guidance is not part of BusinessView. */
export type ViewKind = Exclude<AiRunKind, "guidance">;
const KINDS: Array<[ViewKind, string]> = [["findings", "公司要点"], ["explainer", "业务解读"], ["tree", "业务脑图"]];
const STATUS: Record<AiRunStatus, string> = { queued: "排队中", running: "运行中", waiting: "等待中", succeeded: "已完成", empty: "无可发布内容", superseded: "已跳过", failed: "失败" };
const ACTIVE = new Set<AiRunStatus>(["queued", "running", "waiting"]);
const badge = (status: AiRunStatus) => status === "failed" ? "failed" : status === "succeeded" ? "reviewed" : ACTIVE.has(status) ? "processing" : "";
const STAGES: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^(findings|explainer|tree)-time$/, () => "记录开始时间"],
  [/^tree-input$/, () => "读取业务列表"],
  [/^tree-filings$/, () => "列出财报与年报"],
  [/^tree-b(\d+)-t(\d+)-think$/, m => `第 ${m[1]} 项业务 · 第 ${m[2]} 轮思考`],
  [/^tree-b(\d+)-t(\d+)-search$/, m => `第 ${m[1]} 项业务 · 第 ${m[2]} 轮搜索`],
  [/^tree-b(\d+)-t(\d+)-read$/, m => `第 ${m[1]} 项业务 · 第 ${m[2]} 轮读取网页`],
  [/^tree-b(\d+)-review/, m => `第 ${m[1]} 项业务 · 审校`],
  [/^tree-publish$/, () => "发布"],
  [/^findings-input$/, () => "读取财报、指引与公司综述"],
  [/^findings-write$/, () => "撰写要点"],
  [/^findings-repair$/, () => "修正未通过项"],
  [/^findings-publish$/, () => "核对并发布"],
  [/^explainer-input$/, () => "读取业务列表"],
  [/^explainer-evidence-filing$/, () => "读取财报原文"],
  [/^explainer-evidence-(\d+)$/, m => `检索资料 · 第 ${Number(m[1]) + 1} 组`],
  [/^explainer-plan-(\d+)$/, m => `规划补充检索 · 第 ${Number(m[1]) + 1} 组`],
  [/^explainer-follow-up-(\d+)$/, m => `补充检索 · 第 ${Number(m[1]) + 1} 组`],
  [/^explainer-write-(\d+)$/, m => `撰写业务解读 · 第 ${Number(m[1]) + 1} 组`],
  [/^explainer-review-(\d+)$/, m => `审校 · 第 ${Number(m[1]) + 1} 组`],
  [/^explainer-publish$/, () => "发布"],
];
function stageLabel(stage: string | null | undefined) {
  if (!stage) return "待开始";
  for (const [pattern, label] of STAGES) { const m = pattern.exec(stage); if (m) return label(m); }
  return stage;
}
const date = (value?: string | null) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—";
function elapsed(run: AiRun) {
  const seconds = Math.max(0, Math.round((Date.parse(run.finishedAt ?? run.updatedAt) - Date.parse(run.startedAt)) / 1000));
  return seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.round(seconds / 60)} 分钟` : `${(seconds / 3600).toFixed(1)} 小时`;
}
function storage() { try { return window.sessionStorage; } catch { return undefined; } }
function initial(name: "ticker" | "kind") { try { return new URLSearchParams(window.location.search).get(name) ?? ""; } catch { return ""; } }

/** Companies on the left, the chosen kinds of one company on the right. The page keeps `?ticker=&kind=` in its URL. */
export function AiRuns({ onUnauthorized, onAuthenticated, kinds }: { onUnauthorized: () => void; onAuthenticated: () => void; kinds: ViewKind[] }) {
  const tabs = KINDS.filter(([k]) => kinds.includes(k));
  const [list, setList] = useState<AiCompanies | null>(null), [search, setSearch] = useState(""), [listError, setListError] = useState("");
  const [ticker, setTicker] = useState(initial("ticker")), [kind, setKind] = useState<ViewKind>(() => tabs.find(([k]) => k === initial("kind"))?.[0] ?? tabs[0]![0]);
  const [refresh, setRefresh] = useState(0);
  const callbacks = useRef({ onUnauthorized, onAuthenticated });
  useEffect(() => { callbacks.current = { onUnauthorized, onAuthenticated }; }, [onUnauthorized, onAuthenticated]);

  useEffect(() => {
    const c = new AbortController();
    void adminApi<AiCompanies>("ai/companies", { signal: c.signal }).then(r => { setList(r); setListError(""); callbacks.current.onAuthenticated(); setTicker(t => r.companies.some(x => x.ticker === t) ? t : r.companies[0]?.ticker ?? ""); })
      .catch(e => { if (c.signal.aborted) return; if (e instanceof AdminApiError && e.status === 401) callbacks.current.onUnauthorized(); else setListError((e as Error).message); });
    return () => c.abort();
  }, [refresh]);
  useEffect(() => { const timer = setInterval(() => { if (!document.hidden) setRefresh(n => n + 1); }, 20000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!ticker) return;
    try { window.history.replaceState(null, "", `${window.location.pathname}?${new URLSearchParams(tabs.length > 1 ? { ticker, kind } : { ticker })}`); } catch { /* Sandboxed preview. */ }
  }, [ticker, kind, tabs.length]);

  const companies = list?.companies.filter(c => c.ticker.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <div className="ra-workspace ai-workspace">
    <section className="ra-list" aria-label="公司">
      <div className="ra-filters"><label className="ra-search"><Search size={17} /><input aria-label="搜索公司" placeholder="代码" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
      <div className="ra-list-caption"><span>{list ? `${list.companies.length} 家公司` : "加载中"}</span><button aria-label="刷新" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={14} /></button></div>
      {listError && <p className="ra-error" role="alert">{listError}</p>}
      <div className="ra-list-scroll">{companies.map(c => <button key={c.ticker} className="ra-report-row" aria-pressed={ticker === c.ticker} onClick={() => setTicker(c.ticker)}>
        <CompanyLogo symbol={c.ticker} /><span className="ra-row-info"><strong>{c.ticker}</strong>{tabs.map(([k]) => { const run = c.kinds[k].latestRun, note = run && ACTIVE.has(run.status) ? "生成中" : run?.status === "failed" ? "上次生成失败" : c.kinds[k].current ? "" : "尚未生成"; return note && <small key={k} data-note={run?.status === "failed" || undefined}>{note}</small>; })}
        </span></button>)}
        {list && !companies.length && <p className="ai-empty">无匹配公司</p>}
      </div>
    </section>
    <section className="ra-detail ai-detail" aria-label="生成详情">
      {tabs.length > 1 && <div className="ra-tabbar"><div role="tablist" aria-label="生成内容">{tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>{label}</button>)}</div></div>}
      {!ticker ? <p className="ai-empty">未选择公司</p> : <AiKindPanel key={`${ticker}:${kind}`} ticker={ticker} kind={kind} onUnauthorized={onUnauthorized} />}
    </section>
  </div>;
}

/** One company's runs and published versions of one kind, polled faster while a run is in progress. */
export function AiKindPanel({ ticker, kind, onUnauthorized }: { ticker: string; kind: ViewKind; onUnauthorized: () => void }) {
  const [detail, setDetail] = useState<AiCompanyDetail | null>(null), [error, setError] = useState<{ message: string; missing: boolean } | null>(null), [refresh, setRefresh] = useState(0);
  const unauthorized = useRef(onUnauthorized);
  useEffect(() => { unauthorized.current = onUnauthorized; }, [onUnauthorized]);
  const fail = (e: unknown) => { if (e instanceof AdminApiError && e.status === 401) unauthorized.current(); else setError({ message: (e as Error).message, missing: e instanceof AdminApiError && e.status === 404 }); };
  useEffect(() => {
    const c = new AbortController();
    void adminApi<AiCompanyDetail>(`ai/companies/${ticker}/${kind}`, { signal: c.signal }).then(r => { setDetail(r); setError(null); }).catch(e => { if (!c.signal.aborted) fail(e); });
    return () => c.abort();
  }, [ticker, kind, refresh]);
  const active = !!detail?.runs.some(r => ACTIVE.has(r.status));
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) setRefresh(n => n + 1); }, active ? 4000 : 20000);
    return () => clearInterval(timer);
  }, [active]);
  if (error) return error.missing ? <p className="ai-empty">{error.message}</p> : <p className="ra-error ai-pad" role="alert">{error.message}</p>;
  if (!detail) return <p className="ai-empty" role="status"><LoaderCircle size={15} className="ra-spin" /> 加载中</p>;
  return <KindDetail detail={detail} onChanged={() => setRefresh(n => n + 1)} onError={fail} />;
}

function KindDetail({ detail, onChanged, onError }: { detail: AiCompanyDetail; onChanged: () => void; onError: (error: unknown) => void }) {
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const label = KINDS.find(([k]) => k === detail.kind)![1];
  const running = detail.runs.find(r => ACTIVE.has(r.status));
  async function start() {
    const key = `ai:${detail.kind}:${detail.ticker}:`, requestId = pendingRequestId(key, storage());
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await adminApi<AiRunStarted>(`ai/companies/${detail.ticker}/${detail.kind}/runs`, { method: "POST", body: JSON.stringify({ requestId }) });
      completeRequestId(key, storage()); setConfirming(false);
      setNotice(r.reused ? "任务已存在" : "已提交");
      onChanged();
    } catch (e) {
      if (e instanceof AdminApiError && e.status === 401) onError(e); else setError((e as Error).message);
      if (e instanceof AdminApiError && e.status >= 400 && e.status < 500) completeRequestId(key, storage());
    } finally { setBusy(false); }
  }
  return <div className="ai-pad">
    <header className="ai-head">
      <div><h2>{detail.ticker} · {label}</h2>
        <p>{detail.state.current ? `当前版本 ${date(detail.state.current.id)} · ${summaryText(detail.kind, detail.state.current.summary)}` : "未发布"}{" · "}{detail.state.automatic ? "自动生成已开启" : "自动生成未开启"}</p></div>
      <div className="ai-trigger">
        {!confirming ? <button className="ra-primary" disabled={!!detail.state.blocked || !!running || busy} onClick={() => setConfirming(true)} title={detail.state.blocked ?? undefined}><RefreshCw size={15} />{running ? "运行中" : "重新生成"}</button>
          : <span className="ai-confirm"><button className="ra-primary" disabled={busy} onClick={() => void start()}>{busy && <LoaderCircle size={15} className="ra-spin" />}确认生成</button><button className="fm-button" disabled={busy} onClick={() => setConfirming(false)}>取消</button></span>}
      </div>
    </header>
    {detail.state.blocked && <p className="ai-hint">{detail.state.blocked}</p>}
    {notice && <p className="ra-notice" role="status">{notice}</p>}{error && <p className="ra-error" role="alert">{error}</p>}
    <h3>运行记录</h3>
    {!detail.runs.length ? <p className="ai-muted">无运行记录</p> : <ol className="ai-runs">{detail.runs.map((run, i) => <RunItem key={run.runId} run={run} open={i === 0} />)}</ol>}
    <Versions detail={detail} onError={onError} />
  </div>;
}

function summaryText(kind: AiRunKind, s: { items: number; sources: number; periodEnd: string | null }) {
  return `${s.items} ${kind === "findings" ? "条要点" : "项业务"} · ${s.sources} 个来源${s.periodEnd ? ` · 报告期 ${s.periodEnd}` : ""}`;
}

function RunItem({ run, open }: { run: AiRun; open: boolean }) {
  const result = run.result as { findings?: number; businesses?: number; nodes?: number; withheld?: Array<{ id: string; reasons: string[] }> } | null;
  return <li><details open={open}>
    <summary><span className="ra-badge" data-status={badge(run.status)}>{STATUS[run.status]}</span><strong>{ACTIVE.has(run.status) ? stageLabel(run.stage) : date(run.startedAt)}</strong>
      <small>{run.trigger === "manual" ? "手动" : "自动"} · 开始 {date(run.startedAt)} · 用时 {elapsed(run)}</small></summary>
    {run.error && <p className="ra-error">{run.error}</p>}
    {result && <p className="ai-result">{[
      result.findings !== undefined && `发布 ${result.findings} 条要点`, result.businesses !== undefined && `${result.businesses} 项业务`, result.nodes !== undefined && `${result.nodes} 个节点`,
      result.withheld?.length ? `${result.withheld.length} 条未通过核对` : null,
    ].filter(Boolean).join(" · ")}</p>}
    {!!result?.withheld?.length && <ul className="ai-withheld">{result.withheld.map(w => <li key={w.id}><code>{w.id}</code>{w.reasons.join("；")}</li>)}</ul>}
    {run.log.length > 0 && <ol className="ai-steps">{run.log.map((s, i) => <li key={i} data-current={ACTIVE.has(run.status) && i === run.log.length - 1 || undefined}><time>{date(s.at)}</time>{stageLabel(s.stage)}{s.attempt ? ` · 第 ${s.attempt} 次尝试` : ""}</li>)}</ol>}
    <small className="ai-id">{run.runId}</small>
  </details></li>;
}

function Versions({ detail, onError }: { detail: AiCompanyDetail; onError: (error: unknown) => void }) {
  const [chosen, setId] = useState(""), [version, setVersion] = useState<AiVersionDetail | null>(null), [error, setError] = useState("");
  // A newly published version becomes the default; a version the operator picked stays selected while it exists.
  const id = detail.versions.some(v => v.id === chosen) ? chosen : detail.versions[0]?.id ?? "";
  useEffect(() => {
    if (!id) return;
    const c = new AbortController();
    void adminApi<AiVersionDetail>(`ai/companies/${detail.ticker}/${detail.kind}/versions/${encodeURIComponent(id)}`, { signal: c.signal }).then(r => { setVersion(r); setError(""); })
      .catch(e => { if (c.signal.aborted) return; if (e instanceof AdminApiError && e.status === 401) onError(e); else setError((e as Error).message); });
    return () => c.abort();
  }, [detail.ticker, detail.kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  return <section className="ai-versions">
    <div className="ai-versions-head"><h3>生成结果</h3>{detail.versions.length > 0 && <label>版本<select value={id} onChange={e => setId(e.target.value)}>{detail.versions.map((v, i) => <option key={v.id} value={v.id}>{v.current ? "当前 · " : `v${detail.versions.length - i} · `}{date(v.id)} · {summaryText(detail.kind, v.summary)}</option>)}</select></label>}</div>
    {!detail.versions.length ? <p className="ai-muted">无已发布结果</p> : error ? <p className="ra-error">{error}</p> : !version || version.version.id !== id ? <p className="ai-muted"><LoaderCircle size={15} className="ra-spin" /> 加载中</p>
      : <>{!version.version.current && <p className="ai-hint">历史版本</p>}
        {detail.kind === "findings" ? <FindingsView publication={version.publication as FindingsPublication} /> : detail.kind === "explainer" ? <ExplainerView explainer={version.publication as BusinessExplainer} /> : <TreeView tree={version.publication as BusinessTree} />}
        <details className="ai-raw"><summary>原始 JSON</summary><pre>{JSON.stringify(version.publication, null, 2)}</pre></details></>}
  </section>;
}

const FINDING_KIND: Record<AnalysisFinding["kind"], string> = { risk: "风险", strength: "优势", shift: "变化", watch: "关注" };
function FindingsView({ publication }: { publication: FindingsPublication }) {
  return <div className="ai-cards"><p className="ai-muted">报告期 {publication.periodEnd} · 模型 {publication.model}</p>{publication.findings.map(f => <article key={f.id} className="ai-card" data-kind={f.kind}>
    <header><span className="ra-badge" data-status={f.kind === "risk" ? "caution" : f.kind === "strength" ? "reviewed" : "processing"}>{FINDING_KIND[f.kind]}</span><span className="ai-severity">{"●".repeat(f.severity)}{"○".repeat(3 - f.severity)}</span><strong>{f.title}</strong></header>
    <p>{f.judgment.text}</p>
    <small>{f.evidence.length} 项证据{f.pairWith ? ` · 对照 ${f.pairWith}` : ""} · 视图 {f.anchors.view}{f.watch ? ` · 下期验证：${f.watch.condition}` : ""}</small>
  </article>)}</div>;
}
function ExplainerView({ explainer }: { explainer: BusinessExplainer }) {
  return <div className="ai-cards"><p className="ai-muted">模型 {explainer.model} · {explainer.sources.length} 个来源</p>{explainer.businesses.map(b => <article key={b.nodeId} className="ai-card">
    <header><strong>{b.name}</strong><small>{b.nodeId}</small></header>
    {b.summary ? <p>{b.summary.text}</p> : <p className="ai-muted">概述未通过审校</p>}
    {b.products.length > 0 && <small>产品：{b.products.join("、")}</small>}
    {b.sections.map(s => <div key={s.id} className="ai-section"><h4>{s.title}</h4><ul>{s.items.map((item, i) => <li key={i}>{item.label && <strong>{item.label}：</strong>}{item.claim.text}</li>)}</ul></div>)}
  </article>)}</div>;
}
/** The breakdown as nested lists, and under each business the agent's turns: thought, action, and what the harness answered. */
function TreeView({ tree }: { tree: BusinessTree }) {
  const sourceTitle = (id: string) => tree.sources.find(s => s.id === id)?.title ?? id;
  const Node = ({ node }: { node: TreeNode }) => <li>
    <strong>{node.name}</strong>{node.gloss && <span className="ai-muted"> · {node.gloss}</span>}{node.flowNodeId && <small> （财报披露）</small>}
    {node.revenue.length > 0 && <div className="ai-tree-revenue">{node.revenue.map((r, i) => <span key={i} title={`${r.text}（${r.sourceIds.map(sourceTitle).join("、")}）`}>¥ {r.label}</span>)}</div>}
    {node.anchor && <small className="ai-tree-anchor" title={node.anchor.sourceIds.map(sourceTitle).join("、")}>“{node.anchor.text}”</small>}
    {node.children.length > 0 && <ul>{node.children.map(c => <Node key={c.id} node={c} />)}</ul>}
  </li>;
  return <div className="ai-cards"><p className="ai-muted">报告期 {tree.periodEnd} · 模型 {tree.model} · {tree.sources.length} 个来源</p>{tree.branches.map(b => {
    const steps = tree.research?.find(r => r.flowNodeId === b.flowNodeId)?.steps ?? [];
    return <article key={b.flowNodeId} className="ai-card">
      <header><strong>{b.name}</strong><small>{b.flowNodeId}</small></header>
      {b.summary && <p>{b.summary.text}</p>}
      <ul className="ai-tree">{b.children.map(c => <Node key={c.id} node={c} />)}</ul>
      {steps.length > 0 && <details className="ai-raw"><summary>研究过程 · {steps.length} 轮</summary><ol className="ai-tree-steps">{steps.map((s, i) => <li key={i}>
        <p><b>{s.action}</b> {s.thought}</p><code>{s.input}</code><pre>{s.observation}</pre>
      </li>)}</ol></details>}
    </article>;
  })}</div>;
}
