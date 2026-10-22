import type { LensChart } from "@/shared/analysis-contract/lens";
import type { NoticeCode, SceneBlock, SceneDocument, SceneRow } from "@/shared/analysis-contract/scene";

/**
 * The page side of the stage (docs/stage-agent-design.md §5): what the agent sends and the overlay's states, as pure
 * functions the tests drive without a browser.
 */
export type Locale = "en" | "zh-CN";
export type StageState = { scene: SceneDocument; revision: number; applied: number; contentLanguage: Locale };
export type TranscriptEntry =
  | { id: string; at: string; role: "user"; text: string }
  | { id: string; at: string; role: "assistant"; kind: "answer"; paragraphs: Array<{ text: string; sourceIds: string[] }>; contentLanguage: Locale }
  | { id: string; at: string; role: "assistant"; kind: "stage"; revision: number }
  | { id: string; at: string; role: "assistant"; kind: "notice"; code: NoticeCode }
  | { id: string; at: string; role: "assistant"; kind: "question"; questionId: string; question: string; settled?: "yes" | "no" };
export type TurnPhase = "thinking" | "answering" | "staging";
export type Turn = { id: string; phase: TurnPhase; status: { tool: string; arg?: string } | null };
export type StageEvent =
  | { type: "stage:turn"; turn: Turn | null }
  | { type: "stage:draft"; rows: SceneRow[] | null }
  | { type: "stage:transcript"; entries: TranscriptEntry[]; replace?: boolean };

/** Reads a socket message as one of the stage's events; protocol messages of the Agents SDK are ignored. */
export function readEvent(data: unknown): StageEvent | null {
  if (typeof data !== "string" || !data.startsWith('{"type":"stage:')) return null;
  try { return JSON.parse(data) as StageEvent; } catch { return null; }
}

/** The transcript after an event: replaced on (re)connection, appended otherwise, never twice the same entry. */
export function nextTranscript(current: TranscriptEntry[], event: Extract<StageEvent, { type: "stage:transcript" }>, keep = 40): TranscriptEntry[] {
  const base = event.replace ? [] : current;
  const updated = new Map(event.entries.map(e => [e.id, e]));
  const merged = base.map(e => updated.get(e.id) ?? e);
  const seen = new Set(merged.map(e => e.id));
  return [...merged, ...event.entries.filter(e => !seen.has(e.id))].slice(-keep);
}

/**
 * The overlay: closed (never opened on this page; not connected), open (transcript and input), busy (open while a turn
 * runs; input disabled), away (faded out once the reader has asked, still connected, so the answer lands on the stage),
 * disconnected (reconnecting). Asking, Escape, the close button and a click outside all send it away; a result that
 * arrives while it is open sends it away too, so the stage holds the eye.
 */
export type OverlayState = "closed" | "open" | "busy" | "away" | "disconnected";
export type OverlayEvent =
  | { type: "toggle" } | { type: "focus" } | { type: "escape" } | { type: "sent" }
  | { type: "turn-start" } | { type: "turn-end" }
  | { type: "disconnect" } | { type: "connect"; running: boolean }
  | { type: "stage-click" }
  /** A result the agent produced while the reader watched (a scene, an answer, a proposal, a failure). */
  | { type: "result" };

export function overlay(state: OverlayState, event: OverlayEvent): OverlayState {
  switch (event.type) {
    case "toggle": return state === "closed" || state === "away" ? "open" : state === "disconnected" ? state : "away";
    case "focus": return state === "closed" || state === "away" ? "open" : state;
    case "escape": case "stage-click": case "sent": case "result": return state === "open" || state === "busy" ? "away" : state;
    case "turn-start": return state === "open" ? "busy" : state;
    case "turn-end": return state === "busy" ? "open" : state;
    case "disconnect": return state === "open" || state === "busy" ? "disconnected" : state;
    case "connect": return state === "disconnected" ? event.running ? "busy" : "open" : state;
  }
}

