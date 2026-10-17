import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SEC_TASKS } from "../src/pipeline/sec-tasks.ts";
import { driveWorkflow, failedInputKey, type WorkflowBindingLike } from "../src/pipeline/workflow-task.ts";
import { contextOverflow } from "../src/model-recovery.ts";
import type { SecPipelineEnv } from "../src/operations.ts";

/** D1 over node:sqlite with every migration applied. */
function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8").replace(/--> statement-breakpoint/g, ""));
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => { sqlite.prepare(sql).run(...values as never[]); return { success: true }; },
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]).map(r => ({ ...r })) as T[] }),
    first: async <T>() => { const row = sqlite.prepare(sql).get(...values as never[]); return (row ? { ...row } : null) as T | null; },
  });
  return { prepare: (sql: string) => statement(sql), batch: async (list: Array<{ run(): Promise<unknown> }>) => { for (const s of list) await s.run(); return []; } } as unknown as D1Database;
}

function binding(statuses: Record<string, { status: string; error?: unknown }>): WorkflowBindingLike & { created: string[] } {
  const created: string[] = [];
  return { created, async create({ id }) { created.push(id); }, async get(id) { if (!(id in statuses) && !created.includes(id)) throw new Error("instance.not_found"); return { status: async () => statuses[id] ?? { status: "running" } }; } };
}
const failedJob = (db: D1Database, instanceId: string, accession: string) => db.prepare(`INSERT INTO sec_analysis_jobs (job_id, ticker, accession_number, analysis_version, status, current_stage, error_code, requested_by, workflow_instance_id)
  VALUES (?, 'NBIS', ?, 'v', 'failed', 'editorial-review', 'editorial_quality_failed', 'scheduled', ?)`).bind(`job-${instanceId}-${accession}`, accession, instanceId).run();
const readFailed = async (db: D1Database, task: string, ticker: string) => {
  const row = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = ?").bind(failedInputKey(task, ticker)).first<{ payload: string }>();
  return row ? JSON.parse(row.payload) as { attempts: number; retryAt: string | null; fingerprint: string } : null;
};

test("a finished SEC report run that failed on a filing is retried after a wait, and a clean run clears the record", async () => {
  const db = database();
  const statuses: Record<string, { status: string }> = {};
  const workflows = binding(statuses);
  const env = { DB: db, SEC_ANALYSIS_WORKFLOW: workflows } as unknown as SecPipelineEnv;
  const context = (now: Date) => ({ causeId: "m1", now, trigger: "e1" });
  const t0 = new Date();

  assert.equal((await SEC_TASKS["sec-report"].run(env, "NBIS", context(t0))).status, "later");
  const first = workflows.created[0]!;
  statuses[first] = { status: "complete" };
  await failedJob(db, first, "0001-26-000001");
  const failed = await SEC_TASKS["sec-report"].run(env, "NBIS", context(t0));
  assert.equal(failed.status, "later");
  assert.equal((failed as { afterMs: number }).afterMs, 60 * 60_000);
  const record = await readFailed(db, "sec-report", "NBIS");
  assert.deepEqual({ fingerprint: record?.fingerprint, attempts: record?.attempts, scheduled: !!record?.retryAt }, { fingerprint: "0001-26-000001", attempts: 1, scheduled: true });

  // Before the retry time a new trigger waits; once it has passed, a new run starts.
  const early = await SEC_TASKS["sec-report"].run(env, "NBIS", context(new Date(t0.getTime() + 60_000)));
  assert.equal((early.detail as { waiting?: string }).waiting, "retry of a failed run");
  assert.equal(workflows.created.length, 1);
  assert.equal((await SEC_TASKS["sec-report"].run(env, "NBIS", context(new Date(t0.getTime() + 2 * 60 * 60_000)))).status, "later");
  assert.equal(workflows.created.length, 2);

  // The retry analyses the filing cleanly: done, and the failure record is gone.
  statuses[workflows.created[1]!] = { status: "complete" };
  const clean = await SEC_TASKS["sec-report"].run(env, "NBIS", context(new Date(t0.getTime() + 2 * 60 * 60_000)));
  assert.equal(clean.status, "done");
  assert.equal(await readFailed(db, "sec-report", "NBIS"), null);
});

