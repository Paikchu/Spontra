import type { AiRunKind, AiRunStatus } from "../../../../shared/analysis-contract/ai-runs-admin.ts";
import type { SecPipelineEnv } from "../operations.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { AiRunStore, quietly } from "./store.ts";

type Run = { env: SecPipelineEnv; kind: AiRunKind; ticker: string; runId: string };
const store = (env: SecPipelineEnv) => env.DB ? new AiRunStore(env.DB) : null;
const now = () => new Date().toISOString();

/**
 * Logs each step as it starts. The record is written inside the durable step, so a replay, which
 * skips finished steps, never moves the shown stage backwards.
 */
export function trackSteps<S extends WorkflowStepLike>(steps: S, run: Run): S {
  return {
    ...steps,
    do: (name, callback) => steps.do(name, async (context) => {
      await quietly(async () => store(run.env)?.step(run.kind, run.ticker, run.runId, name, now(), context?.attempt));
      return callback(context);
    }),
  } as S;
}
export function trackSleep(sleep: (name: string, ms: number) => Promise<void>, run: Run): (name: string, ms: number) => Promise<void> {
  return async (name, ms) => {
    await quietly(async () => store(run.env)?.step(run.kind, run.ticker, run.runId, name, now(), undefined, "waiting"));
    await sleep(name, ms);
  };
}

const OUTCOME: Record<string, AiRunStatus> = { ready: "succeeded", complete: "succeeded", empty: "empty", superseded: "superseded" };

/** Marks the run running, then records how it ended; a failure is recorded and rethrown. */
export async function trackRun<T extends { status: string }>(run: Run, work: () => Promise<T>): Promise<T> {
  await quietly(async () => store(run.env)?.update(run.kind, run.ticker, run.runId, { status: "running" }, now()));
  try {
    const result = await work();
    await quietly(async () => store(run.env)?.finish(run.kind, run.ticker, run.runId, { status: OUTCOME[result.status] ?? "succeeded", result }, now()));
    return result;
  } catch (error) {
    await quietly(async () => store(run.env)?.finish(run.kind, run.ticker, run.runId, { status: "failed", error: error instanceof Error ? error.message : String(error) }, now()));
    throw error;
  }
}
