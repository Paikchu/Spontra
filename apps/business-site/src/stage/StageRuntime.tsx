import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useAgent } from "agents/react";
import { Button } from "@/packages/web/src/ui/button";
import { getLocale, labels, messages } from "@/packages/web/src/i18n";
import type { NoticeCode } from "@/shared/analysis-contract/scene";
import type { CompanyView } from "../BusinessMap";
import { carriesResult, nextTranscript, readEvent, type OverlayEvent, type OverlayState, type StageState, type TranscriptEntry, type Turn } from "./stage-model";

const m = messages({
  input: "Ask about this company", send: "Send", cancel: "Stop", stage: "Stage", connecting: "Connecting",
}, {
  input: "向这家公司提问", send: "发送", cancel: "停止", stage: "舞台", connecting: "连接中",
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
  const away = state === "away";
  const busy = state === "busy" || turn != null;
  useEffect(() => { if (state === "open") input.current?.focus(); }, [state]);
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
  // The console is the input and one button: answers, scenes and proposals take the stage. Only a notice that is the
  // latest thing said (a fault, a report's progress) stands over the bar, since nowhere else shows it.
  const last = entries[entries.length - 1];
  const notice = last && last.role === "assistant" && last.kind === "notice" && last.code !== "retention" ? NOTICE[last.code] : null;
  return <>
    <div className="ask-veil" data-away={away || undefined} aria-hidden="true" onClick={() => send({ type: "stage-click" })} />
    <div className="ask" data-state={state} role="dialog" aria-label={m.stage} aria-hidden={away || undefined} inert={away} onKeyDown={onKey}>
      {notice && <p className="ask-note" role="status">{notice}</p>}
      <form className="ask-bar" onSubmit={submit}>
        <span className="ask-ring" aria-hidden="true" />
        <textarea ref={input} rows={1} value={text} maxLength={600} aria-label={m.input} placeholder={connected ? m.input : m.connecting} disabled={!connected} onChange={e => setText(e.target.value)} />
        {busy ? <Button variant="unstyled" type="button" className="ask-send" onClick={onCancel}>{m.cancel}</Button>
          : <Button variant="unstyled" type="submit" className="ask-send" disabled={!text.trim() || !connected}>{m.send}</Button>}
      </form>
    </div>
  </>;
}
