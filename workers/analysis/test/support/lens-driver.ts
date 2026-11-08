import { lensOpening, lensRecipe, type LensModel, type LensOutcome, type LensRunInput, type LensTurn } from "../../src/lens/agent.ts";
import type { AgentAct, AgentMessage } from "../../src/tool-loop.ts";
import { runAgentLoop, sequential, type LoopHost } from "./recipe-driver.ts";

/** One finding's lens on the scripted driver, its model the test's. */
export async function runLensAgent(input: LensRunInput & { model: LensModel }): Promise<LensOutcome> {
  const recipe = lensRecipe(input);
  const state = recipe.open(input);
  const turns: LensTurn[] = [];
  const messages: AgentMessage[] = [{ role: "user", content: lensOpening(input) }];
  const act: AgentAct = (stage, system, tools, msgs) => input.stage(`${stage}-act`, () => input.model(`lens-${stage.replace(/-t(\d+)$/, "-$1")}`, system, tools, msgs));
  const host: LoopHost = {
    reserve: async () => true, record: turn => { turns.push(turn); }, execute: (_t, calls, run) => sequential(calls, run),
    signal: new AbortController().signal, now: () => 0, stage: input.stage,
  };
  const outcome = await runAgentLoop(recipe, input, state, messages, act, host);
  return { id: input.finding.id, document: outcome.output, turns, warnings: state.accepted?.warnings ?? [] };
}
