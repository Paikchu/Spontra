import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runSecDiscovery, type DiscoveryState } from "../src/pipeline/discovery.ts";
import { scheduledAnalysisOn, scheduledAnalysisPausedAt, setScheduledAnalysis } from "../src/pipeline/scheduled-analysis.ts";
import { routeEvents } from "../src/pipeline/router.ts";
import { runTaskMessage, TASK_IMPLEMENTATIONS } from "../src/pipeline/tasks.ts";
import type { EventMessage, TaskMessage } from "../src/pipeline/messages.ts";
import { announceTaskVersions } from "../src/pipeline/versions.ts";
import { handleBusinessMapAdminRequest } from "../src/admin/business-map.ts";
import { createAdminSession } from "../src/admin/auth.ts";
import { emit } from "../src/pipeline/outbox.ts";
import type { AnalysisEnv } from "../src/operations.ts";
import { switchOn, UNSEEDED } from "./fixtures/company-settings.ts";

function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8").replace(/--> statement-breakpoint/g, ""));
  sqlite.exec(UNSEEDED);
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => { const r = sqlite.prepare(sql).run(...values as never[]); return { success: true, meta: { changes: Number(r.changes) } }; },
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
    first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) ?? null) as T | null,
  });
  return { prepare: (sql: string) => statement(sql), batch: async (list: Array<{ run(): Promise<unknown> }>) => { const out = []; for (const s of list) out.push(await s.run()); return out; } } as unknown as D1Database;
}

type Filing = [string, string, string, string];
const submissions = (filings: Filing[]) => ({ filings: { recent: {
  accessionNumber: filings.map(f => f[0]), form: filings.map(f => f[1]), items: filings.map(f => f[2]), filingDate: filings.map(f => f[3]),
  primaryDocument: filings.map(() => "doc.htm"), reportDate: filings.map(() => "2026-09-30"),
} } });
const OLD: Filing = ["0001104659-26-000001", "10-K", "", "2026-03-01"];
const NEW: Filing = ["0001104659-26-000002", "10-Q", "", "2026-10-16"];
const DIRECTORY = { fields: ["cik", "name", "ticker", "exchange"], data: [[2056322, "Nebius Group N.V.", "NBIS", "Nasdaq"]] };
const fetcher = (filings: Filing[]) => (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith("company_tickers_exchange.json")) return Response.json(DIRECTORY);
  if (url.endsWith("CIK0002056322.json")) return Response.json(submissions(filings));
  return new Response("missing", { status: 404 });
}) as typeof fetch;

