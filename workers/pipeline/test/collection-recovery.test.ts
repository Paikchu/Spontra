import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runTaskMessage } from "../src/pipeline/tasks.ts";
import { missedFiling } from "../src/pipeline/financial-tasks.ts";
import { startCollection } from "../src/financial-data/queue.ts";
import { judgementStatement, presentationProfile, verifiedPresentation } from "../src/financial-data/presentation.ts";
import { readCompletePublication } from "../src/financial-data/publication.ts";
import { FinancialMaintenanceStore, type MaintenanceRow } from "../src/admin/financial-maintenance-store.ts";
import type { BridgeStructure } from "../src/financial-data/bridge.ts";
import type { SecPipelineEnv } from "../src/operations.ts";

/** D1 over node:sqlite with every migration applied. */
function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8").replace(/--> statement-breakpoint/g, ""));
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => { const r = sqlite.prepare(sql).run(...values as never[]); return { success: true, meta: { changes: Number(r.changes) } }; },
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]).map(r => ({ ...r })) as T[] }),
    first: async <T>() => { const row = sqlite.prepare(sql).get(...values as never[]); return (row ? { ...row } : null) as T | null; },
  });
  return { prepare: (sql: string) => statement(sql), batch: async (list: Array<{ run(): Promise<unknown> }>) => { const out = []; for (const s of list) out.push(await s.run()); return out; } } as unknown as D1Database;
}
const now = new Date("2026-10-17T10:00:00.000Z");

test("a continuation whose send fails leaves its due row in place, so the queue's retry runs the task again", async () => {
  const db = database();
  const dueAt = "2026-10-17T09:59:00.000Z";
  let fail = true;
  const sent: unknown[] = [];
  const env = { DB: db, SEC_FILINGS: { get: async () => null, list: async () => ({ objects: [], truncated: false }) },
    PIPELINE_TASKS: { send: async (body: unknown) => { if (fail) throw new Error("queue unavailable"); sent.push(body); } } } as unknown as SecPipelineEnv;
  const message = { v: 1 as const, kind: "task" as const, id: "m1", causeId: "e1", task: "maintenance" as const, ticker: "*", dueAt };
  // A maintenance task due later makes the maintenance run a continuation.
  await db.prepare("INSERT INTO pipeline_due (ticker, task, due_at, first_requested_at, cause_id) VALUES ('*', 'maintenance', ?, ?, 'e1')").bind(dueAt, dueAt).run();
  await db.prepare(`INSERT INTO financial_maintenance_tasks (task_id,request_id,ticker,action,status,total_steps,next_attempt_at,created_at,updated_at)
    VALUES ('t1','t1','NBIS','extract','queued',4,'2026-10-17T11:00:00.000Z',?,?)`).bind(now.toISOString(), now.toISOString()).run();
  await assert.rejects(runTaskMessage(env, message, now));
  const row = await db.prepare("SELECT due_at FROM pipeline_due WHERE ticker = '*' AND task = 'maintenance'").first<{ due_at: string }>();
  assert.equal(row!.due_at, dueAt, "the row still names the message being retried");
  fail = false;
  const retried = await runTaskMessage(env, message, now);
  assert.equal(retried.outcome, "later");
  assert.equal(sent.length, 1);
});

test("an admin analysis in its Workflow stages does not stop a filing's collection; a data stage does", async () => {
  const db = database();
  const insert = (id: string, stage: string, status = "queued") => db.prepare(`INSERT INTO financial_maintenance_tasks (task_id,request_id,ticker,cik,action,status,stage,total_steps,next_attempt_at,created_at,updated_at)
    VALUES (?,?,'ORCL','0001341439','analyze',?,?,5,?,?,?)`).bind(id, id, status, stage, now.toISOString(), now.toISOString(), now.toISOString()).run();
  await insert("a1", "analysis_wait");
  assert.equal(await startCollection(db, "ORCL", "0001341439", now), true);
  await db.prepare("DELETE FROM financial_collection_jobs").bind().run();
  await db.prepare("DELETE FROM financial_maintenance_tasks").bind().run();
  await insert("a2", "collect", "running");
  assert.equal(await startCollection(db, "ORCL", "0001341439", now), false);
});

