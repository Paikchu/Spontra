import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SEC_TASKS } from "../src/pipeline/sec-tasks.ts";
import { driveWorkflow, failedInputKey, type WorkflowBindingLike } from "../src/pipeline/workflow-task.ts";
import { contextOverflow } from "../src/model-recovery.ts";
import type { AnalysisEnv } from "../src/operations.ts";

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
  const env = { DB: db, SEC_ANALYSIS_WORKFLOW: workflows, SEC_AI_TICKERS: "NBIS", SEC_AI_ENABLED: "true" } as unknown as AnalysisEnv;
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
  const env = { DB: db } as unknown as AnalysisEnv;
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
  const env = { DB: db } as unknown as AnalysisEnv;
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
  const env = { DB: db } as unknown as AnalysisEnv;
  const deadLetter = { task: "tree" as const, ticker: "AMZN", causeId: "c" };
  const start = async () => ({ id: "run-r", params: {}, fingerprint: "r" });
  await driveWorkflow(env, "tree:AMZN", workflows, start, { deadLetter, trigger: "e1" });
  await driveWorkflow(env, "tree:AMZN", workflows, start, { deadLetter, trigger: "e1" });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM pipeline_dead").first<{ n: number }>())!.n, 1);
});

test("a release the archive does not hold yet waits queued, and its guidance starts once the wait is over", async () => {
  const db = database();
  const workflows = binding({});
  const env = { DB: db, GUIDANCE_ENABLED: "true", GUIDANCE_WORKFLOW: workflows } as unknown as AnalysisEnv;
  const t0 = new Date("2026-10-17T10:00:00.000Z");
  await db.prepare("INSERT INTO earnings_events (ticker, accession, event_date, status, updated_at) VALUES ('ORCL', '0001-26-000009', '2026-10-16', 'queued', ?)").bind(t0.toISOString()).run();
  const run = (now: Date) => SEC_TASKS.guidance.run(env, "ORCL", { causeId: "m1", now, trigger: "e1" });

  const waiting = await run(t0);
  assert.equal(workflows.created.length, 0, "no run reads an empty archive");
  assert.deepEqual(waiting.status === "later" && waiting.detail, { recorded: 0, transcripts: [], started: [], retried: 0, republished: false, waiting: ["0001-26-000009"] });
  assert.equal(waiting.status === "later" && waiting.afterMs, 6 * 3_600_000, "looked at again without a filing.archived");
  assert.equal((await db.prepare("SELECT status FROM earnings_events WHERE accession = '0001-26-000009'").first<{ status: string }>())!.status, "queued");

  await run(new Date("2026-10-18T00:00:00.000Z"));
  assert.equal(workflows.created.length, 1, "after two days it runs with whatever it has");
});

