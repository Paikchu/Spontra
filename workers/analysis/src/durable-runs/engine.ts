/**
 * Durable runs: the step journal that replaces Cloudflare Workflows. A run is one Durable Object (`TaskRunner`); its
 * task function is executed again from the top on every wake, finished steps return their journalled result, and a
 * new step runs only in an invocation of its own, so each step gets the CPU and wall budget of a fresh alarm.
 *
 * A step that is not allowed to run now (its invocation already ran one, a retry wait, a sleep) returns a promise
 * that never settles, so task code cannot catch it as an error; the runner sees the yield, sets the alarm and lets
 * the abandoned execution be collected.
 */

export type Duration = number | `${number} ${"second" | "seconds" | "minute" | "minutes" | "hour" | "hours" | "day" | "days"}`;
export type StepConfig = {
  retries?: { limit: number; delay: Duration | ((options: { ctx: StepContext }) => number); backoff?: "constant" | "linear" | "exponential" };
  timeout?: Duration;
};
export type StepContext = { attempt: number };

/** The step interface every task is written against; the same surface the Workflow `step` had. */
export type RunStep = {
  do<T>(name: string, callback: (context: StepContext) => Promise<T>): Promise<T>;
  do<T>(name: string, config: StepConfig, callback: (context: StepContext) => Promise<T>): Promise<T>;
  sleep(name: string, duration: Duration): Promise<void>;
  /**
   * Checks `check` until it returns a value, waking every `recheck` in between (or sooner, when the runner is woken);
   * the value is journalled like a step's result. For work that runs outside the step, such as a Pi session.
   */
  waitFor<T>(name: string, check: () => Promise<T | null>, recheck: Duration): Promise<T>;
};

/** A failure retries cannot fix; the run ends at once. The name is what the task router checks. */
export class NonRetryableError extends Error {
  constructor(message: string) { super(message); this.name = "NonRetryableError"; }
}

export type RunStatus = "queued" | "running" | "waiting" | "complete" | "errored" | "terminated";
export type RunState = { status: RunStatus; error?: { name: string; message: string }; output?: unknown };

/** One journal row per step name: its result once done, or its failed attempts and when the next may start. */
export type StepRecord = { name: string; done: boolean; value?: unknown; attempts: number; retryAt?: number; wakeAt?: number; error?: { name: string; message: string } };
export type Journal = {
  step(name: string): StepRecord | undefined;
  save(record: StepRecord): void;
};

/** Steps that start within this window of the first one share its invocation, so parallel steps stay parallel. */
const SHARED_START_MS = 20_000;
/** Failed checks of a `waitFor` in a row before the run fails. */
const WAIT_CHECK_RETRIES = 5;
/** An alarm may run 15 minutes; a step is cut before that so the invocation can record the failure. */
export const STEP_TIMEOUT_CAP_MS = 13 * 60_000;
const DEFAULT_CONFIG = { retries: { limit: 5, delay: 10_000 as Duration, backoff: "exponential" as const }, timeout: "10 minutes" as Duration };

export function durationMs(value: Duration): number {
  if (typeof value === "number") return value;
  const [amount, unit] = value.split(" ");
  const scale = unit.startsWith("second") ? 1000 : unit.startsWith("minute") ? 60_000 : unit.startsWith("hour") ? 3_600_000 : 86_400_000;
  return Number(amount) * scale;
}

function retryDelay(config: StepConfig, attempt: number): number {
  const retries = config.retries ?? DEFAULT_CONFIG.retries;
  if (typeof retries.delay === "function") return retries.delay({ ctx: { attempt } });
  const base = durationMs(retries.delay);
  return retries.backoff === "exponential" ? base * 2 ** (attempt - 1) : retries.backoff === "linear" ? base * attempt : base;
}

const never = <T>() => new Promise<T>(() => {});

/** What one invocation of a run ended with. */
export type Invocation = { kind: "complete"; output: unknown } | { kind: "errored"; error: { name: string; message: string } }
  | { kind: "yield"; at: number; waiting: boolean };

