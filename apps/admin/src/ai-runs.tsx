import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw, Search } from "lucide-react";
import type { AiCompanies, AiCompanyDetail, AiRun, AiRunKind, AiRunStarted, AiRunStatus, AiVersionDetail } from "@/shared/analysis-contract/ai-runs-admin";
import type { AnalysisFinding, FindingsPublication } from "@/shared/analysis-contract/findings";
import type { BusinessExplainer } from "@/shared/analysis-contract/business-explainer";
import type { GuidancePublication } from "@/shared/analysis-contract/guidance";
import { adminApi, AdminApiError } from "./admin-api";
import { completeRequestId, pendingRequestId } from "./financial-maintenance-state";
import "./ai-runs.css";

const KINDS: Array<[AiRunKind, string]> = [["findings", "财报发现"], ["explainer", "业务解读"], ["guidance", "业绩指引"], ["metrics", "运营指标"], ["figures", "业务图"]];
const STATUS: Record<AiRunStatus, string> = { queued: "排队中", running: "运行中", waiting: "等待中", succeeded: "已完成", empty: "无可发布内容", superseded: "数据已更新，已跳过", failed: "失败" };
const ACTIVE = new Set<AiRunStatus>(["queued", "running", "waiting"]);
const badge = (status: AiRunStatus) => status === "failed" ? "failed" : status === "succeeded" ? "reviewed" : ACTIVE.has(status) ? "processing" : "";
const STAGES: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^(findings|explainer)-time$|^guidance-time-/, () => "记录开始时间"],
  [/^findings-input$/, () => "读取财报、指引与公司综述"],
  [/^findings-write$/, () => "模型撰写发现"],
  [/^findings-repair$/, () => "修正未通过核对的发现"],
  [/^findings-publish$/, () => "核对并发布"],
  [/^explainer-input$/, () => "读取业务列表"],
  [/^explainer-evidence-filing$/, () => "读取财报原文"],
  [/^explainer-evidence-(\d+)$/, m => `检索资料 · 第 ${Number(m[1]) + 1} 组`],
  [/^explainer-plan-(\d+)$/, m => `规划补充检索 · 第 ${Number(m[1]) + 1} 组`],
  [/^explainer-follow-up-(\d+)$/, m => `补充检索 · 第 ${Number(m[1]) + 1} 组`],
  [/^explainer-write-(\d+)$/, m => `撰写业务解读 · 第 ${Number(m[1]) + 1} 组`],
  [/^explainer-review-(\d+)$/, m => `审校 · 第 ${Number(m[1]) + 1} 组`],
  [/^explainer-publish$/, () => "发布"],
  [/^guidance-context$/, () => "识别财季"],
  [/^guidance-sec$/, () => "读取 SEC 附件"],
  [/^guidance-transcript-wait-(\d+)$/, m => `等待电话会文字稿 · 第 ${m[1]} 次`],
  [/^guidance-transcript-(\d+)$/, m => `获取电话会文字稿 · 第 ${Number(m[1]) + 1} 次`],
  [/^guidance-deck$/, () => "搜索 IR 演示文稿"],
  [/^guidance-extract-/, () => "模型提取指引"],
  [/^guidance-budget-wait/, () => "等待次日模型额度"],
  [/^guidance-publish-/, () => "发布指引"],
  [/^guidance-event-extracted$/, () => "标记已提取"],
  [/^guidance-event-complete$/, () => "记录完成状态"],
];
function stageLabel(stage: string | null | undefined) {
  if (!stage) return "等待开始";
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

export function AiRuns({ onUnauthorized, onAuthenticated }: { onUnauthorized: () => void; onAuthenticated: () => void }) {
  const [list, setList] = useState<AiCompanies | null>(null), [search, setSearch] = useState(""), [listError, setListError] = useState("");
  const [ticker, setTicker] = useState(initial("ticker")), [kind, setKind] = useState<AiRunKind>(() => (KINDS.find(([k]) => k === initial("kind"))?.[0]) ?? "findings");
  const [detail, setDetail] = useState<AiCompanyDetail | null>(null), [detailError, setDetailError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const callbacks = useRef({ onUnauthorized, onAuthenticated });
  useEffect(() => { callbacks.current = { onUnauthorized, onAuthenticated }; }, [onUnauthorized, onAuthenticated]);
  const fail = (error: unknown, set: (message: string) => void) => { if (error instanceof AdminApiError && error.status === 401) callbacks.current.onUnauthorized(); else set((error as Error).message); };

  useEffect(() => {
    const c = new AbortController();
    void adminApi<AiCompanies>("ai/companies", { signal: c.signal }).then(r => { setList(r); setListError(""); callbacks.current.onAuthenticated(); setTicker(t => r.companies.some(x => x.ticker === t) ? t : r.companies[0]?.ticker ?? ""); })
      .catch(e => { if (!c.signal.aborted) fail(e, setListError); });
    return () => c.abort();
  }, [refresh]);
  useEffect(() => {
    if (!ticker) return;
    const c = new AbortController();
    void adminApi<AiCompanyDetail>(`ai/companies/${ticker}/${kind}`, { signal: c.signal }).then(r => { setDetail(r); setDetailError(""); })
      .catch(e => { if (!c.signal.aborted) fail(e, setDetailError); });
    try { window.history.replaceState(null, "", `/admin/ai?${new URLSearchParams({ ticker, kind })}`); } catch { /* Sandboxed preview. */ }
    return () => c.abort();
  }, [ticker, kind, refresh]);
  const active = !!detail?.runs.some(r => ACTIVE.has(r.status));
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) setRefresh(n => n + 1); }, active ? 4000 : 20000);
    return () => clearInterval(timer);
  }, [active]);

  const shown = detail?.ticker === ticker && detail.kind === kind ? detail : null;
  const companies = list?.companies.filter(c => `${c.ticker} ${c.name}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <div className="ra-workspace ai-workspace">
    <section className="ra-list" aria-label="AI 分析公司">
      <div className="ra-filters"><label className="ra-search"><Search size={17} /><input aria-label="搜索公司" placeholder="搜索代码或名称" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
      <div className="ra-list-caption"><span>{list ? `${list.companies.length} 家 AI 分析公司` : "正在加载…"}</span><button aria-label="刷新" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={14} /></button></div>
      {listError && <p className="ra-error" role="alert">{listError}</p>}
      <div className="ra-list-scroll">{companies.map(c => <button key={c.ticker} className="ra-report-row" aria-pressed={ticker === c.ticker} onClick={() => setTicker(c.ticker)}>
        <span className="ra-row-info"><strong>{c.ticker}</strong><small>{c.name !== c.ticker ? c.name : ""}</small>
          <span className="ai-kind-chips">{KINDS.map(([k, label]) => { const run = c.kinds[k].latestRun; return <span key={k} className="ra-badge" data-status={run ? badge(run.status) : ""} title={run ? `${label}：${STATUS[run.status]} · ${date(run.startedAt)}` : `${label}：无运行记录`}>{label}{run && ACTIVE.has(run.status) ? " · 运行中" : run?.status === "failed" ? " · 失败" : c.kinds[k].current ? "" : " · 未生成"}</span>; })}</span>
        </span></button>)}
        {list && !companies.length && <p className="ai-empty">没有匹配的公司。AI 分析范围由 Pipeline 的 SEC_AI_TICKERS 配置。</p>}
      </div>
    </section>
    <section className="ra-detail ai-detail" aria-label="AI 生成详情" aria-busy={!shown && !detailError}>
      <div className="ra-tabbar"><div role="tablist" aria-label="生成内容">{KINDS.map(([k, label]) => <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>{label}</button>)}</div></div>
      {detailError ? <p className="ra-error ai-pad" role="alert">{detailError}</p> : !ticker ? <p className="ai-empty">选择一家公司。</p> : !shown ? <p className="ai-empty" role="status"><LoaderCircle size={15} className="ra-spin" /> 正在读取…</p>
        : <KindDetail key={`${ticker}:${kind}`} detail={shown} onChanged={() => setRefresh(n => n + 1)} onError={e => fail(e, setDetailError)} />}
    </section>
  </div>;
}

function KindDetail({ detail, onChanged, onError }: { detail: AiCompanyDetail; onChanged: () => void; onError: (error: unknown) => void }) {
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const [accession, setAccession] = useState(detail.events[0]?.accession ?? "");
  const label = KINDS.find(([k]) => k === detail.kind)![1];
  const running = detail.runs.find(r => ACTIVE.has(r.status) && (detail.kind !== "guidance" || r.accession === accession));
  async function start() {
    const key = `ai:${detail.kind}:${detail.ticker}:${accession}`, requestId = pendingRequestId(key, storage());
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await adminApi<AiRunStarted>(`ai/companies/${detail.ticker}/${detail.kind}/runs`, { method: "POST", body: JSON.stringify({ requestId, ...(detail.kind === "guidance" ? { accession } : {}) }) });
      completeRequestId(key, storage()); setConfirming(false);
      setNotice(r.reused ? "该请求已提交过，正在显示原任务。" : "已提交，任务在后台运行，关闭页面不影响。");
      onChanged();
    } catch (e) {
      if (e instanceof AdminApiError && e.status === 401) onError(e); else setError((e as Error).message);
      if (e instanceof AdminApiError && e.status >= 400 && e.status < 500) completeRequestId(key, storage());
    } finally { setBusy(false); }
  }
  const hint = detail.kind === "findings" ? "按最新财报、指引和综述重新撰写发现，即使数据没有变化。通过核对的内容会替换当前版本。"
    : detail.kind === "explainer" ? "重新检索资料并撰写每项业务的解读，替换当前版本。"
    : "重新读取所选业绩发布的材料并用模型再次提取，不等待尚未发布的电话会文字稿。";
  return <div className="ai-pad">
    <header className="ai-head">
      <div><h2>{detail.ticker} · {label}</h2>
        <p>{detail.state.current ? `当前版本 ${date(detail.state.current.id)} · ${summaryText(detail.kind, detail.state.current.summary)}` : "尚未发布"}{" · "}{detail.state.automatic ? "自动生成已开启" : "自动生成未开启"}</p></div>
      <div className="ai-trigger">
        {detail.kind === "guidance" && !detail.events.length && <span className="ai-muted">尚无可读取的业绩发布 8-K</span>}
        {detail.kind === "guidance" && detail.events.length > 0 && <label>业绩发布<select value={accession} onChange={e => { setAccession(e.target.value); setConfirming(false); }}>{detail.events.map(e => <option key={e.accession} value={e.accession}>{e.eventDate} · {e.accession}{e.status ? ` · ${e.status}` : ""}</option>)}</select></label>}
        {!confirming ? <button className="ra-primary" disabled={!!detail.state.blocked || !!running || busy || (detail.kind === "guidance" && !accession)} onClick={() => setConfirming(true)} title={detail.state.blocked ?? undefined}><RefreshCw size={15} />{running ? "运行中" : "重新生成"}</button>
          : <span className="ai-confirm"><button className="ra-primary" disabled={busy} onClick={() => void start()}>{busy && <LoaderCircle size={15} className="ra-spin" />}确认，调用模型</button><button className="fm-button" disabled={busy} onClick={() => setConfirming(false)}>取消</button></span>}
      </div>
    </header>
    <p className="ai-hint">{detail.state.blocked ?? hint}</p>
    {notice && <p className="ra-notice" role="status">{notice}</p>}{error && <p className="ra-error" role="alert">{error}</p>}
    <h3>运行记录</h3>
    {!detail.runs.length ? <p className="ai-muted">暂无运行记录。记录从本功能上线后开始保存。</p> : <ol className="ai-runs">{detail.runs.map((run, i) => <RunItem key={run.runId} run={run} open={i === 0} />)}</ol>}
    <Versions detail={detail} onError={onError} />
  </div>;
}

function summaryText(kind: AiRunKind, s: { items: number; sources: number; periodEnd: string | null }) {
  return `${s.items} ${kind === "findings" ? "条发现" : kind === "explainer" ? "项业务" : "条指引"} · ${s.sources} 个来源${s.periodEnd ? ` · 报告期 ${s.periodEnd}` : ""}`;
}

function RunItem({ run, open }: { run: AiRun; open: boolean }) {
  const result = run.result as { findings?: number; businesses?: number; materials?: number; transcript?: string; withheld?: Array<{ id: string; reasons: string[] }> } | null;
  return <li><details open={open}>
    <summary><span className="ra-badge" data-status={badge(run.status)}>{STATUS[run.status]}</span><strong>{ACTIVE.has(run.status) ? stageLabel(run.stage) : date(run.startedAt)}</strong>
      <small>{run.trigger === "manual" ? "手动" : "自动"} · 开始 {date(run.startedAt)} · 用时 {elapsed(run)}{run.accession ? ` · ${run.accession}` : ""}</small></summary>
    {run.error && <p className="ra-error">{run.error}</p>}
    {result && <p className="ai-result">{[
      result.findings !== undefined && `发布 ${result.findings} 条发现`, result.businesses !== undefined && `${result.businesses} 项业务`,
      result.materials !== undefined && `${result.materials} 份材料`, result.transcript && `文字稿：${result.transcript === "extracted" ? "已提取" : result.transcript === "unavailable" ? "未取得" : "未配置"}`,
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
    {!detail.versions.length ? <p className="ai-muted">尚无已发布的结果。</p> : error ? <p className="ra-error">{error}</p> : !version || version.version.id !== id ? <p className="ai-muted"><LoaderCircle size={15} className="ra-spin" /> 正在读取版本…</p>
      : <>{!version.version.current && <p className="ai-hint">这是历史版本，线上展示的是当前版本。</p>}
        {detail.kind === "findings" ? <FindingsView publication={version.publication as FindingsPublication} /> : detail.kind === "explainer" ? <ExplainerView explainer={version.publication as BusinessExplainer} /> : detail.kind === "guidance" ? <GuidanceView guidance={version.publication as GuidancePublication} /> : <p className="ai-muted">该类型暂无专用视图，见下方原始 JSON。</p>}
        <details className="ai-raw"><summary>原始 JSON</summary><pre>{JSON.stringify(version.publication, null, 2)}</pre></details></>}
  </section>;
}

const FINDING_KIND: Record<AnalysisFinding["kind"], string> = { risk: "风险", strength: "优势", shift: "变化", watch: "关注" };
function FindingsView({ publication }: { publication: FindingsPublication }) {
  return <div className="ai-cards"><p className="ai-muted">报告期 {publication.periodEnd} · 模型 {publication.model}</p>{publication.findings.map(f => <article key={f.id} className="ai-card" data-kind={f.kind}>
    <header><span className="ra-badge" data-status={f.kind === "risk" ? "failed" : f.kind === "strength" ? "reviewed" : "processing"}>{FINDING_KIND[f.kind]}</span><span className="ai-severity">{"●".repeat(f.severity)}{"○".repeat(3 - f.severity)}</span><strong>{f.title}</strong></header>
    <p>{f.judgment.text}</p>
    <small>{f.evidence.length} 项证据{f.pairWith ? ` · 对照 ${f.pairWith}` : ""} · 视图 {f.anchors.view}{f.watch ? ` · 下期验证：${f.watch.condition}` : ""}</small>
  </article>)}</div>;
}
function ExplainerView({ explainer }: { explainer: BusinessExplainer }) {
  return <div className="ai-cards"><p className="ai-muted">模型 {explainer.model} · {explainer.sources.length} 个来源</p>{explainer.businesses.map(b => <article key={b.nodeId} className="ai-card">
    <header><strong>{b.name}</strong><small>{b.nodeId}</small></header>
    {b.summary ? <p>{b.summary.text}</p> : <p className="ai-muted">概述未通过审校。</p>}
    {b.products.length > 0 && <small>产品：{b.products.join("、")}</small>}
    {b.sections.map(s => <div key={s.id} className="ai-section"><h4>{s.title}</h4><ul>{s.items.map((item, i) => <li key={i}>{item.label && <strong>{item.label}：</strong>}{item.claim.text}</li>)}</ul></div>)}
  </article>)}</div>;
}
function GuidanceView({ guidance }: { guidance: GuidancePublication }) {
  const range = (i: GuidancePublication["items"][number]) => i.low === null && i.high === null ? (i.direction ?? "—") : i.low === i.high || i.high === null ? `${i.low}` : `${i.low ?? "—"} ~ ${i.high}`;
  return <div className="ai-table-wrap"><table className="ai-table"><thead><tr><th>发布</th><th>指标</th><th>期间</th><th>指引</th><th>说明</th></tr></thead><tbody>
    {guidance.items.map(i => <tr key={i.id}><td>{i.issuedAt}{i.action ? ` · ${i.action}` : ""}</td><td>{i.label}{i.segment ? `（${i.segment}）` : ""}<small>{i.basis}</small></td><td>{i.fiscalYear ? `FY${i.fiscalYear}${i.fiscalQuarter ? ` Q${i.fiscalQuarter}` : ""}` : i.horizon}</td><td>{range(i)}{i.unit === "percent" ? "%" : i.unit === "USD_per_share" ? " $/股" : i.unit === "USD" ? " $" : ""}</td><td>{i.text}</td></tr>)}
  </tbody></table>{!guidance.items.length && <p className="ai-muted">该版本没有指引条目。</p>}</div>;
}
