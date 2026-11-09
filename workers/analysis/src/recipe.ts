import type { ToolCall } from "./tool-loop.ts";
import type { AnyTool, ToolOutcome, ToolPolicy } from "./tools/registry.ts";

/**
 * What one agent run is made of, whoever drives it (the Pi session host, pi/host.ts): the model replies, the harness runs the
 * calls it makes through the tool pipeline, and the results go back until a terminal tool settles the run or the
 * budget runs out. Pi keeps the exchange and compacts it within the same session when it outgrows the context.
 */
export type Recipe<I, O, S> = {
  id: string;
  budget: { turns: number; wallMs: number; /** Uncached input plus output a session may spend before its last round. */ tokens?: number };
  /** The longest tool result the model reads, in characters; a longer one is cut with a notice. */
  resultChars?: number;
  /** Tool calls one reply may make; the default when unset is `CALLS_PER_TURN`. */
  callsPerTurn?: number;
  system(input: I): string;
  open(input: I): S;
  tools(state: S): AnyTool<S>[];
  policy: ToolPolicy;
  /** True once a terminal tool has settled the run. */
  settled(state: S): boolean;
  settle(state: S, reason: "finished" | "budget" | "failed" | "interrupted" | "cancelled"): O;
  /** What the model is told when a reply calls no tool. */
  nudge: string;
  /** Called when the run ends, however it ended: the way a session with nobody waiting on it records a failure. */
  afterRun?(state: S): Promise<void>;
  /** Called as each model turn begins, with its number. */
  onTurn?(state: S, turn: number): void;
  /** The line closing every tool result, given the turns left; the default names the turns alone. */
  budgetLine?(state: S, turnsLeft: number): string;
};

export const defaultBudgetLine = (left: number) => `Budget left: ${left} turn${left === 1 ? "" : "s"}.${left <= 1 ? " Finish now with what you have." : ""}`;

export const DEFAULT_RESULT_CHARS = 12_000;
/** A tool result as the model reads it. A cut is always stated, so a partial result cannot pass for a whole one. */
export function fitResult(observation: string, limit = DEFAULT_RESULT_CHARS): string {
  if (observation.length <= limit) return observation;
  return `${observation.slice(0, limit)}\n\n[Result cut: ${observation.length - limit} of ${observation.length} characters not shown. Ask for a narrower part.]`;
}

export type TurnRecord = { turn: number; thought: string; action: string; input: string; observation: string; failed?: boolean };

/** Where the loop's effects go: the per-turn allowance, the trail, and how calls run. */
export type LoopHost = {
  /** Reserves one model call against the daily allowances; false ends the run. */
  reserve(): Promise<boolean>;
  record(turn: TurnRecord): void;
  /** Runs one turn's calls; the stage runs safe calls together, a Workflow one durable step each. */
  execute(turn: number, calls: ToolCall[], run: (call: ToolCall) => Promise<ToolOutcome>): Promise<ToolOutcome[]>;
  /** Called with a reply's first tool name as soon as the stream shows it (the stage's waiting state). */
  onToolStart?(name: string): void;
  signal: AbortSignal;
  now(): number;
  /** Durable steps for outside work; unset runs the work directly. */
  stage?<T>(name: string, work: () => Promise<T>): Promise<T>;
};

export type LoopOutcome<O> = { output: O; reason: "finished" | "budget" | "failed" | "interrupted" | "cancelled"; turns: number; asked: string | null };
