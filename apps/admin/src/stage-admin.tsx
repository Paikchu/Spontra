import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { StageAdmin, StageSwitchUpdate } from "@/shared/analysis-contract/stage-admin";
import { adminApi, AdminApiError } from "./admin-api";
import { financialDate } from "./financial-update-history";

const FEATURE_LABEL: Record<string, string> = { "stage-identities": "读者身份", "stage-conversations": "对话", "stage-says": "提问", "stage-calls": "模型调用", "stage-reports": "报告", "stage-report-calls": "报告模型调用" };

/** The stage's switch, today's spend against its caps and the newest conversations (docs/stage-agent-design.md §3.6). */
export function StageAdminPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [detail, setDetail] = useState<{ id: string; body: string } | null>(null);
  const [data, setData] = useState<StageAdmin | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0), [ticker, setTicker] = useState("");
  const unauthorized = useRef(onUnauthorized);
  useEffect(() => { unauthorized.current = onUnauthorized; }, [onUnauthorized]);
  const fail = (e: unknown) => { if (e instanceof AdminApiError && e.status === 401) unauthorized.current(); else setError((e as Error).message); };
  useEffect(() => {
    const c = new AbortController();
    void adminApi<StageAdmin>("ai/stage", { signal: c.signal }).then(r => { setData(r); setError(""); }).catch(e => { if (!c.signal.aborted) fail(e); });
    return () => c.abort();
  }, [refresh]);
  async function set(update: StageSwitchUpdate) {
    setBusy(true); setError("");
    try { setData(await adminApi<StageAdmin>("ai/stage/switch", { method: "POST", body: JSON.stringify(update) })); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  return <section className="am-admin" aria-label="舞台">
    <div className="bm-admin-toolbar">
      <span className="am-count">舞台</span>
      <button className="bm-switch" role="switch" aria-checked={!!data?.enabled} aria-label="舞台（全部公司）" disabled={!data || busy} onClick={() => void set({ ticker: null, on: !data?.enabled })}><span /></button>
      <button className="ra-icon-button" onClick={() => setRefresh(n => n + 1)} disabled={busy} aria-label="刷新"><RefreshCw size={16} /></button>
    </div>
    {error && <p className="ra-error ra-error-banner" role="alert">{error}</p>}
    {!data && !error && <p role="status"><LoaderCircle size={15} className="ra-spin" /> 加载中</p>}
    {data && <div className="ra-panel">
      <p>公司：{data.tickers.map(t => <button key={t} className="ra-chip" disabled={busy} onClick={() => void set({ ticker: t, on: false })} title="移出">{t} ×</button>)}
        <input aria-label="加入公司" value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} size={8} />
        <button disabled={busy || !/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)} onClick={() => { void set({ ticker, on: true }); setTicker(""); }}>加入</button></p>
      <p>今日：{data.today.map(t => <span key={t.feature}>{FEATURE_LABEL[t.feature] ?? t.feature} {t.units}{t.cap != null ? ` / ${t.cap}` : ""} · </span>)}模型调用 {data.usage.calls} · 输入 {data.usage.inputTokens.toLocaleString()} · 输出 {data.usage.outputTokens.toLocaleString()}</p>
      <div className="bm-admin-table-wrap"><table className="bm-admin-table">
        <thead><tr><th>对话</th><th>读者</th><th>公司</th><th>回合</th><th>状态</th><th>最近</th></tr></thead>
        <tbody>{data.conversations.map(c => <tr key={c.id}><td><button className="ra-chip" onClick={() => void adminApi<unknown>(`ai/stage/conversations/${c.id}`).then(r => setDetail({ id: c.id, body: JSON.stringify(r, null, 2) })).catch(fail)}>{c.id.slice(0, 12)}</button></td><td><small>{c.reader}</small></td><td>{c.ticker}</td><td>{c.turns}</td><td>{c.status}</td><td>{financialDate(c.lastAt)}</td></tr>)}</tbody>
      </table></div>
      {detail && <details open><summary>{detail.id}</summary><pre style={{ maxHeight: "60vh", overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap" }}>{detail.body}</pre></details>}
    </div>}
  </section>;
}
