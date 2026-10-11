import { D1SecRepository } from "../sec/d1.ts";
import type { SecPipelineEnv } from "../operations.ts";
import type { TaskOutcome } from "./tasks.ts";

type Instance = { status(): Promise<{ status: string; error?: unknown }> };
export type WorkflowBindingLike = { create(options: { id: string; params: unknown }): Promise<unknown>; get?(id: string): Promise<Instance> };
type Started = { instanceId: string; startedAt: string };

const RUNNING = new Set(["queued", "running", "paused", "waiting", "waitingForPause", "unknown"]);
const errorText = (error: unknown) => typeof error === "string" ? error : (error as { message?: string } | undefined)?.message ?? "";

/**
 * Starts a Workflow for a task and follows it until it ends: while it runs the task checks back every `pollMs`, a
 * completed instance finishes the task, and a failed one fails it so the queue retries with a new instance and,
 * after its retries, dead-letters it. `start` returns null when there is nothing to run, or an outcome to defer.
 */
export async function driveWorkflow(env: SecPipelineEnv, key: string, binding: WorkflowBindingLike | undefined,
  start: () => Promise<{ id: string; params: unknown } | TaskOutcome | null>, pollMs = 5 * 60_000): Promise<TaskOutcome> {
  if (!binding) return { status: "done", detail: { skipped: "workflow not configured" } };
  const repository = new D1SecRepository(env.DB!);
  const cacheKey = `pipeline:workflow:${key}`;
  const started = (await repository.getCache<Started>(cacheKey))?.payload;
  if (started && binding.get) {
    let state: { status: string; error?: unknown };
    try { state = await (await binding.get(started.instanceId)).status(); }
    catch { state = { status: "unknown" }; }
    if (RUNNING.has(state.status) && (state.status !== "unknown" || Date.now() - Date.parse(started.startedAt) < 60 * 60_000)) {
      return { status: "later", afterMs: pollMs, detail: { instanceId: started.instanceId, workflow: state.status } };
    }
    await env.DB!.prepare("DELETE FROM sec_cache WHERE cache_key = ?").bind(cacheKey).run();
    if (state.status === "complete") return { status: "done", detail: { instanceId: started.instanceId, workflow: "complete" } };
    throw new Error(`Workflow ${started.instanceId} ${state.status}${errorText(state.error) ? `: ${errorText(state.error).slice(0, 300)}` : ""}`);
  }
  const next = await start();
  if (!next) return { status: "done", detail: { skipped: "nothing to run" } };
  if ("status" in next) return next;
  try { await binding.create({ id: next.id, params: next.params }); }
  catch (error) { if (!/already exists|duplicate/i.test(String(error))) throw error; }
  await repository.setCache(cacheKey, { instanceId: next.id, startedAt: new Date().toISOString() } satisfies Started, new Date().toISOString());
  return { status: "later", afterMs: pollMs, detail: { instanceId: next.id, workflow: "started" } };
}
