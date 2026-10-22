import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { scheduledAnalysisAllowed } from "../src/core.ts";
import { SEC_TASKS } from "../src/pipeline/sec-tasks.ts";
import { driveWorkflow, failedInputKey, type WorkflowBindingLike } from "../src/pipeline/workflow-task.ts";
import { routeEvents } from "../src/pipeline/router.ts";
import type { EventMessage } from "../src/pipeline/messages.ts";
import type { AnalysisEnv } from "../src/operations.ts";

function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8").replace(/--> statement-breakpoint/g, ""));
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => { sqlite.prepare(sql).run(...values as never[]); return { success: true }; },
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]).map(row => ({ ...row })) as T[] }),
    first: async <T>() => { const row = sqlite.prepare(sql).get(...values as never[]); return (row ? { ...row } : null) as T | null; },
  });
  return { prepare: (sql: string) => statement(sql), batch: async (list: Array<{ run(): Promise<unknown> }>) => { for (const item of list) await item.run(); return []; } } as unknown as D1Database;
}

function binding(statuses: Record<string, { status: string; error?: unknown }>): WorkflowBindingLike & { created: string[] } {
  const created: string[] = [];
  return {
    created,
    async create({ id }) { created.push(id); },
    async get(id) {
      if (!(id in statuses) && !created.includes(id)) throw new Error("instance.not_found");
      return { status: async () => statuses[id] ?? { status: "running" } };
    },
  };
}

const discovered = (ticker: string, form: string): EventMessage => ({
  v: 1, kind: "event", id: `event-${ticker}`, causeId: null, type: "filing.discovered", ticker, cik: null, task: null,
  detail: { form, accession: "0001104659-26-065681" }, at: "2026-10-22T08:00:00.000Z",
});

test("a scheduled report runs only while the company is still on the reports list; a manual run is left to its own grant", () => {
  const on = { SEC_AI_TICKERS: "META,NBIS", SEC_AI_ENABLED: "true" };
  assert.equal(scheduledAnalysisAllowed(on, { ticker: "NBIS", requestedBy: "scheduled" }), true);
  assert.equal(scheduledAnalysisAllowed({ SEC_AI_TICKERS: "META", SEC_AI_ENABLED: "true" }, { ticker: "NBIS", requestedBy: "scheduled" }), false);
  assert.equal(scheduledAnalysisAllowed({ SEC_AI_TICKERS: "NBIS", SEC_AI_ENABLED: "false" }, { ticker: "NBIS", requestedBy: "scheduled" }), false);
  assert.equal(scheduledAnalysisAllowed({ SEC_AI_ENABLED: "false" }, { ticker: "NBIS", requestedBy: "manual" }), true);
});

test("routing a filing does not queue a report for a company whose reports are off, and still queues one that is on", async () => {
  const db = database();
  await db.prepare("INSERT INTO business_feature_settings (ticker, feature, generate, display, updated_at) VALUES ('NBIS', 'reports', 0, 1, '2026-10-22T08:00:00.000Z')").run();
  const sent: Array<{ task: string; ticker: string }> = [];
  const env = {
    DB: db, SEC_DATA_TICKERS: "META,NBIS", SEC_AI_TICKERS: "META,NBIS", SEC_AI_ENABLED: "true",
    PIPELINE_TASKS: { async sendBatch(messages: Array<{ body: { task: string; ticker: string } }>) { sent.push(...messages.map(message => message.body)); } },
  } as unknown as AnalysisEnv;
  await routeEvents(env, [discovered("NBIS", "20-F/A"), discovered("META", "10-Q")]);
  assert.deepEqual(sent.filter(message => message.task === "sec-report").map(message => message.ticker).sort(), ["META"]);
  assert.ok(sent.some(message => message.ticker === "NBIS" && message.task === "collect"));
});

