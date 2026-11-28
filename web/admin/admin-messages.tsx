import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminMessage, AdminMessages } from "@/src/api/admin/types/admin-messages";
import type { Feature } from "@/src/domains/business-map/features-contract";
import { adminApi } from "./admin-api";
import { financialDate } from "./financial-update-history";
import { Button } from "@/web/shared/ui/button";

const FEATURE_LABEL: Record<Feature, string> = { filings: "财报", findings: "要点", tree: "公司业务", valuation: "估值评估" };
const OUTCOME: Record<AdminMessage["outcome"], string> = { succeeded: "生成成功", failed: "生成失败，功能已关闭" };

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

/** Every entry, unread first; opening an entry marks it read and shows the company on the companies page. */
export function AdminInbox({ inbox, read, onOpen }: { inbox: AdminMessages | null; read: (ids?: string[]) => Promise<void>; onOpen: (ticker: string) => void }) {
  const [error, setError] = useState(""), busy = useRef(false);
  const act = async (ids?: string[]) => {
    if (busy.current) return; busy.current = true; setError("");
    try { await read(ids); } catch (e) { setError((e as Error).message); } finally { busy.current = false; }
  };
  return <section className="flex min-w-0 flex-col gap-4" aria-label="消息">
    {inbox && inbox.messages.length > 0 && <header className="flex flex-wrap items-center justify-between gap-3">
      <span role="status">{inbox.unread > 0 ? `${inbox.unread} 条未读` : "没有未读消息"}</span>
      <Button variant="outline" type="button" disabled={!inbox.unread} onClick={() => void act()}>全部标为已读</Button>
    </header>}
    {error && <p className="ra-error ra-error-banner am-inbox-status" role="alert">{error}</p>}
    {!inbox ? <p className="text-sm text-muted-foreground" role="status">正在加载消息…</p> : !inbox.messages.length ? <p className="text-sm text-muted-foreground">暂无消息</p>
      : <ul className="flex flex-col gap-2">{inbox.messages.map(m => <li key={m.id} data-unread={!m.readAt || undefined}>
        <Button variant="ghost" className="grid h-auto min-h-12 w-full items-start justify-start gap-2 px-3 py-3 text-left whitespace-normal sm:grid-cols-[minmax(9rem,1fr)_minmax(6rem,1fr)_minmax(0,2fr)_auto]" type="button" onClick={() => { if (!m.readAt) void act([m.id]); onOpen(m.ticker); }}>
          <span className="flex items-center gap-2">
            {!m.readAt && <span className="sr-only">未读</span>}
            <strong className="ra-mono">{m.ticker}</strong>
            <span>{FEATURE_LABEL[m.feature]}</span>
          </span>
          <span className="text-foreground" data-outcome={m.outcome}>{OUTCOME[m.outcome]}{m.count > 1 ? `（${m.count} 次）` : ""}</span>
          {m.detail && <span className="min-w-0 break-words text-muted-foreground">{m.detail}</span>}
          <time dateTime={m.updatedAt}>{financialDate(m.updatedAt)}</time>
        </Button>
      </li>)}</ul>}
  </section>;
}