const at = (minute: number) => new Date(Date.UTC(2026, 10, 8, 10, minute));
const outbox = async (db: D1Database) => (await db.prepare("SELECT type FROM pipeline_outbox ORDER BY rowid").all<{ type: string }>()).results.map(r => r.type);
const clear = (db: D1Database) => db.prepare("DELETE FROM pipeline_outbox").bind().run();
const state = async (db: D1Database) => JSON.parse((await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = 'sec:discovery:v1:NBIS'").first<{ payload: string }>())!.payload) as DiscoveryState;
async function setup() {
  const db = database();
  await switchOn(db, ["NBIS"]);
  return { db, env: { DB: db, SEC_USER_AGENT: "test agent" } as unknown as AnalysisEnv };
}

test("the switch is on until the admin turns it off, and turning it off twice keeps the first moment", async () => {
  const { db, env } = await setup();
  assert.equal(await scheduledAnalysisOn(db), true);
  await setScheduledAnalysis(env, false, at(0));
  assert.equal(await scheduledAnalysisOn(db), false);
  await setScheduledAnalysis(env, false, at(1));
  assert.equal(await scheduledAnalysisPausedAt(db), at(0).toISOString());
  await setScheduledAnalysis(env, true, at(1));
  assert.equal(await scheduledAnalysisOn(db), true);
});

test("a filing made while scheduled analysis is off starts nothing, stays listed for manual runs, and is announced once it is on", async () => {
  const { db, env } = await setup();
  await runSecDiscovery(env, at(0), fetcher([OLD]));
  await clear(db);

  await setScheduledAnalysis(env, false, at(5));
  const paused = await runSecDiscovery(env, at(10), fetcher([NEW, OLD]));
  assert.equal(paused.paused, true);
  assert.deepEqual(paused.discovered, []);
  assert.deepEqual(await outbox(db), []);
  const held = await state(db);
  assert.deepEqual(held.accessions, [OLD[0]]);
  assert.deepEqual(held.collectable, [NEW[0], OLD[0]]);

  await setScheduledAnalysis(env, true, at(15));
  const resumed = await runSecDiscovery(env, at(20), fetcher([NEW, OLD]));
  assert.deepEqual(resumed.discovered, [`NBIS:10-Q:${NEW[0]}`]);
  assert.deepEqual(await outbox(db), ["filing.discovered"]);
  assert.deepEqual((await state(db)).accessions, [NEW[0], OLD[0]]);

  await clear(db);
  assert.deepEqual((await runSecDiscovery(env, at(30), fetcher([NEW, OLD]))).discovered, []);
  assert.deepEqual(await outbox(db), []);
});

test("a company first seen while scheduled analysis is off gets its baseline and first collection once it is on", async () => {
  const { db, env } = await setup();
  await setScheduledAnalysis(env, false, at(0));
  await runSecDiscovery(env, at(10), fetcher([OLD]));
  assert.deepEqual(await outbox(db), []);
  assert.equal(await db.prepare("SELECT 1 FROM sec_cache WHERE cache_key = 'sec:discovery:v1:NBIS'").first(), null);

  await setScheduledAnalysis(env, true, at(15));
  const resumed = await runSecDiscovery(env, at(20), fetcher([OLD]));
  assert.deepEqual(resumed.baseline, ["NBIS"]);
  assert.deepEqual(await outbox(db), ["company.added", "collection.requested", "archive.requested"]);
});

test("a new task version is held while scheduled analysis is off and announced once it is on", async () => {
  const { db, env } = await setup();
  await setScheduledAnalysis(env, false, at(0));
  assert.deepEqual(await announceTaskVersions(env), []);
  assert.deepEqual(await outbox(db), []);
  assert.equal(await db.prepare("SELECT 1 FROM pipeline_versions WHERE id = 'tasks'").first(), null);

  await setScheduledAnalysis(env, true, at(5));
  assert.ok((await announceTaskVersions(env)).length > 0);
  assert.ok((await outbox(db)).includes("task.version_changed"));
});

test("a manual request still reaches the queue while scheduled analysis is off", async () => {
  const { db, env } = await setup();
  await setScheduledAnalysis(env, false, at(0));
  const sent: unknown[] = [];
  await emit({ DB: db, PIPELINE_EVENTS: { sendBatch: async (batch: unknown[]) => { sent.push(...batch); } } as unknown as Queue<never> }, [{ type: "maintenance.requested", ticker: "NBIS" }]);
  assert.equal(sent.length, 1);
});

/** A task queue that records what was sent, and a `collect` that records each run instead of collecting. */
function harness(env: AnalysisEnv) {
  const sent: TaskMessage[] = [], ran: string[] = [];
  const queue = { send: async (body: TaskMessage) => { sent.push(body); }, sendBatch: async (batch: Array<{ body: TaskMessage }>) => { sent.push(...batch.map(b => b.body)); } } as unknown as Queue<TaskMessage>;
  const original = TASK_IMPLEMENTATIONS.collect;
  TASK_IMPLEMENTATIONS.collect = { version: original.version, run: async (_env, ticker) => { ran.push(ticker); return { status: "done" }; } };
  return { env: { ...env, PIPELINE_TASKS: queue, SEC_DATA_TICKERS: "NBIS", FEATURE_RESOLVED: JSON.stringify({ enabled: { filings: true, findings: true, tree: true, valuation: true }, tickers: { filings: [], findings: [], tree: [], valuation: [] } }) } as AnalysisEnv, sent, ran, restore: () => { TASK_IMPLEMENTATIONS.collect = original; } };
}
const collectEvent = (id: string, when: Date): EventMessage => ({ v: 1, kind: "event", id, causeId: null, type: "collection.requested", ticker: "NBIS", cik: null, task: null, detail: null, at: when.toISOString() });
const collectMessage = (sent: TaskMessage[]) => sent.filter(m => m.task === "collect").at(-1)!;
const due = (db: D1Database) => db.prepare("SELECT held_at, due_at FROM pipeline_due WHERE ticker = 'NBIS' AND task = 'collect'").first<{ held_at: string | null; due_at: string }>();

test("a run queued before the switch went off is held at its turn and runs once the switch is on", async () => {
  const base = await setup();
  const { env, sent, ran, restore } = harness(base.env);
  try {
    await routeEvents(env, [collectEvent("e1", at(0))], at(0).getTime());
    await setScheduledAnalysis(env, false, at(1));
    const queued = collectMessage(sent);
    assert.deepEqual(await runTaskMessage(env, queued, at(10)), { outcome: "held" });
    assert.deepEqual(ran, []);
    assert.equal((await due(base.db))!.held_at, at(10).toISOString());

    await setScheduledAnalysis(env, true, at(20));
    const released = collectMessage(sent);
    assert.equal(released.dueAt, at(20).toISOString());
    assert.equal((await due(base.db))!.held_at, null);
    assert.equal((await runTaskMessage(env, queued, at(21))).outcome, "superseded");
    assert.equal((await runTaskMessage(env, released, at(21))).outcome, "done");
    assert.deepEqual(ran, ["NBIS"]);
    assert.equal(await due(base.db), null);
  } finally { restore(); }
});

test("an event still on its way when the switch went off queues a held run", async () => {
  const base = await setup();
  const { env, sent, ran, restore } = harness(base.env);
  try {
    await setScheduledAnalysis(env, false, at(1));
    await routeEvents(env, [collectEvent("e1", at(0))], at(2).getTime());
    assert.equal((await runTaskMessage(env, collectMessage(sent), at(10))).outcome, "held");
    assert.deepEqual(ran, []);
  } finally { restore(); }
});

test("a request made while the switch is off runs, even over a held run of the same task", async () => {
  const base = await setup();
  const { env, sent, ran, restore } = harness(base.env);
  try {
    await routeEvents(env, [collectEvent("e1", at(0))], at(0).getTime());
    await setScheduledAnalysis(env, false, at(1));
    await routeEvents(env, [collectEvent("e2", at(2))], at(2).getTime());
    const manual = collectMessage(sent);
    assert.equal((await due(base.db))!.held_at, null);
    assert.equal((await runTaskMessage(env, manual, at(10))).outcome, "done");
    assert.deepEqual(ran, ["NBIS"]);
  } finally { restore(); }
});

test("a row left by a dead-lettered run is not picked up when the switch comes back on", async () => {
  const base = await setup();
  const { env, sent, restore } = harness(base.env);
  try {
    await base.db.prepare("INSERT INTO pipeline_due (ticker, task, due_at, first_requested_at, cause_id) VALUES ('NBIS', 'collect', ?, ?, 'old')").bind(at(0).toISOString(), at(0).toISOString()).run();
    await setScheduledAnalysis(env, false, at(1));
    await setScheduledAnalysis(env, true, at(2));
    assert.deepEqual(sent, []);
  } finally { restore(); }
});

test("the admin route stores the switch and refuses anything but a boolean", async () => {
  const { db, env } = await setup();
  const authorization = `Bearer ${await createAdminSession("secret")}`;
  const post = (body: unknown) => handleBusinessMapAdminRequest(new Request("https://analysis.internal/admin/business-map/scheduled-analysis", { method: "POST", headers: { authorization }, body: JSON.stringify(body) }), { ...env, REPORT_ADMIN_PASSWORD: "secret" });
  assert.equal((await post({ on: "no" })).status, 400);
  assert.equal(await scheduledAnalysisOn(db), true);
  assert.equal((await post({ on: false })).status, 200);
  assert.equal(await scheduledAnalysisOn(db), false);
});
