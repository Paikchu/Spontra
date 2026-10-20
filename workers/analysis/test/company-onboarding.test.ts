import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runSecDiscovery } from "../src/pipeline/discovery.ts";
import { FinancialMaintenanceStore } from "../src/admin/financial-maintenance-store.ts";
import { SUBSCRIPTIONS, validateRegistry } from "../src/pipeline/registry.ts";
import type { AnalysisEnv } from "../src/operations.ts";

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

const DIRECTORY = { fields: ["cik", "name", "ticker", "exchange"], data: [[2056322, "Nebius Group N.V.", "NBIS", "Nasdaq"]] };
const submissions = (filings: Array<[string, string, string, string]>) => ({ filings: { recent: {
  accessionNumber: filings.map(f => f[0]), form: filings.map(f => f[1]), items: filings.map(f => f[2]), filingDate: filings.map(f => f[3]),
} } });
const FILINGS: Array<[string, string, string, string]> = [["0001104659-26-000002", "8-K", "2.02,9.01", "2026-08-07"], ["0001104659-26-000001", "10-K", "", "2026-03-01"]];

function fetcher(bodies: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = Object.entries(bodies).find(([suffix]) => url.endsWith(suffix))?.[1];
    return body === undefined ? new Response("missing", { status: 404 }) : Response.json(body);
  }) as typeof fetch;
}

const outbox = async (db: D1Database) => (await db.prepare("SELECT type, ticker, cik, detail FROM pipeline_outbox ORDER BY rowid").all<{ type: string; ticker: string; cik: string | null; detail: string | null }>()).results.map(r => ({ ...r }));

test("a data ticker discovery has never seen is announced as a new company with its first collection, then only its new filings", async () => {
  const db = database();
  const env = { DB: db, SEC_USER_AGENT: "test agent", SEC_DATA_TICKERS: "NBIS" } as unknown as AnalysisEnv;
  const first = await runSecDiscovery(env, new Date("2026-10-17T10:00:00.000Z"), fetcher({ "company_tickers_exchange.json": DIRECTORY, "CIK0002056322.json": submissions(FILINGS) }));
  assert.deepEqual({ baseline: first.baseline, bootstrapped: first.bootstrapped, discovered: first.discovered }, { baseline: ["NBIS"], bootstrapped: ["NBIS"], discovered: [] });
  assert.deepEqual(await outbox(db), [
    { type: "company.added", ticker: "NBIS", cik: "0002056322", detail: null },
    { type: "collection.requested", ticker: "NBIS", cik: "0002056322", detail: null },
  ]);
  await db.prepare("DELETE FROM pipeline_outbox").bind().run();

  // The CIK is now known, so the directory is not read again; a new 10-Q is the only event.
  const newer: Array<[string, string, string, string]> = [["0001104659-26-000003", "10-Q", "", "2026-10-16"], ...FILINGS];
  const second = await runSecDiscovery(env, new Date("2026-10-17T10:10:00.000Z"), fetcher({ "CIK0002056322.json": submissions(newer) }));
  assert.deepEqual({ baseline: second.baseline, bootstrapped: second.bootstrapped, discovered: second.discovered }, { baseline: [], bootstrapped: [], discovered: ["NBIS:10-Q:0001104659-26-000003"] });
  assert.deepEqual(await outbox(db), [{ type: "filing.discovered", ticker: "NBIS", cik: "0002056322", detail: JSON.stringify({ form: "10-Q", items: "", accession: "0001104659-26-000003" }) }]);
});

test("a ticker the issuer directory does not list is recorded where the admin's company list looks, and nothing is emitted", async () => {
  const db = database();
  const env = { DB: db, SEC_USER_AGENT: "test agent", SEC_DATA_TICKERS: "NBSI" } as unknown as AnalysisEnv;
  const result = await runSecDiscovery(env, new Date("2026-10-17T10:00:00.000Z"), fetcher({ "company_tickers_exchange.json": DIRECTORY }));
  assert.deepEqual(result.unknown, ["NBSI"]);
  assert.deepEqual(await outbox(db), []);
  const failure = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = 'sec:financial-discovery-failure:v1:NBSI'").first<{ payload: string }>();
  assert.deepEqual(JSON.parse(failure!.payload), { reason: "SEC_ISSUER_NOT_FOUND" });
});

test("a new company's event rail and income-statement check start from company.added, and the event graph stays complete and acyclic", () => {
  assert.deepEqual(SUBSCRIPTIONS["company.added"]?.map(s => s.task), ["events", "presentation"]);
  assert.deepEqual(validateRegistry(), []);
});

test("a maintenance task holds up collection only for its own issuer", async () => {
  const db = database();
  const now = "2026-10-17T10:00:00.000Z";
  const insert = (id: string, ticker: string, cik: string | null, stage = "collect") => db.prepare(
    "INSERT INTO financial_maintenance_tasks(task_id,request_id,ticker,cik,action,status,stage,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,'extract','running',?,?,?,?)")
    .bind(id, id, ticker, cik, stage, now, now, now).run();
  await insert("t1", "NBIS", null, "identify");
  await insert("t2", "GOOG", "0001652044");
  const store = new FinancialMaintenanceStore(db);
  assert.equal(await store.hasActiveDataTasksFor("NBIS", null), true, "its own ticker, before the CIK is known");
  assert.equal(await store.hasActiveDataTasksFor("GOOGL", "0001652044"), true, "the same issuer under another ticker");
  assert.equal(await store.hasActiveDataTasksFor("MSFT", "0000789019"), false, "another issuer is not held up");
  assert.equal(await store.hasActiveDataTasks(), true);
});