/** Notices that answer the reader's question on the stage; the rest only mark progress in the transcript. */
const RESULT_NOTICES = new Set<NoticeCode>(["quota-reached", "global-cap-reached", "turn-interrupted", "turn-failed", "conversation-unavailable", "report-failed"]);

/**
 * What the stage shows for the reader's latest question: the turn while it runs, then its result. A scene (or a
 * report the reader started, which lives in the scene) is drawn from the agent's state; an answer, a proposed report
 * or a failure is shown as itself. Null when the latest question has nothing to show.
 */
export type StageResult =
  | { kind: "loading"; question: string; phase: TurnPhase }
  | { kind: "scene" }
  | { kind: "answer"; question: string; entry: Extract<TranscriptEntry, { kind: "answer" }> }
  | { kind: "proposal"; question: string; entry: Extract<TranscriptEntry, { kind: "question" }> }
  | { kind: "notice"; question: string; code: NoticeCode };
export function stageResult(entries: TranscriptEntry[], turn: Turn | null, now = Date.now()): StageResult | null {
  let asked = -1;
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.role === "user") { asked = i; break; }
  if (asked < 0) return null;
  const question = (entries[asked] as Extract<TranscriptEntry, { role: "user" }>).text;
  if (turn) return { kind: "loading", question, phase: turn.phase };
  for (let i = entries.length - 1; i > asked; i--) {
    const e = entries[i]!;
    if (e.role !== "assistant") continue;
    if (e.kind === "stage") return { kind: "scene" };
    if (e.kind === "answer") return { kind: "answer", question, entry: e };
    if (e.kind === "question") return e.settled === "yes" ? { kind: "scene" } : e.settled === "no" ? null : { kind: "proposal", question, entry: e };
    if (e.kind === "notice" && RESULT_NOTICES.has(e.code)) return { kind: "notice", question, code: e.code };
  }
  // A question just asked whose turn has not been announced yet is still loading; an old one that ended without a
  // result shows nothing.
  return now - Date.parse(entries[asked]!.at) < 120_000 ? { kind: "loading", question, phase: "thinking" } : null;
}

/** Whether a live transcript event carries a result for the reader (not a replay, not a progress mark). */
export const carriesResult = (event: Extract<StageEvent, { type: "stage:transcript" }>) =>
  !event.replace && event.entries.some(e => e.role === "assistant" && (e.kind === "stage" || e.kind === "answer" || (e.kind === "question" && !e.settled) || (e.kind === "notice" && RESULT_NOTICES.has(e.code))));

/**
 * Whether the agent's scene holds the stage. The reader's own picks on the map always win: a pick sets the scene
 * aside (it stays, one click brings it back); a scene finished while the reader moved on waits rather than taking
 * the stage from them.
 */
export type ShownEvent =
  | { type: "navigate" } | { type: "show" } | { type: "hide" }
  | { type: "committed"; revision: number; movedSinceSay: boolean };
export function shown(state: boolean, event: ShownEvent): boolean {
  switch (event.type) {
    case "navigate": case "hide": return false;
    case "show": return true;
    case "committed": return event.revision > 0 && !event.movedSinceSay ? true : state;
  }
}

/** A scene is worth taking the stage only when it shows something other than the map the page already draws. */
export const isDefaultScene = (rows: SceneRow[]) => rows.length === 1 && rows[0]!.cells.length === 1 && rows[0]!.cells[0]!.length === 1 && rows[0]!.cells[0]![0]!.kind === "business-flow" && !("focus" in rows[0]!.cells[0]![0]! && rows[0]!.cells[0]![0]!.focus);

/** A series over time drawn as the chart grammar draws any chart, so one renderer serves both. */
export function trendChart(block: Extract<SceneBlock, { kind: "metric-trend" }>): LensChart {
  return { id: `t${block.id}`.slice(0, 24).replace(/[^a-z0-9-]/g, ""), aspect: "wide", span: block.span, periods: block.periods,
    series: [{ id: "v", ref: block.ref }, { id: "y", ref: block.ref, transform: "yoy" }],
    marks: [{ type: "bar", series: ["v"] }, { type: "line", series: ["y"], axis: "right", color: "muted" }] };
}
