import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useAgent } from "agents/react";
import { Button } from "@/packages/web/src/ui/button";
import { getLocale, labels, messages } from "@/packages/web/src/i18n";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";
import type { NoticeCode } from "@/shared/analysis-contract/scene";
import type { CompanyView } from "../BusinessMap";
import { carriesResult, nextTranscript, readEvent, type OverlayEvent, type OverlayState, type StageState, type TranscriptEntry, type Turn } from "./stage-model";

const m = messages({
  input: "Ask about this company", send: "Send", cancel: "Stop", close: "Close", stage: "Stage",
  reading: "Reading", laying: "Laying out", answering: "Answering", connecting: "Connecting", retention: "Kept 30 days",
}, {
  input: "向这家公司提问", send: "发送", cancel: "停止", close: "关闭", stage: "舞台",
  reading: "读取中", laying: "排版中", answering: "回答中", connecting: "连接中", retention: "保留 30 天",
});
const NOTICE: Record<NoticeCode, string> = labels({
  "quota-reached": "Daily limit reached", "global-cap-reached": "Paused for today", "turn-interrupted": "Interrupted",
  "turn-failed": "No result", "conversation-unavailable": "Conversation unavailable", "report-started": "Report started", "report-ready": "Report ready",
  "report-failed": "Report failed", retention: "Kept 30 days",
}, {
  "quota-reached": "已达今日上限", "global-cap-reached": "今日已暂停", "turn-interrupted": "已中断",
  "turn-failed": "无结果", "conversation-unavailable": "对话不可用", "report-started": "报告已开始", "report-ready": "报告已完成",
  "report-failed": "报告失败", retention: "保留 30 天",
});

/** What the stage needs from the conversation: the transcript and the running turn, and a way to answer a proposal. */
export type StageActivity = { entries: TranscriptEntry[]; turn: Turn | null; answer: (questionId: string, yes: boolean) => void };

type Props = {
  ticker: string; reader: boolean; state: OverlayState; send: (event: OverlayEvent) => void; view: CompanyView | null;
  onScene: (state: StageState, committed: boolean) => void; onSay: (text: string) => void; onActivity: (activity: StageActivity) => void;
};

/** The reader's id (an HttpOnly cookie the page never reads) and the conversation the socket opens, made once per page. */
async function conversationFor(ticker: string, reader: boolean, fresh: boolean): Promise<string | null> {
  const post = (path: string, body?: unknown) => fetch(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!reader && !(await post("/agents/identity")).ok) return null;
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("c");
  if (!fresh && fromUrl && /^[0-9a-f]{32}$/.test(fromUrl)) return fromUrl;
  if (!fresh) {
    const list = await fetch(`/agents/conversations?ticker=${encodeURIComponent(ticker)}`, { headers: { accept: "application/json" } }).then(r => r.ok ? r.json() as Promise<{ conversations: Array<{ id: string }> }> : null).catch(() => null);
    if (list?.conversations[0]) return list.conversations[0].id;
  }
  const made = await post("/agents/conversations", { ticker, locale: getLocale() });
  return made.ok ? (await made.json() as { id: string }).id : null;
}

/**
 * The overlay and its socket (docs/stage-agent-design.md §5.4–5.5): the reader's questions in words over the input.
 * Results never appear here; they take the stage. The conversation's id goes into the address so a reload comes back
 * to it; the reader's id never does.
 */
