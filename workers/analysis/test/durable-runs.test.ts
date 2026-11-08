import assert from "node:assert/strict";
import test from "node:test";
import { invoke, NonRetryableError, SHARED_START_MS, type Journal, type RunStep, type StepRecord } from "../src/durable-runs/engine.ts";

function memory(): Journal & { rows: Map<string, StepRecord> } {
  const rows = new Map<string, StepRecord>();
  return { rows, step: (name) => rows.get(name), save: (record) => { rows.set(record.name, structuredClone(record)); } };
}
const clock = (start = 1_000_000) => { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

test("each wake runs one new step and replays finished ones from the journal", async () => {
  const journal = memory(), time = clock(), calls: string[] = [];
  const task = async (step: RunStep) => {
    const a = await step.do("a", async () => { calls.push("a"); return 1; });
    time.advance(SHARED_START_MS);
    const b = await step.do("b", async () => { calls.push("b"); return a + 1; });
    return { b };
  };
  assert.equal((await invoke(journal, task, time.now)).kind, "yield");
  const done = await invoke(journal, task, time.now);
  assert.deepEqual(done, { kind: "complete", output: { b: 2 } });
  assert.deepEqual(calls, ["a", "b"]);
});

test("parallel steps started together share one wake", async () => {
  const journal = memory(), time = clock();
  const task = async (step: RunStep) => Promise.all([step.do("x", async () => 1), step.do("y", async () => 2)]);
  assert.deepEqual(await invoke(journal, task, time.now), { kind: "complete", output: [1, 2] });
});

test("a failed step waits for its retry, then runs again with the next attempt", async () => {
  const journal = memory(), time = clock(), attempts: number[] = [];
  const task = (step: RunStep) => step.do("flaky", { retries: { limit: 2, delay: 1000, backoff: "constant" } }, async ({ attempt }) => {
    attempts.push(attempt);
    if (attempt < 2) throw new Error("boom");
    return "ok";
  });
  const first = await invoke(journal, task, time.now);
  assert.deepEqual(first, { kind: "yield", at: time.now() + 1000, waiting: false });
  assert.equal((await invoke(journal, task, time.now)).kind, "yield", "not before the retry time");
  time.advance(1000);
  assert.deepEqual(await invoke(journal, task, time.now), { kind: "complete", output: "ok" });
  assert.deepEqual(attempts, [1, 2]);
});

test("a non-retryable failure ends the run and replays as the same error", async () => {
  const journal = memory(), time = clock();
  let runs = 0;
  const task = async (step: RunStep) => {
    try { await step.do("bad", async () => { runs++; throw new NonRetryableError("HTTP 400"); }); }
    catch (error) { return { caught: (error as Error).name }; }
  };
  assert.deepEqual(await invoke(journal, task, time.now), { kind: "complete", output: { caught: "NonRetryableError" } });
  assert.deepEqual(await invoke(journal, task, time.now), { kind: "complete", output: { caught: "NonRetryableError" } });
  assert.equal(runs, 1);
  const uncaught = await invoke(memory(), (step) => step.do("bad", async () => { throw new NonRetryableError("no"); }), time.now);
  assert.deepEqual(uncaught, { kind: "errored", error: { name: "NonRetryableError", message: "no" } });
});

test("sleep waits until its wake time", async () => {
  const journal = memory(), time = clock();
  const task = async (step: RunStep) => { await step.sleep("pause", "1 minute"); return "awake"; };
  assert.deepEqual(await invoke(journal, task, time.now), { kind: "yield", at: time.now() + 60_000, waiting: true });
  time.advance(60_000);
  assert.deepEqual(await invoke(journal, task, time.now), { kind: "complete", output: "awake" });
});

test("waitFor checks back until the value is there, and retries a failed check before failing the run", async () => {
  const journal = memory(), time = clock();
  let answers: Array<string | null | Error> = [null, new Error("D1 blip"), "done"];
  const task = (step: RunStep) => step.waitFor("session", async () => { const next = answers.shift()!; if (next instanceof Error) throw next; return next; }, 1000);
  assert.deepEqual(await invoke(journal, task, time.now), { kind: "yield", at: time.now() + 1000, waiting: true });
  time.advance(1000);
  assert.deepEqual(await invoke(journal, task, time.now), { kind: "yield", at: time.now() + 1000, waiting: true }, "a failed check waits and tries again");
  assert.equal((await invoke(journal, task, time.now)).kind, "yield", "not before its retry time");
  time.advance(1000);
  assert.deepEqual(await invoke(journal, task, time.now), { kind: "complete", output: "done" });
  answers = [];
  const failing = memory();
  const broken = (step: RunStep) => step.waitFor("session", async () => { throw new Error("gone"); }, 1000);
  let last = await invoke(failing, broken, time.now);
  for (let i = 0; i < 10 && last.kind === "yield"; i++) { time.advance(60 * 60_000); last = await invoke(failing, broken, time.now); }
  assert.deepEqual(last, { kind: "errored", error: { name: "Error", message: "gone" } });
});
