import type { WorkflowStepLike } from "../workflow-core.ts";
import type { PiOutcome } from "./host.ts";
import { packState, unpackState } from "./state.ts";

/** The Pi sessions of the run's own Agent, put on the env a durable run's task receives (durable-runs/runner.ts). */
export type PiRuns = {
  start(kind: string, spec: unknown, opening: string, options: { operationId: string }): Promise<{ operationId: string; session: string; refused?: "capped" }>;
  poll<O>(operationId: string): Promise<PiOutcome<O> | null>;
};

/** How often a run checks on a session it waits for when nothing woke it sooner. */
const RECHECK_MS = 30_000;

/**
 * One recipe run as a Pi session inside a durable run: started once, then waited for across wakes. The session's end
 * wakes the run at once; the outcome, recipe state included, is journalled as its own step.
 */
export async function runRecipeSession<O, S = unknown>(env: { PI?: PiRuns }, step: WorkflowStepLike, kind: string, spec: unknown, opening: string, operationId: string): Promise<PiOutcome<O> & { state: S }> {
  const pi = env.PI;
  if (!pi || !step.waitFor) throw new Error("Pi sessions run only inside a durable run");
  // A start the allowance refused settles at once on its budget; its outcome reads like any other.
  await step.do(`${operationId}:start`, () => pi.start(kind, spec, opening, { operationId }));
  const packed = await step.waitFor(`${operationId}:outcome`, async () => {
    const outcome = await pi.poll<O>(operationId);
    return outcome ? packState(outcome) : null;
  }, RECHECK_MS);
  return unpackState<PiOutcome<O> & { state: S }>(packed);
}

/** Runs one recipe session and returns its outcome; production runs it on Pi, a test on a scripted driver. */
export type SessionRunner = <O, S = unknown>(kind: string, spec: unknown, opening: string, operationId: string) => Promise<PiOutcome<O> & { state: S }>;

export const sessionRunner = (env: { PI?: PiRuns }, step: WorkflowStepLike): SessionRunner =>
  (kind, spec, opening, operationId) => runRecipeSession(env, step, kind, spec, opening, operationId);
