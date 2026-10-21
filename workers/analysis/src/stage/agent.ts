import { Agent } from "agents";
import type { AnalysisEnv } from "../operations.ts";

/**
 * One reader's conversation with the stage (docs/stage-agent-design.md §5.3). The class lands before any route reaches
 * it: a Durable Object class migration cannot be rolled back, so it ships on its own and is never renamed or deleted.
 * Nothing addresses it yet; the gateway that does arrives with the stage feature switch.
 */
export type StageState = { revision: number };
/** The Agents SDK types its environment as the generated `Env`; the stage reads the analysis environment on top of it. */
export type StageEnv = Env & AnalysisEnv;

export class StageAgent extends Agent<StageEnv, StageState> {
  initialState: StageState = { revision: 0 };
}
