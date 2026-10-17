import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { driveWorkflow, FAILED_INPUT_RETRY_WAITS_MS, failedInputKey, failedInputOutcome, type FailedInput, type WorkflowBindingLike } from "../src/pipeline/workflow-task.ts";
import { FINANCIAL_TASKS } from "../src/pipeline/financial-tasks.ts";
import type { SecPipelineEnv } from "../src/operations.ts";

/** D1 over node:sqlite with every migration applied. */
function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8").replace(/--> statement-breakpoint/g, ""));
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => { sqlite.prepare(sql).run(...values as never[]); return { success: true }; },
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
    first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) ?? null) as T | null,
  });
  return { prepare: (sql: string) => statement(sql), batch: async (list: Array<{ run(): Promise<unknown> }>) => { for (const s of list) await s.run(); return []; } } as unknown as D1Database;
}

/** A Workflow binding whose instances report whatever status the test sets. */
function binding(statuses: Record<string, { status: string; error?: unknown }>): WorkflowBindingLike & { created: string[] } {
  const created: string[] = [];
  return {
    created,
    async create({ id }) { created.push(id); },
    async get(id) { return { status: async () => statuses[id] ?? { status: "running" } }; },
  };
}

const env = (db: D1Database) => ({ DB: db }) as unknown as SecPipelineEnv;
const now = new Date("2026-10-17T10:00:00.000Z");
const runOn = (fingerprint: string) => async () => ({ id: `run-${fingerprint}`, params: { fingerprint }, fingerprint });

test("a completed run is done when no trigger arrived meanwhile, and start is evaluated again when one did", async () => {
  const db = database();
  const statuses: Record<string, { status: string }> = {};
  const workflows = binding(statuses);
  const started = await driveWorkflow(env(db), "findings:MSFT", workflows, runOn("a"), { trigger: "event-1" });
  assert.equal(started.status, "later");
  assert.deepEqual(workflows.created, ["run-a"]);
  statuses["run-a"] = { status: "complete" };

  // The same trigger: the run covered it.
  const same = await driveWorkflow(env(db), "findings:MSFT", workflows, async () => { throw new Error("start must not run"); }, { trigger: "event-1" });
  assert.deepEqual(same, { status: "done", detail: { instanceId: "run-a", workflow: "complete" } });

  // A run started under one trigger and finished under another: start decides again, here with a new fingerprint.
  await driveWorkflow(env(db), "findings:MSFT", workflows, runOn("a"), { trigger: "event-1" });
  const moved = await driveWorkflow(env(db), "findings:MSFT", workflows, runOn("b"), { trigger: "event-2" });
  assert.equal(moved.status, "later");
  assert.deepEqual(workflows.created, ["run-a", "run-a", "run-b"]);

  // Nothing changed behind the new trigger: start returns null and the task is done.
  statuses["run-b"] = { status: "complete" };
  const unchanged = await driveWorkflow(env(db), "findings:MSFT", workflows, async () => null, { trigger: "event-3" });
  assert.deepEqual(unchanged, { status: "done", detail: { skipped: "nothing to run" } });
});

test("a failed model run is retried on the same input after growing waits, then dead-lettered once", async () => {
  const db = database();
  const statuses: Record<string, { status: string; error?: unknown }> = {};
  const workflows = binding(statuses);
  const deadLetter = { task: "tree" as const, ticker: "NET", causeId: "cause-1" };
  for (const [attempt, wait] of FAILED_INPUT_RETRY_WAITS_MS.entries()) {
    await driveWorkflow(env(db), "tree:NET", workflows, runOn("x"), { deadLetter, trigger: "event-1" });
    statuses["run-x"] = { status: "errored", error: { name: "Error", message: "provider 503" } };
    const outcome = await driveWorkflow(env(db), "tree:NET", workflows, runOn("x"), { deadLetter, trigger: "event-1" });
    assert.equal(outcome.status, "later");
    assert.equal((outcome as { afterMs: number }).afterMs, wait);
    const failed = JSON.parse((await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = ?").bind(failedInputKey("tree", "NET")).first<{ payload: string }>())!.payload) as FailedInput;
    assert.equal(failed.attempts, attempt + 1);
    assert.ok(failed.retryAt);
    // Before the retry time the task waits; once it has passed, the run may start.
    const waiting = await failedInputOutcome(env(db), "tree", "NET", "x", new Date());
    assert.equal(waiting?.status, "later");
    assert.equal(await failedInputOutcome(env(db), "tree", "NET", "x", new Date(Date.parse(failed.retryAt!) + 1)), null);
    // A different input is never held back by this failure.
    assert.equal(await failedInputOutcome(env(db), "tree", "NET", "y", new Date()), null);
  }
  // The retries are spent: this failure is a dead letter and the input stays until the admin replays it.
  await driveWorkflow(env(db), "tree:NET", workflows, runOn("x"), { deadLetter, trigger: "event-1" });
  const dead = await driveWorkflow(env(db), "tree:NET", workflows, runOn("x"), { deadLetter, trigger: "event-1" });
  assert.equal(dead.status, "done");
  const rows = (await db.prepare("SELECT name, ticker, attempts FROM pipeline_dead").all<{ name: string; ticker: string; attempts: number }>()).results;
  assert.deepEqual(rows.map(row => ({ ...row })), [{ name: "tree", ticker: "NET", attempts: FAILED_INPUT_RETRY_WAITS_MS.length }]);
  const spent = await failedInputOutcome(env(db), "tree", "NET", "x", new Date("2030-01-01T00:00:00.000Z"));
  assert.equal(spent?.status, "done");
});

test("a failure the Workflow declared final is a dead letter at once", async () => {
  const db = database();
  const workflows = binding({ "run-x": { status: "errored", error: { name: "NonRetryableError", message: "[invalid_request] 400" } } });
  const deadLetter = { task: "explainer" as const, ticker: "NET", causeId: "cause-1" };
  await driveWorkflow(env(db), "explainer:NET", workflows, runOn("x"), { deadLetter, trigger: "event-1" });
  const dead = await driveWorkflow(env(db), "explainer:NET", workflows, runOn("x"), { deadLetter, trigger: "event-1" });
  assert.equal(dead.status, "done");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM pipeline_dead").first<{ n: number }>())!.n, 1);
  assert.equal((await failedInputOutcome(env(db), "explainer", "NET", "x", now))?.status, "done");
});

test("a failed-input record written before retries existed reads as spent", async () => {
  const db = database();
  await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)").bind(failedInputKey("findings", "ORCL"), JSON.stringify({ fingerprint: "old", instanceId: "i" }), now.toISOString()).run();
  assert.equal((await failedInputOutcome(env(db), "findings", "ORCL", "old", now))?.status, "done");
});

test("paused collection waits instead of finishing, so the filing is collected once collection resumes", async () => {
  const context = { causeId: "m1", now, trigger: "event-1" };
  const paused = { DB: database(), SEC_DATA_COLLECTION_ENABLED: "false" } as unknown as SecPipelineEnv;
  for (const task of [FINANCIAL_TASKS.collect, FINANCIAL_TASKS.history]) {
    const outcome = await task.run(paused, "MSFT", context);
    assert.equal(outcome.status, "later");
    assert.equal((outcome as { afterMs: number }).afterMs, 60 * 60_000);
  }
});