test("a model provider refusing for balance (HTTP 402) is retried even though the step declared it final", async () => {
  const db = database();
  const workflows = binding({ "run-x": { status: "errored", error: { name: "NonRetryableError", message: "Model deepseek-flash tree-plan HTTP 402: Insufficient Balance" } } });
  const env = { DB: db } as unknown as SecPipelineEnv;
  const deadLetter = { task: "tree" as const, ticker: "NET", causeId: "c" };
  const start = async () => ({ id: "run-x", params: {}, fingerprint: "x" });
  await driveWorkflow(env, "tree:NET", workflows, start, { deadLetter, trigger: "e1" });
  const outcome = await driveWorkflow(env, "tree:NET", workflows, start, { deadLetter, trigger: "e1" });
  assert.equal(outcome.status, "later");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM pipeline_dead").first<{ n: number }>())!.n, 0);
});

test("a provider refusing the key (no workspace named) is retried once the configuration is fixed, not dead-lettered", async () => {
  const db = database();
  const workflows = binding({ "run-w": { status: "errored", error: { name: "NonRetryableError", message: "[invalid_request_error] Model claude-opus-5-5 business-tree-2-1 HTTP 400: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header\"}}" } } });
  const env = { DB: db } as unknown as SecPipelineEnv;
  const deadLetter = { task: "tree" as const, ticker: "AMZN", causeId: "c" };
  const start = async () => ({ id: "run-w", params: {}, fingerprint: "w" });
  await driveWorkflow(env, "tree:AMZN", workflows, start, { deadLetter, trigger: "e1" });
  const outcome = await driveWorkflow(env, "tree:AMZN", workflows, start, { deadLetter, trigger: "e1" });
  assert.equal(outcome.status, "later");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM pipeline_dead").first<{ n: number }>())!.n, 0);
});

test("a request the provider rejects on its own merits stays final", async () => {
  const db = database();
  const workflows = binding({ "run-r": { status: "errored", error: { name: "NonRetryableError", message: "[invalid_request_error] Model claude-opus-5-5 x HTTP 400: prompt is too long" } } });
  const env = { DB: db } as unknown as SecPipelineEnv;
  const deadLetter = { task: "tree" as const, ticker: "AMZN", causeId: "c" };
  const start = async () => ({ id: "run-r", params: {}, fingerprint: "r" });
  await driveWorkflow(env, "tree:AMZN", workflows, start, { deadLetter, trigger: "e1" });
  await driveWorkflow(env, "tree:AMZN", workflows, start, { deadLetter, trigger: "e1" });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM pipeline_dead").first<{ n: number }>())!.n, 1);
});

test("a guidance run that errored leaves no event stuck: it is marked failed and retried under a new instance id", async () => {
  const db = database();
  const statuses: Record<string, { status: string; error?: unknown }> = {};
  const workflows = binding(statuses);
  const env = { DB: db, GUIDANCE_ENABLED: "true", GUIDANCE_WORKFLOW: workflows } as unknown as SecPipelineEnv;
  const t0 = new Date("2026-10-17T10:00:00.000Z");
  await db.prepare("INSERT INTO earnings_events (ticker, accession, event_date, status, updated_at) VALUES ('ORCL', '0001-26-000009', '2026-10-16', 'queued', ?)").bind(t0.toISOString()).run();
  const run = (now: Date) => SEC_TASKS.guidance.run(env, "ORCL", { causeId: "m1", now, trigger: "e1" });

  const started = await run(t0);
  assert.equal(started.status, "later", "a started run is checked again");
  const first = workflows.created[0]!;
  statuses[first] = { status: "errored", error: { message: "SEC submission HTTP 403" } };

  const reconciled = await run(new Date(t0.getTime() + 60_000));
  assert.equal(reconciled.status, "later");
  const row = await db.prepare("SELECT status FROM earnings_events WHERE accession = '0001-26-000009'").first<{ status: string }>();
  assert.equal(row!.status, "failed");
  assert.equal(workflows.created.length, 1, "no retry before its time");

  await run(new Date(t0.getTime() + 2 * 60 * 60_000));
  assert.equal(workflows.created.length, 2);
  assert.notEqual(workflows.created[1], first);
  assert.match(workflows.created[1]!, /-r1-/);
  assert.equal((await db.prepare("SELECT status FROM earnings_events WHERE accession = '0001-26-000009'").first<{ status: string }>())!.status, "started");
});

test("a context window overflow is sized from the provider's message", () => {
  assert.deepEqual(contextOverflow("Model x HTTP 400: This model's maximum context length is 131072 tokens. However, you requested 140000 tokens (120000 in the messages, 20000 in the completion)."), { window: 131072, prompt: 120000 });
  assert.equal(contextOverflow("Model x HTTP 400: max_tokens must be at most 8192"), null);
});
