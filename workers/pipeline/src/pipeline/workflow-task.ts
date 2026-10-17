import { D1SecRepository } from "../sec/d1.ts";
import type { SecPipelineEnv } from "../operations.ts";
import type { TaskMessage } from "./messages.ts";
import type { TaskName } from "./registry.ts";
import type { TaskOutcome } from "./tasks.ts";

type Instance = { status(): Promise<{ status: string; error?: unknown }> };
export type WorkflowBindingLike = { create(options: { id: string; params: unknown }): Promise<unknown>; get?(id: string): Promise<Instance> };
/** `trigger`: the due row's cause when the run started; a different cause at completion means a new trigger arrived meanwhile. */
type Started = { instanceId: string; startedAt: string; fingerprint?: string; trigger?: string | null };

const RUNNING = new Set(["queued", "running", "paused", "waiting", "waitingForPause", "unknown"]);
const errorText = (error: unknown) => typeof error === "string" ? error : (error as { message?: string } | undefined)?.message ?? "";
const errorName = (error: unknown) => (error as { name?: string } | undefined)?.name ?? "";

/** Where a failed model run is recorded instead of retried: a dead letter the admin can replay. */
export type DeadLetterTarget = { task: TaskName; ticker: string; causeId: string };
/** The input a model run failed on; the same input is not run again until it changes or the dead letter is replayed. */
export const failedInputKey = (task: string, ticker: string) => `pipeline:workflow-failed:${task}:${ticker}`;
/**
 * What is known about the last failure on an input: how many runs failed on it in a row, and when the next automatic
 * retry may start (`null` once the retries are spent or the failure was final, when only an admin replay runs it again).
 */
export type FailedInput = { fingerprint: string; instanceId: string; failure: string; attempts: number; retryAt: string | null };
/** Waits before each automatic retry of a run that failed on the same input; after the last one the run is a dead letter. */
export const FAILED_INPUT_RETRY_WAITS_MS = [60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000] as const;

/**
 * Whether a run on this input may start now: null when it may (it never failed on this input, or its retry time has
 * come), otherwise the outcome to return instead — wait until the retry time, or stay done until the dead letter is
 * replayed. A record written before retries existed carries no `retryAt` and reads as spent.
 */
export async function failedInputOutcome(env: SecPipelineEnv, task: string, ticker: string, fingerprint: string, now: Date): Promise<TaskOutcome | null> {
  const failed = (await new D1SecRepository(env.DB!).getCache<FailedInput>(failedInputKey(task, ticker)))?.payload;
  if (!failed || failed.fingerprint !== fingerprint) return null;
  if (!failed.retryAt) return { status: "done", detail: { skipped: "failed on this input before; replay the dead letter to retry", attempts: failed.attempts ?? null } };
  const wait = Date.parse(failed.retryAt) - now.getTime();
  if (wait > 0) return { status: "later", afterMs: wait, detail: { waiting: "retry of a failed run", retryAt: failed.retryAt, attempts: failed.attempts } };
  return null;
}

/**
 * Starts a Workflow for a task and follows it until it ends: while it runs the task checks back every `pollMs`. When
 * the instance completes, the task is done unless a new trigger arrived during the run (the due row's cause moved
 * from `trigger`): then `start` is evaluated again at once, so a filing or input change that landed mid-run is not
 * taken for handled. A failed instance either fails the task, so the queue retries with a new instance and dead-letters
 * it after its retries, or, with `deadLetter`, is retried on the same input after a growing wait
 * (`FAILED_INPUT_RETRY_WAITS_MS`) and only then recorded as a dead letter for a person to replay; a failure the
 * Workflow declared final (`NonRetryableError`, a terminated instance) is a dead letter at once. `start` returns null
 * when there is nothing to run, or an outcome to defer.
 */
export async function driveWorkflow(env: SecPipelineEnv, key: string, binding: WorkflowBindingLike | undefined,
  start: () => Promise<{ id: string; params: unknown; fingerprint?: string } | TaskOutcome | null>,
  options: { pollMs?: number; deadLetter?: DeadLetterTarget; trigger?: string | null } = {}): Promise<TaskOutcome> {
  const pollMs = options.pollMs ?? 5 * 60_000;
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
    if (state.status === "complete") {
      // A run started from an older trigger: whatever arrived since is checked now, not at the next unrelated event.
      const retriggered = started.trigger !== undefined && started.trigger !== (options.trigger ?? null);
      if (!retriggered) return { status: "done", detail: { instanceId: started.instanceId, workflow: "complete" } };
    } else {
      const failure = `Workflow ${started.instanceId} ${state.status}${errorText(state.error) ? `: ${errorText(state.error).slice(0, 300)}` : ""}`;
      if (!options.deadLetter) throw new Error(failure);
      const { task, ticker, causeId } = options.deadLetter, at = new Date().toISOString();
      const previous = started.fingerprint ? (await repository.getCache<FailedInput>(failedInputKey(task, ticker)))?.payload : undefined;
      const attempts = previous?.fingerprint === started.fingerprint ? (previous?.attempts ?? 1) + 1 : 1;
      const final = state.status === "terminated" || errorName(state.error) === "NonRetryableError";
      const wait = !final && started.fingerprint ? FAILED_INPUT_RETRY_WAITS_MS[attempts - 1] : undefined;
      if (wait !== undefined) {
        const retryAt = new Date(Date.now() + wait).toISOString();
        console.warn(JSON.stringify({ event: "pipeline-retry", task, ticker, attempts, retryAt, failure }));
        await repository.setCache(failedInputKey(task, ticker), { fingerprint: started.fingerprint!, instanceId: started.instanceId, failure, attempts, retryAt } satisfies FailedInput, at);
        return { status: "later", afterMs: wait, detail: { instanceId: started.instanceId, workflow: state.status, retry: attempts, retryAt } };
      }
      const id = crypto.randomUUID();
      const body: TaskMessage = { v: 1, kind: "task", id, causeId, task, ticker, dueAt: at };
      console.error(JSON.stringify({ event: "pipeline-dead", task, ticker, attempts, failure }));
      await env.DB!.batch([
        env.DB!.prepare("INSERT INTO pipeline_dead (id, kind, name, ticker, body, attempts, created_at) VALUES (?, 'task', ?, ?, ?, ?, ?)")
          .bind(id, task, ticker, JSON.stringify(body), attempts - 1, at),
        ...(started.fingerprint ? [env.DB!.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
          .bind(failedInputKey(task, ticker), JSON.stringify({ fingerprint: started.fingerprint, instanceId: started.instanceId, failure, attempts, retryAt: null } satisfies FailedInput), at)] : []),
      ]);
      return { status: "done", detail: { instanceId: started.instanceId, workflow: state.status, deadLetter: id, attempts } };
    }
  }
  const next = await start();
  if (!next) return { status: "done", detail: { skipped: "nothing to run" } };
  if ("status" in next) return next;
  try { await binding.create({ id: next.id, params: next.params }); }
  catch (error) { if (!/already exists|duplicate/i.test(String(error))) throw error; }
  await repository.setCache(cacheKey, { instanceId: next.id, startedAt: new Date().toISOString(), trigger: options.trigger ?? null, ...(next.fingerprint ? { fingerprint: next.fingerprint } : {}) } satisfies Started, new Date().toISOString());
  return { status: "later", afterMs: pollMs, detail: { instanceId: next.id, workflow: "started" } };
}