test("a guidance run that errored leaves no event stuck: it is marked failed and retried under a new instance id", async () => {
  const db = database();
  const statuses: Record<string, { status: string; error?: unknown }> = {};
  const workflows = binding(statuses);
  const env = { DB: db, GUIDANCE_ENABLED: "true", GUIDANCE_WORKFLOW: workflows } as unknown as AnalysisEnv;
  const t0 = new Date("2026-10-17T10:00:00.000Z");
  // A release past its wait for the archive: the run starts with whatever materials there are.
  await db.prepare("INSERT INTO earnings_events (ticker, accession, event_date, status, updated_at) VALUES ('ORCL', '0001-26-000009', '2026-10-14', 'queued', ?)").bind(t0.toISOString()).run();
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

test("a company analysis recovery whose instance ended without taking the run spends the attempt instead of being polled forever", async () => {
  const { recoverCompanyAnalysis } = await import("../src/core.ts");
  const { COMPANY_ANALYSIS_PROMPT_VERSION } = await import("../src/company-analysis/contracts.ts");
  const db = database();
  const failedAt = "2026-10-22T04:33:12.000Z";
  await db.prepare("INSERT INTO sec_periods (period_id, ticker, period_scope, end_date) VALUES ('p1', 'META', 'quarter', '2026-09-30')").bind().run();
  await db.prepare("INSERT INTO sec_company_memory_threads (ticker, version) VALUES ('META', 3)").bind().run();
  await db.prepare("INSERT INTO sec_memory_jobs (job_id, ticker, filing_id, period_id, status, source_r2_key, completed_at) VALUES ('m1', 'META', 'f1', 'p1', 'complete', 'k', ?)").bind(failedAt).run();
  await db.prepare(`INSERT INTO company_analysis_runs (analysis_id, ticker, trigger_ref, period_id, memory_version, status, model_version, prompt_version, updated_at, workflow_instance_id, recovery_count)
    VALUES ('company:META:1', 'META', 'm1:3', 'p1', 3, 'failed', 'm', ?, ?, 'company-old', 0)`).bind(COMPANY_ANALYSIS_PROMPT_VERSION, failedAt).run();
  const ended = new Set<string>();
  const workflow = {
    async create({ id }: { id: string }) { if (ended.has(id)) throw new Error("instance.already_exists"); ended.add(id); },
    async get() { return { status: async () => ({ status: "errored" }) }; },
  };
  const env = { DB: db, COMPANY_ANALYSIS_WORKFLOW: workflow } as unknown as AnalysisEnv;
  const now = Date.parse("2026-10-22T05:00:00.000Z");
  const first = await recoverCompanyAnalysis(env, "META", now);
  assert.equal(first.running, true);
  // The same id comes back: the instance it names has ended, so the attempt is spent and the next waits its back-off.
  const second = await recoverCompanyAnalysis(env, "META", now + 15 * 60_000);
  assert.equal(second.running, false);
  const row = await db.prepare("SELECT recovery_count n, updated_at at FROM company_analysis_runs WHERE analysis_id = 'company:META:1'").bind().first<{ n: number; at: string }>();
  assert.deepEqual({ ...row }, { n: 1, at: new Date(now + 15 * 60_000).toISOString() });
  assert.ok(second.nextRecoveryAt && Date.parse(second.nextRecoveryAt) > now + 15 * 60_000);
});

test("a Workflow still running a day after it started is stopped and retried like a failed run, not polled forever", async () => {
  const db = database();
  let terminated = 0;
  const workflows: WorkflowBindingLike = { async create() {}, async get() { return { status: async () => ({ status: "waiting" }), terminate: async () => { terminated++; } }; } };
  const env = { DB: db } as unknown as AnalysisEnv;
  await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)").bind("pipeline:workflow:findings:NET",
    JSON.stringify({ instanceId: "findings-NET-1", startedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(), fingerprint: "f1", trigger: "e1" }), new Date().toISOString()).run();
  const outcome = await driveWorkflow(env, "findings:NET", workflows, async () => null, { deadLetter: { task: "findings", ticker: "NET", causeId: "m1" }, trigger: "e1" });
  assert.equal(terminated, 1);
  assert.deepEqual([outcome.status, (outcome.detail as { retry?: number }).retry], ["later", 1]);
  assert.equal((await readFailed(db, "findings", "NET"))?.attempts, 1);
});

