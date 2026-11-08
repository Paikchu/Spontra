import { modelFor, reasoningFor } from "../ai-config.ts";
import type { AnalysisEnv } from "../operations.ts";
import type { PiLoaded } from "../pi/host.ts";
import { runRecipeSession } from "../pi/runs.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { browserRenderer } from "./draw.ts";
import { lensOpening, lensRecipe, type LensOutcome, type LensRunInput, type LensRunner } from "./agent.ts";

/** What one finding's lens session is rebuilt from: everything the recipe reads, as the findings run held it. */
type LensSpec = Pick<LensRunInput, "finding" | "resolved" | "periodEnd" | "catalogue" | "data"> & { ticker: string };
type LensState = ReturnType<ReturnType<typeof lensRecipe>["open"]>;

export async function lensLoader(spec: LensSpec, env: AnalysisEnv): Promise<PiLoaded<LensState>> {
  const input: LensRunInput = { ...spec, stage: (_name, work) => work(), ...(env.BROWSER ? { render: browserRenderer(env.BROWSER) } : {}) };
  return { recipe: lensRecipe(input), input, model: modelFor(env, "lens"), effort: reasoningFor(env, "lens"), ledger: { kind: "lens", ticker: spec.ticker } };
}

/** Each verified finding's lens as a Pi session of the findings run's Agent. */
export function piLensRunner(env: AnalysisEnv, step: WorkflowStepLike, ticker: string): LensRunner {
  return async (input): Promise<LensOutcome> => {
    const spec: LensSpec = { finding: input.finding, resolved: input.resolved, periodEnd: input.periodEnd, catalogue: input.catalogue, data: input.data, ticker };
    const outcome = await runRecipeSession<LensOutcome["document"], LensState>(env, step, "lens", spec, lensOpening(input), `lens-${input.finding.id}`);
    return { id: input.finding.id, document: outcome.output, turns: outcome.trail, warnings: outcome.state.accepted?.warnings ?? [] };
  };
}
