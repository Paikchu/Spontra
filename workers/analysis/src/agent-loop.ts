import { CALLS_PER_TURN, FAILED_REPLIES, replyFailure, replyText, toolCalls, type AgentAct, type AgentBlock, type AgentMessage, type ToolCall } from "./tool-loop.ts";
import { resultBlock, runTool, schemasFor, type AnyTool, type ToolOutcome, type ToolPolicy } from "./tools/registry.ts";

/**
 * One agent's loop, shared by every recipe (docs/stage-agent-design.md §2.1): the model replies, the harness runs the
 * calls it makes through the tool pipeline, and the results go back until a terminal tool settles the run or the
 * budget runs out. The exchange only grows: each reply goes back exactly as it came, thinking included.
 */
export type Recipe<I, O, S> = {
  id: string;
  budget: { turns: number; wallMs: number };
  system(input: I): string;
  open(input: I): S;
  tools(state: S): AnyTool<S>[];
  policy: ToolPolicy;
  /** True once a terminal tool has settled the run. */
  settled(state: S): boolean;
  settle(state: S, reason: "finished" | "budget" | "failed" | "interrupted" | "cancelled"): O;
  /** What the model is told when a reply calls no tool. */
  nudge: string;
};

export type TurnRecord = { turn: number; thought: string; action: string; input: string; observation: string };

/** Where the loop's effects go: the per-turn allowance, the trail, and how calls run. */
export type LoopHost<S> = {
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

/**
 * Runs the recipe over `messages`, which the caller owns: the stage keeps one array across a conversation, a
 * Workflow starts a new one. The caller pushes the opening user message before calling.
 */
export async function runAgentLoop<I, O, S>(recipe: Recipe<I, O, S>, input: I, state: S, messages: AgentMessage[], act: AgentAct, host: LoopHost<S>): Promise<LoopOutcome<O>> {
  const tools = recipe.tools(state);
  const schemas = schemasFor(tools, recipe.policy);
  const system = recipe.system(input);
  const started = host.now();
  let failed = 0, quiet = 0, turn = 0;
  const finish = (reason: LoopOutcome<O>["reason"], asked: string | null = null): LoopOutcome<O> => ({ output: recipe.settle(state, reason), reason, turns: turn, asked });
  while (turn < recipe.budget.turns) {
    if (host.signal.aborted) return finish("cancelled");
    if (host.now() - started > recipe.budget.wallMs) return finish("budget");
    if (!await host.reserve()) return finish("budget");
    turn++;
    const reply = await act(`${recipe.id}-t${turn}`, system, schemas, messages);
    const failure = replyFailure(reply);
    if (failure !== null || "error" in reply) {
      host.record({ turn, thought: "", action: "invalid", input: "", observation: String(failure).slice(0, 1000) });
      if (++failed >= FAILED_REPLIES) return finish("failed");
      continue;
    }
    failed = 0;
    messages.push({ role: "assistant", content: reply.content });
    const said = replyText(reply.content).slice(0, 600);
    const calls = toolCalls(reply.content);
    if (!calls.length) {
      host.record({ turn, thought: said, action: "none", input: "", observation: "The reply called no tool." });
      if (++quiet >= 2) return finish("failed");
      messages.push({ role: "user", content: recipe.nudge });
      continue;
    }
    quiet = 0;
    host.onToolStart?.(calls[0]!.name);
    const left = recipe.budget.turns - turn;
    const budgetLine = `Budget left: ${left} turn${left === 1 ? "" : "s"}.${left <= 1 ? " Finish now with what you have." : ""}`;
    const runnable = calls.slice(0, CALLS_PER_TURN);
    const outcomes = await host.execute(turn, runnable, call => {
      const index = runnable.indexOf(call);
      const stage = <T>(name: string, work: () => Promise<T>) => host.stage ? host.stage(`${recipe.id}-t${turn}-c${index}-${name}`, work) : work();
      return runTool(tools, recipe.policy, call, { state, signal: host.signal, recipe: recipe.id, stage });
    });
    const results: AgentBlock[] = [];
    let asked: string | null = null;
    calls.forEach((call, i) => {
      const outcome: ToolOutcome = i >= CALLS_PER_TURN ? { observation: `Not run: at most ${CALLS_PER_TURN} calls run per turn; call it again.`, error: true }
        : outcomes[i]!.asked ? { observation: "Waiting for the reader to confirm.", error: false } : outcomes[i]!;
      if (outcomes[i]?.asked && !asked) asked = outcomes[i]!.asked!;
      host.record({ turn, thought: i ? "" : said, action: call.name.slice(0, 40), input: JSON.stringify(call.input ?? {}).slice(0, 4000), observation: outcome.observation.slice(0, 4000) });
      results.push(resultBlock(call, { ...outcome, observation: outcome.observation.slice(0, 12_000) }, budgetLine));
    });
    messages.push({ role: "user", content: results });
    if (asked) return finish("finished", asked);
    if (recipe.settled(state)) return finish("finished");
  }
  return finish("budget");
}

/** Runs calls in order, one after another; the Workflow executor wraps each in a durable step. */
export const sequential = async (calls: ToolCall[], run: (call: ToolCall) => Promise<ToolOutcome>) => {
  const out: ToolOutcome[] = [];
  for (const call of calls) out.push(await run(call));
  return out;
};
