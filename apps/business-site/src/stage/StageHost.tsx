import "./stage.css";
import { Component, lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { Button } from "@/packages/web/src/ui/button";
import { messages } from "@/packages/web/src/i18n";
import type { CompanyView } from "../BusinessMap";
import type { CompanyData } from "../live-company";
import type { StageActivity } from "./StageRuntime";
import { recoverable, reopening } from "./chunk-recovery";
import { isDefaultScene, overlay, shown, stageResult, type OverlayEvent, type OverlayState, type StageResult, type StageState } from "./stage-model";

const loadRuntime = recoverable(() => import("./StageRuntime"));
const loadBoard = recoverable(() => import("./StageBoard"));
const freshRuntime = () => lazy(loadRuntime);
const freshBoard = () => lazy(loadBoard);

const m = messages(
  { ask: "Ask", map: "Map", stage: "Stage", unavailable: "Conversation unavailable", retry: "Retry" },
  { ask: "提问", map: "地图", stage: "舞台", unavailable: "对话不可用", retry: "重试" },
);
const NO_ACTIVITY: StageActivity = { entries: [], turn: null, answer: () => {} };

/** Keeps a failure of the console or the stage inside it, so the company page stays. */
class StageBoundary extends Component<{ fallback: (retry: () => void) => ReactNode; onRetry: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  retry = () => { this.props.onRetry(); this.setState({ failed: false }); };
  render() {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}

function ConsoleFailure({ state, retry }: { state: OverlayState; retry: () => void }) {
  const away = state === "away";
  return <>
    <div className="ask-veil" data-away={away || undefined} aria-hidden="true" />
    <div className="ask" data-state={state} role="dialog" aria-label={m.stage} aria-hidden={away || undefined} inert={away}>
      <div className="ask-bar ask-failed"><p role="alert">{m.unavailable}</p><Button variant="unstyled" type="button" className="ask-send" onClick={retry}>{m.retry}</Button></div>
    </div>
  </>;
}

/** What the company page takes from the stage: the console at the rail's foot (closed and open), and the scene when it holds the stage. */
export type StageHost = {
  railFoot: ReactNode;
  stageOverride: ReactNode | null;
  onNavigate: () => void;
  onView: (view: CompanyView) => void;
  /** A finding the scene asked to open on the map. */
  focusRequest: { finding: string; nonce: number } | null;
};

/**
 * The stage for one company page: nothing loads and nothing connects until the reader
 * opens the overlay; the socket client and the stage's renderer are their own chunks. Once the reader asks, the
 * overlay fades and the stage takes the question: its turn while it runs, then its result. The map's own view is
 * untouched while the stage is closed or unreachable, and the reader's own picks on the map always win.
 */
export function useStageHost(ticker: string, data: CompanyData): StageHost {
  const enabled = data.publication?.stageEnabled !== false;
  const [open, setOpen] = useState<{ open: boolean; reader: boolean } | null>(null);
  const [state, dispatch] = useReducer(overlay, new URLSearchParams(location.search).has("c") || reopening() ? "open" : "closed");
  const [StageRuntime, reloadRuntime] = useReducer(freshRuntime, undefined, freshRuntime);
  const [StageBoard, reloadBoard] = useReducer(freshBoard, undefined, freshBoard);
  const [scene, setScene] = useState<StageState | null>(null);
  const [onStage, setOnStage] = useState(false);
  const [view, setView] = useState<CompanyView | null>(null);
  const [focusRequest, setFocusRequest] = useState<StageHost["focusRequest"]>(null);
  const [activity, setActivity] = useState<StageActivity>(NO_ACTIVITY);
  // The question just sent, until the server's transcript carries it, so the stage loads from the first frame.
  const [pending, setPending] = useState<{ text: string; asked: number } | null>(null);
  const movedSinceSay = useRef(false);
  useEffect(() => {
    if (enabled) return;
    setOpen(null);
    setOnStage(false);
    setScene(null);
    setPending(null);
    setActivity(NO_ACTIVITY);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    const c = new AbortController();
    fetch(`/agents/status?ticker=${encodeURIComponent(ticker)}`, { signal: c.signal, headers: { accept: "application/json" } })
      .then(r => r.ok ? r.json() as Promise<{ open: boolean; reader: boolean }> : null).then(v => { if (v) setOpen(v); }).catch(() => {});
    return () => c.abort();
  }, [ticker, enabled]);
  const send = useCallback((event: OverlayEvent) => dispatch(event), []);
  // ⌘J / Ctrl+J opens and closes the overlay; `/` stays the search shortcut.
  useEffect(() => {
    if (!enabled || !open?.open) return;
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); dispatch({ type: "toggle" }); } };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [enabled, open?.open]);
  const onNavigate = useCallback(() => { movedSinceSay.current = true; setOnStage(v => shown(v, { type: "navigate" })); }, []);
  const onView = useCallback((next: CompanyView) => setView(next), []);
  const onScene = useCallback((next: StageState, committed: boolean) => {
    setScene(next);
    if (committed) setOnStage(v => shown(v, { type: "committed", revision: next.revision, movedSinceSay: movedSinceSay.current }));
  }, []);
  const onActivity = useCallback((next: StageActivity) => setActivity(next), []);
  const onSay = useCallback((text: string) => {
    movedSinceSay.current = false;
    setPending({ text, asked: activity.entries.filter(e => e.role === "user").length });
    setOnStage(true);
    dispatch({ type: "sent" });
  }, [activity.entries]);
  // The renderer loads with the overlay, so the stage is ready by the time the reader has asked.
  useEffect(() => { if (enabled && state !== "closed") void import("./StageBoard").catch(() => {}); }, [enabled, state]);
  // Anywhere outside the console sends it away, in whatever state it is; the page under the click still gets it.
  useEffect(() => {
    if (!enabled || (state !== "open" && state !== "busy" && state !== "disconnected")) return;
    const outside = (e: PointerEvent) => { if (!(e.target instanceof Element && e.target.closest(".ask, .ask-entry"))) dispatch({ type: "stage-click" }); };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [enabled, state]);
  const openFinding = useCallback((finding: string) => { setOnStage(false); setFocusRequest({ finding, nonce: Date.now() }); }, []);
  if (!enabled || !open?.open) return { railFoot: null, stageOverride: null, onNavigate, onView, focusRequest: null };
  const asked = activity.entries.filter(e => e.role === "user").length;
  const result: StageResult | null = pending && asked <= pending.asked ? { kind: "loading", question: pending.text, phase: "thinking" } : stageResult(activity.entries, activity.turn);
  const hasScene = !!scene && !isDefaultScene(scene.scene.rows);
  const showBoard = onStage && (result != null || hasScene);
  return {
    // The closed console is the Ask button; opening it mounts the runtime over the rail's foot.
    railFoot: <>
      <div className="ask-entry"><Button variant="unstyled" type="button" className="ask-open" aria-label={m.ask} title={m.ask} aria-keyshortcuts="Meta+J Control+J" aria-expanded={state === "open" || state === "busy" || state === "disconnected"} onClick={() => dispatch({ type: "toggle" })}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 4v-4h0A2 2 0 0 1 4 14Z" /></svg><span>{m.ask}</span></Button>
        {!showBoard && (result != null || hasScene) && <Button variant="unstyled" type="button" className="ask-back" onClick={() => setOnStage(true)}>{m.stage}</Button>}</div>
      {state !== "closed" && <StageBoundary onRetry={reloadRuntime} fallback={retry => <ConsoleFailure state={state} retry={retry} />}><Suspense fallback={null}><StageRuntime ticker={ticker} reader={open.reader} state={state} send={send} view={view} onScene={onScene} onSay={onSay} onActivity={onActivity} /></Suspense></StageBoundary>}
    </>,
    stageOverride: showBoard ? <div className="scene-stage" data-result={result?.kind ?? "scene"}>
      <header className="scene-head"><span className="scene-mark">{m.stage}</span><Button variant="unstyled" type="button" className="scene-back" onClick={() => setOnStage(false)}>{m.map}</Button></header>
      <StageBoundary onRetry={reloadBoard} fallback={retry => <section className="board board-notice"><p className="board-notice-text" role="alert">{m.unavailable}</p><div className="board-actions"><Button variant="unstyled" type="button" onClick={retry}>{m.retry}</Button></div></section>}>
        <Suspense fallback={<div className="board board-loading" aria-busy="true" />}>
          <StageBoard ticker={ticker} data={data} scene={scene} result={result} onOpenFinding={openFinding} onAnswer={activity.answer} />
        </Suspense>
      </StageBoundary>
    </div> : null,
    onNavigate, onView, focusRequest,
  };
}