test("a filing discovered after a job listed its filings starts one more collection, once per filing", async () => {
  const db = database();
  await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES ('sec:discovery:v1:NBIS', ?, ?)").bind(JSON.stringify({ cik: "0002056322", accessions: [], checkedAt: now.toISOString(), collectable: ["acc-new", "acc-old"] }), now.toISOString()).run();
  await db.prepare(`INSERT INTO financial_collection_jobs (job_id,cik,ticker,generation,status,cursor_json,next_attempt_at,updated_at) VALUES ('j1','0002056322','NBIS',1,'succeeded',?,?,?)`)
    .bind(JSON.stringify({ documents: [{ accession: "acc-old" }] }), now.toISOString(), now.toISOString()).run();
  assert.equal(await missedFiling(db, "NBIS", "j1"), "acc-new");
  assert.equal(await missedFiling(db, "NBIS", "j1"), null, "the same filing never restarts twice");
  await db.prepare("UPDATE financial_collection_jobs SET cursor_json = ? WHERE job_id = 'j1'").bind(JSON.stringify({ documents: [{ accession: "acc-old" }], release: { accession: "acc-new" } })).run();
  await db.prepare("DELETE FROM sec_cache WHERE cache_key LIKE 'pipeline:collect-restarted:%'").bind().run();
  assert.equal(await missedFiling(db, "NBIS", "j1"), null, "a listed release counts as read");
});

const structure: BridgeStructure = { pretax: "us-gaap:IncomeLossBeforeIncomeTaxes", afterTax: [] };

test("a failed judgement records its filing but keeps the structure verified on an earlier one", async () => {
  const db = database();
  const row = { cik: "0001018724", ticker: "AMZN" };
  await db.batch([judgementStatement(db, { ...row, accession: "a1" }, { structure, attempts: 1, issues: [] }, now, "presentation.v1")]);
  await db.batch([judgementStatement(db, { ...row, accession: "a2" }, { structure: null, attempts: 4, issues: ["no balance"] }, now, "presentation.v1")]);
  const profile = await presentationProfile(db, row.cik);
  assert.deepEqual({ status: profile?.status, accession: profile?.accession, version: profile?.judge_version }, { status: "verified", accession: "a2", version: "presentation.v1" });
  assert.ok(await verifiedPresentation(db, row.cik), "the earlier structure still applies");
  // With no structure ever verified, a failure is unresolved.
  await db.batch([judgementStatement(db, { cik: "0000000001", ticker: "X", accession: "b1" }, { structure: null, attempts: 4, issues: [] }, now, "presentation.v1")]);
  assert.equal((await presentationProfile(db, "0000000001"))?.status, "unresolved");
});

test("a stored publication the validator now rejects reads as unavailable, not as a storage failure", async () => {
  const db = database();
  await db.prepare("INSERT INTO financial_complete_versions (version_id,cik,ticker,generation,payload_json,published_at) VALUES ('v1','0000789019','MSFT',1,?,?)").bind(JSON.stringify({ schemaVersion: "business-flow.v1", ticker: "MSFT", quarters: [] }), now.toISOString()).run();
  await db.prepare("INSERT INTO financial_complete_current (cik,version_id,generation) VALUES ('0000789019','v1',1)").bind().run();
  const publication = await readCompletePublication(db, "0000789019");
  assert.deepEqual({ status: publication.status, flow: publication.flow, reasons: publication.reasons }, { status: "unavailable", flow: null, reasons: ["INVALID_PAYLOAD"] });
});

test("an analysis-stage maintenance task whose Workflow stays unobservable ends after its bounded wait", async () => {
  const db = database();
  const store = new FinancialMaintenanceStore(db);
  await db.prepare(`INSERT INTO financial_maintenance_tasks (task_id,request_id,ticker,action,status,stage,total_steps,attempt,lease_token,lease_until,next_attempt_at,created_at,updated_at)
    VALUES ('t1','t1','ORCL','analyze','running','analysis_wait',5,?,'L','2026-10-17T10:05:00.000Z',?,?,?)`).bind(719, now.toISOString(), now.toISOString(), now.toISOString()).run();
  const row = (await store.get("t1")) as MaintenanceRow;
  await store.failStep(row, now);
  assert.equal((await store.get("t1"))!.status, "queued");
  await db.prepare("UPDATE financial_maintenance_tasks SET status='running', attempt=720, lease_token='L', lease_until='2026-10-17T10:05:00.000Z' WHERE task_id='t1'").bind().run();
  await store.failStep((await store.get("t1")) as MaintenanceRow, now);
  const ended = await store.get("t1");
  assert.deepEqual({ status: ended!.status, code: ended!.error_code }, { status: "failed", code: "WORKFLOW_STATUS_UNAVAILABLE" });
});