export default function StageRuntime({ ticker, reader, state, send, view, onScene, onSay, onActivity }: Props) {
  const [conversation, setConversation] = useState<string | null>(null);
  const [failed, setFailed] = useState<NoticeCode | null>(null);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    let live = true;
    void conversationFor(ticker, reader, fresh).then(id => {
      if (!live) return;
      if (!id) { setFailed("conversation-unavailable"); return; }
      const url = new URL(location.href);
      if (url.searchParams.get("c") !== id) { url.searchParams.set("c", id); history.replaceState(history.state, "", url); }
      setConversation(id);
    }).catch(() => { if (live) setFailed("conversation-unavailable"); });
    return () => { live = false; };
  }, [ticker, reader, fresh]);
  // A conversation the address names but this reader cannot open is dropped for a new one, once.
  const onRefused = useCallback(() => {
    if (fresh) { setFailed("conversation-unavailable"); return; }
    const url = new URL(location.href);
    url.searchParams.delete("c");
    history.replaceState(history.state, "", url);
    setConversation(null);
    setFresh(true);
  }, [fresh]);
  if (failed) return <Layer state={state} send={send} entries={[{ id: "failed", at: "", role: "assistant", kind: "notice", code: failed }]} turn={null} connected={false} onSubmit={() => {}} onCancel={() => {}} />;
  if (!conversation) return <Layer state={state} send={send} entries={[]} turn={null} connected={false} onSubmit={() => {}} onCancel={() => {}} />;
  return <Connected key={conversation} conversation={conversation} state={state} send={send} view={view} onScene={onScene} onSay={onSay} onActivity={onActivity} onRefused={onRefused} />;
}

function Connected({ conversation, state, send, view, onScene, onSay, onActivity, onRefused }: Omit<Props, "ticker" | "reader"> & { conversation: string; onRefused: () => void }) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [connected, setConnected] = useState(false);
  const revision = useRef(0);
  const opened = useRef(false);
  const socket = useRef<{ send(data: string): void } | null>(null);
  const agent = useAgent<StageState>({
    agent: "stage-agent", name: conversation,
    onStateUpdate: next => {
      const committed = next.revision > revision.current && opened.current;
      revision.current = next.revision;
      onScene(next, committed);
      // The receipt goes once the page has drawn the revision, not when it arrived.
      if (committed) requestAnimationFrame(() => requestAnimationFrame(() => socket.current?.send(JSON.stringify({ type: "applied", revision: next.revision }))));
    },
    onMessage: (message: MessageEvent) => {
      const event = readEvent(message.data);
      if (!event) return;
      if (event.type === "stage:transcript") {
        setEntries(list => nextTranscript(list, event));
        // A result that arrives while the reader has the overlay open sends it away, so the stage holds the eye.
        // Entries replayed on (re)connection do not.
        if (carriesResult(event)) send({ type: "result" });
      }
      else if (event.type === "stage:turn") { setTurn(event.turn); send(event.turn ? { type: "turn-start" } : { type: "turn-end" }); }
    },
    onOpen: () => { opened.current = true; setConnected(true); send({ type: "connect", running: false }); },
    onClose: (event: CloseEvent) => { setConnected(false); if (event.code === 4403 || event.code === 1008) onRefused(); else send({ type: "disconnect" }); },
  });
  useEffect(() => { if (connected && view) agent.send(JSON.stringify({ type: "observe", view })); }, [agent, connected, view]);
  useEffect(() => { socket.current = agent; }, [agent]);
  useEffect(() => {
    onActivity({ entries, turn, answer: (questionId, yes) => socket.current?.send(JSON.stringify({ type: "answer", questionId, value: yes ? "yes" : "no" })) });
  }, [entries, turn, onActivity]);
  const submit = (text: string) => { onSay(text); agent.send(JSON.stringify({ type: "say", text })); };
  return <Layer state={state} send={send} entries={entries} turn={turn} connected={connected} onSubmit={submit} onCancel={() => agent.send(JSON.stringify({ type: "cancel" }))} />;
}