test("a filing over the archive's size cap is recorded as unsupported, and the older filings behind it are still stored", async () => {
  const { ARCHIVE_TASKS, archiveCompleteKey } = await import("../src/sec-archive/task.ts");
  const db = database();
  const objects = new Map<string, string>();
  const SEC_FILINGS = {
    async put(key: string, value: string) { objects.set(key, value); },
    async get(key: string) { const text = objects.get(key); return text === undefined ? null : { text: async () => text }; },
    async head(key: string) { return objects.has(key) ? {} : null; },
  };
  const env = { DB: db, SEC_FILINGS, SEC_USER_AGENT: "Spontra test contact@example.com" } as unknown as AnalysisEnv;
  const root = "https://www.sec.gov/Archives/edgar/data/1341439";
  await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)").bind("sec:discovery:v1:ORCL", JSON.stringify({
    cik: "0001341439", accessions: [], checkedAt: "2026-10-17T00:00:00.000Z",
    current: [
      { accession: "0001193125-26-000002", form: "8-K", items: "7.01", filingDate: "2026-10-16", reportDate: "2026-10-16", document: "huge.htm" },
      { accession: "0001193125-26-000001", form: "8-K", items: "5.02", filingDate: "2026-10-15", reportDate: "2026-10-15", document: "d1.htm" },
      { accession: "0001193125-26-000000", form: "8-K", items: "8.01", filingDate: "2026-10-14", reportDate: "2026-10-14", document: "notice.txt" },
    ],
  }), "2026-10-17T00:00:00.000Z").run();
  const small = `<html><body><p>Item 5.02 ${"A director joined the board. ".repeat(20)}</p></body></html>`;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${root}/000119312526000002/huge.htm`) return new Response("x", { headers: { "content-length": "30000000" } });
    if (url === `${root}/000119312526000001/d1.htm`) return new Response(small);
    if (url === `${root}/000119312526000000/notice.txt`) return new Response(`ITEM 8.01 OTHER EVENTS\n${"The company announced a plain-text notice. ".repeat(20)}`, { headers: { "content-type": "text/plain" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const result = await ARCHIVE_TASKS.archive.run(env, "ORCL", { causeId: "c1", now: new Date("2026-10-17T00:00:00.000Z"), trigger: null });
    assert.deepEqual(result, { status: "later", afterMs: 1000, detail: { archived: ["0001193125-26-000001"], unsupported: ["0001193125-26-000002"], remaining: 1 } }, "two per run; the plain-text notice follows");
    assert.deepEqual(await ARCHIVE_TASKS.archive.run(env, "ORCL", { causeId: "c1b", now: new Date("2026-10-17T00:00:30.000Z"), trigger: null }), { status: "done", detail: { archived: ["0001193125-26-000000"] } }, "a plain-text body is archived like an HTML one");
    const marker = JSON.parse((await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = ?").bind(archiveCompleteKey("ORCL", "0001193125-26-000002")).first<{ payload: string }>())!.payload);
    assert.equal(marker.unsupported, "SEC_DOCUMENT_TOO_LARGE");
    assert.deepEqual(await ARCHIVE_TASKS.archive.run(env, "ORCL", { causeId: "c2", now: new Date("2026-10-17T00:01:00.000Z"), trigger: null }), { status: "done", detail: { archived: 0 } }, "neither is tried again");
  } finally {
    globalThis.fetch = original;
  }
});

test("the archive task finishes a filing whose exhibit failed to store, instead of passing it over once its body is in", async () => {
  const { ARCHIVE_TASKS } = await import("../src/sec-archive/task.ts");
  const { archiveHolds, archivedExhibits } = await import("../src/sec-archive/index.ts");
  const db = database();
  const objects = new Map<string, string>();
  // The store fails once on the exhibit (each document writes three objects), after the body is already in.
  let failNextPut = false, puts = 0;
  const SEC_FILINGS = {
    async put(key: string, value: string) { if (failNextPut && ++puts === 4) { failNextPut = false; throw new Error("R2 unavailable"); } objects.set(key, value); },
    async get(key: string) { const text = objects.get(key); return text === undefined ? null : { text: async () => text }; },
    async head(key: string) { return objects.has(key) ? {} : null; },
  };
  const env = { DB: db, SEC_FILINGS, SEC_USER_AGENT: "Spontra test contact@example.com" } as unknown as AnalysisEnv;
  const folder = "https://www.sec.gov/Archives/edgar/data/1341439/000119312526000001";
  await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)").bind("sec:discovery:v1:ORCL", JSON.stringify({
    cik: "0001341439", accessions: [], checkedAt: "2026-10-17T00:00:00.000Z",
    current: [{ accession: "0001193125-26-000001", form: "8-K", items: "7.01,9.01", filingDate: "2026-10-16", reportDate: "2026-10-16", document: "d1.htm" }],
  }), "2026-10-17T00:00:00.000Z").run();
  const body = `<html><body><p>Item 7.01 Regulation FD Disclosure</p><table><tr><td>99.1</td><td><a href="ex99.htm">Investor presentation</a></td></tr></table></body></html>`;
  const exhibit = `<html><body><p>${"Oracle cloud infrastructure backlog grew in the quarter. ".repeat(20)}</p></body></html>`;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${folder}/d1.htm`) return new Response(body);
    if (url === `${folder}/ex99.htm`) return new Response(exhibit);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const run = (minutesLater = 0) => ARCHIVE_TASKS.archive.run(env, "ORCL", { causeId: "c1", now: new Date(Date.parse("2026-10-17T00:00:00.000Z") + minutesLater * 60_000), trigger: null });
  const stored = async () => (await db.prepare("SELECT COUNT(*) AS n FROM sec_cache WHERE cache_key LIKE 'sec:disclosure-audit:%'").first<{ n: number }>())!.n;
  try {
    failNextPut = true;
    // The failed store is a failure of this filing alone: counted, tried again after a pause, never the batch's.
    assert.deepEqual(await run(), { status: "later", afterMs: 15 * 60_000, detail: { archived: [], failed: ["0001193125-26-000001"] } });
    assert.equal(await stored(), 1, "the body alone was stored");
    // Until its delay is out the filing waits, and the run says how long; it is not tried again at once.
    assert.deepEqual(await run(1), { status: "later", afterMs: 14 * 60_000, detail: { archived: 0, deferred: 1 } });
    // A body whose exhibit is not stored yet is not a filing the report or guidance may read.
    assert.equal(await archiveHolds(env, "ORCL", "0001193125-26-000001", `${folder}/d1.htm`), false, "half a filing is not held");
    assert.equal(await archivedExhibits(env, "ORCL", "0001193125-26-000001", "2026-10-16", `${folder}/d1.htm`), null, "its exhibits read as not archived");
    const resumed = await run(16);
    assert.deepEqual(resumed, { status: "done", detail: { archived: ["0001193125-26-000001"] } }, "the filing is still pending after its body was stored");
    assert.ok(await stored() >= 2, "the exhibit is stored too");
    assert.equal(await archiveHolds(env, "ORCL", "0001193125-26-000001", `${folder}/d1.htm`), true, "the whole filing is held");
    assert.equal((await archivedExhibits(env, "ORCL", "0001193125-26-000001", "2026-10-16", `${folder}/d1.htm`))?.length, 1);
    assert.deepEqual(await run(17), { status: "done", detail: { archived: 0 } });
  } finally {
    globalThis.fetch = original;
  }
});
