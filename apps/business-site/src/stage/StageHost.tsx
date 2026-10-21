import "./stage.css";
import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { Button } from "@/packages/web/src/ui/button";
import { messages } from "@/packages/web/src/i18n";
import type { CompanyView } from "../BusinessMap";
import type { CompanyData } from "../live-company";
import { isDefaultScene, overlay, shown, type OverlayEvent, type StageState } from "./stage-model";

const StageRuntime = lazy(() => import("./StageRuntime"));
const SceneView = lazy(() => import("./SceneView"));

const m = messages({ ask: "Ask", map: "Map", stage: "Stage" }, { ask: "提问", map: "地图", stage: "舞台" });

/** What the company page takes from the stage: the entry button, the scene when it holds the stage, and the overlay. */
export type StageHost = {
  railFoot: ReactNode;
  stageOverride: ReactNode | null;
  onNavigate: () => void;
  onView: (view: CompanyView) => void;
  layer: ReactNode;
  /** A finding the scene asked to open on the map. */
  focusRequest: { finding: string; nonce: number } | null;
};

/**
 * The stage for one company page (docs/stage-agent-design.md §5): nothing loads and nothing connects until the reader
 * opens the overlay; the socket client and the scene renderer are their own chunks. The map's own view is untouched
 * while the stage is closed, switched off, or unreachable.
 */
export function useStageHost(ticker: string, data: CompanyData): StageHost {
  const [open, setOpen] = useState<{ open: boolean; reader: boolean } | null>(null);
  const [state, dispatch] = useReducer(overlay, new URLSearchParams(location.search).has("c") ? "open" : "closed");
  const [scene, setScene] = useState<StageState | null>(null);
  const [onStage, setOnStage] = useState(false);
  const [view, setView] = useState<CompanyView | null>(null);
  const [focusRequest, setFocusRequest] = useState<StageHost["focusRequest"]>(null);
  const movedSinceSay = useRef(false);
  useEffect(() => {
    const c = new AbortController();
    fetch(`/agents/status?ticker=${encodeURIComponent(ticker)}`, { signal: c.signal, headers: { accept: "application/json" } })
      .then(r => r.ok ? r.json() as Promise<{ open: boolean; reader: boolean }> : null).then(v => { if (v) setOpen(v); }).catch(() => {});
    return () => c.abort();
  }, [ticker]);
  const send = useCallback((event: OverlayEvent) => dispatch(event), []);
  // ⌘J / Ctrl+J opens and closes the overlay; `/` stays the search shortcut.
  useEffect(() => {
    if (!open?.open) return;
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); dispatch({ type: "toggle" }); } };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [open?.open]);
  const onNavigate = useCallback(() => { movedSinceSay.current = true; setOnStage(v => shown(v, { type: "navigate" })); }, []);
  const onView = useCallback((next: CompanyView) => setView(next), []);
  const onScene = useCallback((next: StageState, committed: boolean) => {
    setScene(next);
    if (committed) setOnStage(v => shown(v, { type: "committed", revision: next.revision, movedSinceSay: movedSinceSay.current }));
  }, []);
  const onSay = useCallback(() => { movedSinceSay.current = false; }, []);
  const openFinding = useCallback((finding: string) => { setOnStage(false); setFocusRequest({ finding, nonce: Date.now() }); }, []);
  if (!open?.open) return { railFoot: null, stageOverride: null, onNavigate, onView, layer: null, focusRequest };
  const showScene = onStage && scene && !isDefaultScene(scene.scene.rows);
  return {
    railFoot: <div className="ask-entry"><Button variant="unstyled" type="button" className="ask-open" aria-keyshortcuts="Meta+J Control+J" aria-expanded={state !== "closed"} onClick={() => dispatch({ type: "toggle" })}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 4v-4h0A2 2 0 0 1 4 14Z" /></svg>{m.ask}</Button></div>,
    stageOverride: showScene ? <div className="scene-stage" data-revision={scene.revision}>
      <header className="scene-head"><span className="scene-mark">{m.stage}</span><Button variant="unstyled" type="button" className="scene-back" onClick={() => setOnStage(false)}>{m.map}</Button></header>
      <Suspense fallback={<div className="scene-grid" aria-busy="true" />}><SceneView ticker={ticker} scene={scene} data={data} onOpenFinding={openFinding} /></Suspense>
    </div> : null,
    onNavigate, onView, focusRequest,
    layer: state === "closed" ? null : <Suspense fallback={null}><StageRuntime ticker={ticker} reader={open.reader} state={state} send={send} view={view} onScene={onScene} onSay={onSay}
      sceneShown={!!showScene} onShowScene={() => setOnStage(true)} /></Suspense>,
  };
}