function Layer({ state, send, entries, turn, connected, onSubmit, onCancel }: {
  state: OverlayState; send: (event: OverlayEvent) => void; entries: TranscriptEntry[]; turn: Turn | null; connected: boolean;
  onSubmit: (text: string) => void; onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const away = state === "away";
  const busy = state === "busy" || turn != null;
  useEffect(() => { if (state === "open") input.current?.focus(); }, [state]);
  useEffect(() => { const el = scroll.current; if (el) el.scrollTop = el.scrollHeight; }, [entries.length, turn?.phase]);
  // When the input grows the transcript gives up height; it keeps its latest entry in view while it does, unless the
  // reader has scrolled back through it.
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    let pinned = true;
    const onScroll = () => { pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 24; };
    const observer = new ResizeObserver(() => { if (pinned) el.scrollTop = el.scrollHeight; });
    el.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(el);
    return () => { observer.disconnect(); el.removeEventListener("scroll", onScroll); };
  }, []);
  // The blur around the overlay is centred on the input bar.
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const el = root.current, form = bar.current;
    if (!el || !form) return;
    const style = document.documentElement.style;
    const sync = () => {
      const box = form.getBoundingClientRect(), top = el.getBoundingClientRect().top;
      const cy = box.top + box.height / 2;
      style.setProperty("--ask-cx", `${box.left + box.width / 2}px`);
      style.setProperty("--ask-cy", `${cy}px`);
      style.setProperty("--ask-bw", `${box.width}px`);
      style.setProperty("--ask-up", `${Math.max(box.height / 2, cy - top)}px`);
    };
    const observer = new ResizeObserver(sync);
    observer.observe(el); observer.observe(form); sync();
    addEventListener("resize", sync);
    return () => {
      observer.disconnect(); removeEventListener("resize", sync);
      for (const name of ["--ask-cx", "--ask-cy", "--ask-bw", "--ask-up"]) style.removeProperty(name);
    };
  }, []);
  // Browsers without `field-sizing: content` grow the input by hand, up to the height the stylesheet allows.
  useEffect(() => {
    const el = input.current;
    if (!el || CSS.supports("field-sizing", "content")) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const submit = (e?: FormEvent) => { e?.preventDefault(); const value = text.trim(); if (!value || busy || !connected) return; onSubmit(value); setText(""); };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); send({ type: "escape" }); input.current?.blur(); }
    else if (e.key === "Enter" && !e.shiftKey && e.target === input.current) { e.preventDefault(); submit(); }
  };
  // Words only: the reader's questions and the short notices; answers, scenes and proposals are on the stage.
  const said = entries.filter(e => e.role === "user" || e.kind === "notice");
  const status = !connected ? m.connecting : turn ? turn.phase === "staging" ? m.laying : turn.phase === "answering" ? m.answering : m.reading : null;
  return createPortal(<>
    <div className="ask-veil" data-away={away || undefined} aria-hidden="true" onClick={() => send({ type: "stage-click" })}><i /><i /><i /></div>
    <div ref={root} className="ask" data-state={state} role="dialog" aria-label={m.stage} aria-hidden={away || undefined} inert={away} onKeyDown={onKey}>
    <div className="ask-scroll" ref={scroll} aria-live="polite">
      {said.length === 0 && <p className="ask-note">{m.retention}</p>}
      {said.map(e => e.role === "user" ? <p key={e.id} className="ask-entry-user" lang={langOf(e.text)}>{e.text}</p>
        : e.kind === "notice" ? <p key={e.id} className="ask-entry-notice">{NOTICE[e.code]}</p> : null)}
    </div>
    {status && <p className="ask-status" role="status">{status}</p>}
    <form ref={bar} className="ask-bar" onSubmit={submit}>
      <textarea ref={input} rows={1} value={text} maxLength={600} aria-label={m.input} placeholder={m.input} disabled={!connected} onChange={e => setText(e.target.value)} />
      {busy ? <Button variant="unstyled" type="button" className="ask-send" onClick={onCancel}>{m.cancel}</Button>
        : <Button variant="unstyled" type="submit" className="ask-send" disabled={!text.trim() || !connected}>{m.send}</Button>}
      <Button variant="unstyled" type="button" className="ask-close icon-button" aria-label={m.close} onClick={() => send({ type: "toggle" })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg></Button>
    </form>
    {busy && <span className="ask-progress" aria-hidden="true" />}
  </div></>, document.body);
}
