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
 * The overlay: closed (not rendered, not connected), open (transcript and input), busy (a turn runs; input disabled),
 * mini (the input bar and the last reply, giving the stage back), disconnected (reconnecting). Escape steps down one
 * level; a finished stage update gives the stage back.
 */
export type OverlayState = "closed" | "open" | "busy" | "mini" | "disconnected";
export type OverlayEvent =
  | { type: "toggle" } | { type: "focus" } | { type: "escape" }
  | { type: "turn-start" } | { type: "turn-end"; staged: boolean }
  | { type: "disconnect" } | { type: "connect"; running: boolean }
  | { type: "stage-click" }
  /** A scene the agent committed while the reader watched: it gives the stage back however the turn ended. */
  | { type: "staged" };

export function overlay(state: OverlayState, event: OverlayEvent): OverlayState {
  switch (event.type) {
    case "toggle": return state === "closed" ? "open" : state === "busy" || state === "disconnected" ? state : "closed";
    case "focus": return state === "closed" || state === "mini" ? "open" : state;
    case "escape": return state === "open" ? "mini" : state === "mini" ? "closed" : state;
    case "turn-start": return state === "closed" ? state : "busy";
    case "turn-end": return state === "busy" ? event.staged ? "mini" : "open" : state;
    case "disconnect": return state === "closed" ? state : "disconnected";
    case "connect": return state === "disconnected" ? event.running ? "busy" : "open" : state;
    case "stage-click": return state === "open" ? "mini" : state;
    case "staged": return state === "busy" || state === "open" ? "mini" : state;
  }
}

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
