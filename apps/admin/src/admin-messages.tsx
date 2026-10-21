import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCheck } from "lucide-react";
import type { AdminMessage, AdminMessages } from "@/shared/analysis-contract/admin-messages";
import type { Feature } from "@/shared/analysis-contract/business-features";
import { adminApi } from "./admin-api";
import { financialDate } from "./financial-update-history";
import "./admin-messages.css";

const FEATURE_LABEL: Record<Feature, string> = { reports: "财报摘要", findings: "要点", explainer: "业务解读", tree: "业务脑图" };
const OUTCOME: Record<AdminMessage["outcome"], { status: string; text: string }> = { succeeded: { status: "reviewed", text: "生成成功" }, failed: { status: "failed", text: "生成失败 · 已关闭" } };

/** The inbox, read every 30 seconds while the page is visible; `read` marks entries read (all when no ids are given). */
export function useInbox(enabled: boolean) {
  const [inbox, setInbox] = useState<AdminMessages | null>(null), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const c = new AbortController();
    void adminApi<AdminMessages>("business-map/messages", { signal: c.signal }).then(setInbox).catch(() => { /* The pages report the session; the count waits for the next read. */ });
    return () => c.abort();
  }, [enabled, refresh]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => { if (!document.hidden) setRefresh(n => n + 1); }, 30_000);
    return () => clearInterval(timer);
  }, [enabled]);
  const read = useCallback(async (ids?: string[]) => {
    setInbox(await adminApi<AdminMessages>("business-map/messages/read", { method: "POST", body: JSON.stringify(ids ? { ids } : {}) }));
  }, []);
  return { inbox, read };
}

/** Every entry, unread first; opening an entry marks it read and shows the company in the whitelist. */
export function AdminInbox({ inbox, read, onOpen }: { inbox: AdminMessages | null; read: (ids?: string[]) => Promise<void>; onOpen: (ticker: string) => void }) {
  const [error, setError] = useState(""), busy = useRef(false);
  const act = async (ids?: string[]) => {
    if (busy.current) return; busy.current = true; setError("");
    try { await read(ids); } catch (e) { setError((e as Error).message); } finally { busy.current = false; }
  };
  return <section className="am-inbox" aria-label="消息">
    <div className="am-toolbar"><span>未读 · {inbox?.unread ?? 0}</span><button className="fm-button" disabled={!inbox?.unread} onClick={() => void act()}><CheckCheck size={15} />全部已读</button></div>
    {error && <p className="ra-error" role="alert">{error}</p>}
    {!inbox ? <p role="status">加载中</p> : !inbox.messages.length ? <p>无消息</p>
      : <ul className="am-list ra-panel">{inbox.messages.map(m => <li key={m.id} data-unread={!m.readAt || undefined}>
        <button onClick={() => { if (!m.readAt) void act([m.id]); onOpen(m.ticker); }}>
          <strong className="ra-mono">{m.ticker}</strong>
          <span>{FEATURE_LABEL[m.feature]}</span>
          <span className="ra-badge" data-status={OUTCOME[m.outcome].status}>{OUTCOME[m.outcome].text}{m.count > 1 ? ` ×${m.count}` : ""}</span>
          <small title={m.detail ?? undefined}>{m.detail}</small>
          <time dateTime={m.updatedAt}>{financialDate(m.updatedAt)}</time>
        </button>
      </li>)}</ul>}
  </section>;
}
