import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, RefreshCw, Search } from "lucide-react";
import type { TranslationEntry, TranslationsAdmin } from "@/shared/analysis-contract/translations-admin";
import type { TranslatedResource } from "@/shared/analysis-runtime/translation";
import { adminApi, AdminApiError } from "./admin-api";
import { usePageActive } from "./admin-page";

const RESOURCE: Record<TranslatedResource, string> = {
  flow: "业务地图说明", findings: "要点与分析师", explainer: "业务解读", tree: "业务脑图", guidance: "业绩指引",
  events: "事件摘要", filings: "财报列表", filing: "完整财报", item: "文件分析",
};
const STATUS: Record<TranslationEntry["status"], [string, string]> = { ready: ["已翻译", "reviewed"], rejected: ["未通过", "failed"], pending: ["待翻译", "processing"] };
type Filter = "all" | TranslationEntry["status"];
const date = (value?: string | null) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
const label = (resource: TranslatedResource, scope: string) => scope ? `${RESOURCE[resource]} ${scope}` : RESOURCE[resource];

/** One company's Chinese: coverage per resource, today's model calls, and every string beside its translation. */
export function TranslationsPanel({ ticker, onUnauthorized }: { ticker: string; onUnauthorized: () => void }) {
  const [data, setData] = useState<TranslationsAdmin | null>(null), [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<Filter>("all"), [resource, setResource] = useState(""), [search, setSearch] = useState("");
  const unauthorized = useRef(onUnauthorized);
  useEffect(() => { unauthorized.current = onUnauthorized; }, [onUnauthorized]);
  useEffect(() => {
    const c = new AbortController();
    void adminApi<TranslationsAdmin>(`ai/companies/${ticker}/translations`, { signal: c.signal }).then(r => { setData(r); setError(""); })
      .catch(e => { if (c.signal.aborted) return; if (e instanceof AdminApiError && e.status === 401) unauthorized.current(); else setError((e as Error).message); });
    return () => c.abort();
  }, [ticker, refresh]);
  const shown = usePageActive();
  useEffect(() => { const timer = setInterval(() => { if (!document.hidden && shown.current) setRefresh(n => n + 1); }, data?.run ? 10000 : 300000); return () => clearInterval(timer); }, [data?.run, shown]);
  const entries = useMemo(() => (data?.entries ?? []).filter(e => (filter === "all" || e.status === filter) && (!resource || `${e.resource}:${e.scope}` === resource)
    && (!search || e.source.toLowerCase().includes(search.toLowerCase()) || (e.text ?? "").includes(search))), [data, filter, resource, search]);

  if (error) return <p className="ra-error ai-pad" role="alert">{error}</p>;
  if (!data) return <p className="ai-empty" role="status"><LoaderCircle size={15} className="ra-spin" /> 加载中</p>;
  const total = data.resources.reduce((n, r) => n + r.total, 0), translated = data.resources.reduce((n, r) => n + r.translated, 0), rejected = data.resources.reduce((n, r) => n + r.rejected, 0);
  const counts = { all: data.entries.length, ready: 0, rejected: 0, pending: 0 } as Record<Filter, number>;
  for (const e of data.entries) counts[e.status]++;
  return <div className="ai-pad">
    <header className="ai-head">
      <div><h2>{data.ticker} · 中文译文</h2>
        <p>已翻译 {translated} / {total} 条 · 未通过 {rejected} · 今日模型调用 {data.budget.used} / {data.budget.cap}（全部公司）· {data.run ? `运行中，开始于 ${date(data.run.startedAt)}` : "空闲"} · {data.enabled ? "自动翻译已开启" : "自动翻译未开启"} · {data.version}</p></div>
      <div className="ai-trigger"><button className="fm-button" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={15} />刷新</button></div>
    </header>
    <h3>各资源</h3>
    <div className="bm-admin-table-wrap"><table className="bm-admin-table tr-table">
      <thead><tr><th>资源</th><th>已翻译</th><th>未通过</th><th>待翻译</th><th>译文表更新</th></tr></thead>
      <tbody>{data.resources.map(r => <tr key={`${r.resource}:${r.scope}`}>
        <td><button className="tr-link" onClick={() => setResource(v => v === `${r.resource}:${r.scope}` ? "" : `${r.resource}:${r.scope}`)} aria-pressed={resource === `${r.resource}:${r.scope}`}>{label(r.resource, r.scope)}</button></td>
        <td>{r.translated} / {r.total}</td><td>{r.rejected || "—"}</td><td>{r.total - r.translated - r.rejected || "—"}</td><td>{date(r.publishedAt)}</td>
      </tr>)}</tbody>
    </table></div>
    <div className="tr-filters">
      <div className="ra-segmented" role="group" aria-label="状态">{(["all", "rejected", "pending", "ready"] as Filter[]).map(f => <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === "all" ? "全部" : STATUS[f][0]}<small>{counts[f]}</small></button>)}</div>
      {resource && <button className="fm-button" onClick={() => setResource("")}>{label(...resource.split(":") as [TranslatedResource, string])} ✕</button>}
      <label className="ra-search"><Search size={17} /><input aria-label="搜索原文或译文" placeholder="搜索原文或译文" value={search} onChange={e => setSearch(e.target.value)} /></label>
    </div>
    {data.truncated && <p className="ai-hint">只列出前 {data.entries.length} 条，未通过与待翻译排在前面。</p>}
    {!entries.length ? <p className="ai-empty">无匹配条目</p> : <ul className="tr-entries">{entries.map((e, i) => <li key={`${e.resource}:${e.scope}:${i}`} data-status={e.status}>
      <header><span className="ra-badge" data-status={STATUS[e.status][1]}>{STATUS[e.status][0]}</span><small>{label(e.resource, e.scope)}{e.at ? ` · ${date(e.at)}` : ""}</small></header>
      <div className="tr-pair"><p lang="en">{e.source}</p><p lang="zh-CN">{e.text ?? "—"}</p></div>
      {e.problems.length > 0 && <ul className="ai-withheld">{e.problems.map(p => <li key={p}>{p}</li>)}</ul>}
    </li>)}</ul>}
  </div>;
}