export async function invoke(journal: Journal, task: (step: RunStep) => Promise<unknown>, now: () => number = Date.now): Promise<Invocation> {
  let firstStart: number | undefined;
  let signal!: (yielded: { at: number; waiting: boolean }) => void;
  const yielded = new Promise<{ at: number; waiting: boolean }>((resolve) => { signal = resolve; });
  let stopped = false;
  const stop = <T>(at: number, waiting = false): Promise<T> => { stopped = true; signal({ at, waiting }); return never<T>(); };
  const mayStart = () => !stopped && (firstStart === undefined || now() - firstStart < SHARED_START_MS);

  async function run<T>(name: string, config: StepConfig, callback: (context: StepContext) => Promise<T>): Promise<T> {
    const record = journal.step(name);
    if (record?.done) return record.value as T;
    // A step that failed for good fails the same way on every replay; task code that caught it continues the same way.
    if (record?.error) throw Object.assign(new Error(record.error.message), { name: record.error.name });
    if (record?.retryAt && record.retryAt > now()) return stop(record.retryAt);
    if (!mayStart()) return stop(now());
    firstStart ??= now();
    const attempt = (record?.attempts ?? 0) + 1;
    const timeout = Math.min(durationMs(config.timeout ?? DEFAULT_CONFIG.timeout), STEP_TIMEOUT_CAP_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        callback({ attempt }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`step ${name} timed out after ${Math.round(timeout / 1000)}s`)), timeout); }),
      ]);
      journal.save({ name, done: true, value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)), attempts: attempt });
      return value;
    } catch (error) {
      const limit = (config.retries ?? DEFAULT_CONFIG.retries).limit;
      if (error instanceof Error && error.name === "NonRetryableError" || attempt > limit) {
        journal.save({ name, done: false, attempts: attempt, error: errorOf(error) });
        throw error;
      }
      const retryAt = now() + retryDelay(config, attempt);
      journal.save({ name, done: false, attempts: attempt, retryAt });
      console.warn(JSON.stringify({ event: "run-step-retry", step: name, attempt, retryAt: new Date(retryAt).toISOString(), error: error instanceof Error ? error.message.slice(0, 300) : String(error) }));
      return stop(retryAt);
    } finally { clearTimeout(timer); }
  }

  const step: RunStep = {
    do<T>(name: string, configOrCallback: StepConfig | ((context: StepContext) => Promise<T>), maybeCallback?: (context: StepContext) => Promise<T>) {
      return typeof configOrCallback === "function" ? run(name, DEFAULT_CONFIG, configOrCallback) : run(name, configOrCallback, maybeCallback!);
    },
    async sleep(name: string, duration: Duration) {
      const record = journal.step(name);
      if (record?.done) return;
      const wakeAt = record?.wakeAt ?? now() + durationMs(duration);
      if (wakeAt <= now()) { journal.save({ name, done: true, attempts: 0 }); return; }
      if (!record) journal.save({ name, done: false, attempts: 0, wakeAt });
      return stop<void>(wakeAt, true);
    },
    async waitFor<T>(name: string, check: () => Promise<T | null>, recheck: Duration): Promise<T> {
      const record = journal.step(name);
      if (record?.done) return record.value as T;
      if (record?.retryAt && record.retryAt > now()) return stop<T>(record.retryAt, true);
      if (!mayStart()) return stop<T>(now());
      firstStart ??= now();
      let value: T | null;
      try { value = await check(); }
      catch (error) {
        // A failed check (a store or provider hiccup) is tried again on later wakes; the run fails only when it keeps failing.
        const attempts = (record?.attempts ?? 0) + 1;
        if (attempts > WAIT_CHECK_RETRIES) throw error;
        const retryAt = now() + Math.min(durationMs(recheck) * 2 ** (attempts - 1), 30 * 60_000);
        journal.save({ name, done: false, attempts, retryAt });
        console.warn(JSON.stringify({ event: "run-wait-retry", step: name, attempts, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }));
        return stop<T>(retryAt, true);
      }
      if (value !== null) {
        journal.save({ name, done: true, value: JSON.parse(JSON.stringify(value)), attempts: 0 });
        return value;
      }
      return stop<T>(now() + durationMs(recheck), true);
    },
  } as RunStep;

  const outcome = await Promise.race([
    task(step).then((output) => ({ kind: "complete" as const, output }), (error: unknown) => ({ kind: "errored" as const, error: errorOf(error) })),
    yielded.then((at) => ({ kind: "yield" as const, ...at })),
  ]);
  // A task that returned while another branch had yielded still has unfinished steps; it is not complete yet.
  if (outcome.kind === "complete" && stopped) return { kind: "yield", at: now(), waiting: false };
  return outcome;
}

function errorOf(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message.slice(0, 4000) } : { name: "Error", message: String(error).slice(0, 4000) };
}
