/**
 * A scripted driver for recipe tests: the loop the recipes ran on before Pi, with the model replaced by the test's
 * replies. Production runs every recipe as a Pi session (src/pi/host.ts); this exercises a recipe's tools, policy and
 * settlement without a Durable Object.
 */
import { nativeSearches, NATIVE_SEARCH_INSTRUCTION } from "../../src/web-search/native.ts";
import { CALLS_PER_TURN, FAILED_REPLIES, replyFailure, replyText, toolCalls, type AgentAct, type AgentBlock, type AgentMessage, type ToolCall } from "../../src/tool-loop.ts";
import { resultBlock, runTool, schemasFor, type AnyTool, type ToolOutcome, type ToolPolicy } from "../../src/tools/registry.ts";

export type { Recipe, TurnRecord, LoopHost, LoopOutcome } from "../../src/recipe.ts";
import { defaultBudgetLine, type Recipe, type LoopHost, type LoopOutcome } from "../../src/recipe.ts";

/**
 * Runs the recipe over `messages`, which the caller owns: the stage keeps one array across a conversation, a
 * Workflow starts a new one. The caller pushes the opening user message before calling.
 */
export async function runAgentLoop<I, O, S>(recipe: Recipe<I, O, S>, input: I, state: S, messages: AgentMessage[], act: AgentAct, host: LoopHost): Promise<LoopOutcome<O>> {
  const tools = recipe.tools(state);
  const native = tools.find(t => t.nativeSearch && recipe.policy.allow.includes(t.name));
  const system = recipe.system(input) + (native ? `\n${NATIVE_SEARCH_INSTRUCTION}` : "");
  const started = host.now();
  let failed = 0, quiet = 0, turn = 0;
  const finish = (reason: LoopOutcome<O>["reason"], asked: string | null = null): LoopOutcome<O> => ({ output: recipe.settle(state, reason), reason, turns: turn, asked });
  while (turn < recipe.budget.turns) {
    if (host.signal.aborted) return finish("cancelled");
    if (host.now() - started > recipe.budget.wallMs) return finish("budget");
    if (!await host.reserve()) return finish("budget");
    turn++;
    recipe.onTurn?.(state, turn);
    const reply = await act(`${recipe.id}-t${turn}`, system, schemasFor(tools, recipe.policy, state), messages);
    const failure = replyFailure(reply);
    if (failure !== null || "error" in reply) {
      host.record({ turn, thought: "", action: "invalid", input: "", observation: String(failure).slice(0, 1000) });
      if (++failed >= FAILED_REPLIES) return finish("failed");
      continue;
    }
    failed = 0;
    messages.push({ role: "assistant", content: reply.content });
    const webNotes: AgentBlock[] = [];
    if (native) for (const batch of nativeSearches(reply.content)) {
      const outcome = await runTool(tools, recipe.policy, { name: native.name, input: batch }, { state, signal: host.signal, recipe: recipe.id, stage: (name, work) => host.stage ? host.stage(`${recipe.id}-t${turn}-native-${name}`, work) : work() });
      host.record({ turn, thought: "", action: "web_search", input: batch.query, observation: outcome.observation.slice(0, 4000) });
      webNotes.push({ type: "text", text: outcome.observation });
    }
    const said = replyText(reply.content).slice(0, 600);
    const calls = toolCalls(reply.content);
    if (!calls.length && webNotes.length) {
      quiet = 0; messages.push({ role: "user", content: [...webNotes, { type: "text", text: recipe.nudge }] }); continue;
    }
    if (!calls.length) {
      host.record({ turn, thought: said, action: "none", input: "", observation: "The reply called no tool." });
      if (++quiet >= 2) return finish("failed");
      messages.push({ role: "user", content: recipe.nudge });
      continue;
    }
    quiet = 0;
    host.onToolStart?.(calls[0]!.name);
    const runnable = calls.slice(0, CALLS_PER_TURN);
    const outcomes = await host.execute(turn, runnable, call => {
      const index = runnable.indexOf(call);
      const stage = <T>(name: string, work: () => Promise<T>) => host.stage ? host.stage(`${recipe.id}-t${turn}-c${index}-${name}`, work) : work();
      return runTool(tools, recipe.policy, call, { state, signal: host.signal, recipe: recipe.id, stage });
    });
    // Written after the calls ran, as the Pi host writes it, so it counts what they spent.
    const left = recipe.budget.turns - turn;
    const budgetLine = recipe.budgetLine?.(state, left) ?? defaultBudgetLine(left);
    const results: AgentBlock[] = [];
    let asked: string | null = null;
    calls.forEach((call, i) => {
      const outcome: ToolOutcome = i >= CALLS_PER_TURN ? { observation: `Not run: at most ${CALLS_PER_TURN} calls run per turn; call it again.`, error: true }
        : outcomes[i]!.asked ? { observation: "Waiting for the reader to confirm.", error: false } : outcomes[i]!;
      if (outcomes[i]?.asked && !asked) asked = outcomes[i]!.asked!;
      host.record({ turn, thought: i ? "" : said, action: call.name.slice(0, 40), input: JSON.stringify(call.input ?? {}).slice(0, 4000), observation: outcome.observation.slice(0, 4000) });
      results.push(resultBlock(call, { ...outcome, observation: outcome.observation.slice(0, 12_000) }, budgetLine));
    });
    messages.push({ role: "user", content: [...results, ...webNotes] });
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

/**
 * A `SessionRunner` on this driver: the session's loader rebuilds the recipe from its spec, as the Pi host does, and
 * the test's replies stand in for the model.
 */
export function scriptedRunner(load: (kind: string, spec: unknown) => Promise<import("../../src/pi/host.ts").PiLoaded>, act: AgentAct): import("../../src/pi/runs.ts").SessionRunner {
  return async <O, S>(kind: string, spec: unknown, opening: string) => {
    const loaded = await load(kind, spec);
    const state = loaded.recipe.open(loaded.input);
    loaded.hydrate?.(state);
    const trail: import("../../src/recipe.ts").TurnRecord[] = [];
    let capped = false;
    const host: LoopHost = {
      reserve: async () => { if (!loaded.reserve || await loaded.reserve(state)) return true; capped = true; return false; },
      record: (entry) => { trail.push(entry); loaded.record?.(entry); }, execute: (_t, calls, run) => sequential(calls, run),
      signal: new AbortController().signal, now: () => 0,
    };
    const outcome = await runAgentLoop(loaded.recipe, loaded.input, state, [{ role: "user", content: opening }], act, host);
    return { ...outcome, output: outcome.output as O, capped, trail, state: state as S };
  };
}