test("a report task already queued for a company that has left the list finishes without starting a workflow", async () => {
  const db = database();
  const workflows = binding({});
  const env = { DB: db, SEC_ANALYSIS_WORKFLOW: workflows, SEC_AI_TICKERS: "META", SEC_AI_ENABLED: "true" } as unknown as AnalysisEnv;
  const outcome = await SEC_TASKS["sec-report"].run(env, "NBIS", { causeId: "m1", now: new Date("2026-10-22T08:57:00.000Z"), trigger: "e1" });
  assert.equal(outcome.status, "done");
  assert.equal((outcome.detail as { skipped?: string }).skipped, "reports are off for this company");
  assert.deepEqual(workflows.created, []);
  const tracked = { DB: db, SEC_ANALYSIS_WORKFLOW: workflows, SEC_AI_TICKERS: "META", SEC_AI_ENABLED: "true" } as unknown as AnalysisEnv;
  const at = new Date("2026-10-22T05:11:00.000Z");
  const started = await SEC_TASKS["sec-report"].run(tracked, "META", { causeId: "m2", now: at, trigger: "e2" });
  assert.equal(started.status, "later");
  assert.equal(workflows.created[0], `scheduled-META-${at.getTime()}`);
});

test("a workflow that already failed because the company is not tracked is a skip, not a feature failure", async () => {
  const db = database();
  await db.prepare("INSERT INTO business_feature_settings (ticker, feature, generate, display, updated_at) VALUES ('NBIS', 'reports', 1, 1, '2026-10-22T08:00:00.000Z')").run();
  await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)").bind(
    failedInputKey("sec-report", "NBIS"),
    JSON.stringify({ fingerprint: "0001104659-26-065681", instanceId: "older", failure: "editorial", attempts: 1, retryAt: "2026-10-22T09:00:00.000Z" }),
    "2026-10-22T08:00:00.000Z",
  ).run();
  const workflows = binding({ "scheduled-NBIS-1792659144946": { status: "errored", error: { message: "Ticker is not tracked" } } });
  const env = { DB: db, SEC_AI_TICKERS: "NBIS", SEC_AI_ENABLED: "true" } as unknown as AnalysisEnv;
  const deadLetter = { task: "sec-report" as const, ticker: "NBIS", causeId: "c1" };
  const start = async () => ({ id: "scheduled-NBIS-1792659144946", params: { ticker: "NBIS", requestedBy: "scheduled" } });
  assert.equal((await driveWorkflow(env, "sec-report:NBIS", workflows, start, { deadLetter, trigger: "e1" })).status, "later");
  const outcome = await driveWorkflow(env, "sec-report:NBIS", workflows, start, { deadLetter, trigger: "e1" });
  assert.equal(outcome.status, "done");
  assert.equal((outcome.detail as { skipped?: string }).skipped, "Ticker is not tracked");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM admin_messages").first<{ n: number }>())!.n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM pipeline_dead").first<{ n: number }>())!.n, 0);
  assert.equal((await db.prepare("SELECT generate FROM business_feature_settings WHERE ticker = 'NBIS' AND feature = 'reports'").first<{ generate: number }>())!.generate, 1);
  assert.equal(await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = ?").bind(failedInputKey("sec-report", "NBIS")).first(), null);
});

test("a workflow that failed for a tracked company is still recorded as a feature failure", async () => {
  const db = database();
  await db.prepare("INSERT INTO business_feature_settings (ticker, feature, generate, display, updated_at) VALUES ('META', 'reports', 1, 1, '2026-10-22T05:00:00.000Z')").run();
  const workflows = binding({ "scheduled-META-1792645596262": { status: "errored", error: { message: "No core facts passed factual verification" } } });
  const env = { DB: db, SEC_AI_TICKERS: "META", SEC_AI_ENABLED: "true" } as unknown as AnalysisEnv;
  const deadLetter = { task: "sec-report" as const, ticker: "META", causeId: "c2" };
  const start = async () => ({ id: "scheduled-META-1792645596262", params: { ticker: "META", requestedBy: "scheduled" }, fingerprint: "0001326801-26-000001" });
  await driveWorkflow(env, "sec-report:META", workflows, start, { deadLetter, trigger: "e1" });
  const outcome = await driveWorkflow(env, "sec-report:META", workflows, start, { deadLetter, trigger: "e1" });
  assert.equal(outcome.status, "later");
  const message = await db.prepare("SELECT outcome, feature FROM admin_messages WHERE ticker = 'META'").first<{ outcome: string; feature: string }>();
  assert.deepEqual(message, { outcome: "failed", feature: "reports" });
  assert.equal((await db.prepare("SELECT generate FROM business_feature_settings WHERE ticker = 'META' AND feature = 'reports'").first<{ generate: number }>())!.generate, 0);
});
