import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { annualForm, runSecDiscovery } from "../src/pipeline/discovery.ts";
import { newFilings } from "../src/financial-data/new-filings.ts";
import { READ_NOTE_VERSION } from "../src/financial-data/read-note.ts";
import type { BusinessFlowQuarter } from "../../../shared/analysis-contract/business-flow.ts";
import { FinancialMaintenanceStore } from "../src/admin/financial-maintenance-store.ts";
import { SUBSCRIPTIONS, validateRegistry } from "../src/pipeline/registry.ts";
import type { AnalysisEnv } from "../src/operations.ts";
import { indexFilings } from "../src/events/workflow.ts";
import { switchOn, UNSEEDED } from "./fixtures/company-settings.ts";

/** D1 over node:sqlite with every migration applied. */
function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8").replace(/--> statement-breakpoint/g, ""));
  sqlite.exec(UNSEEDED);
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
  await switchOn(db, ["NBIS"]);
  const env = { DB: db, SEC_USER_AGENT: "test agent" } as unknown as AnalysisEnv;
  const first = await runSecDiscovery(env, new Date("2026-10-17T10:00:00.000Z"), fetcher({ "company_tickers_exchange.json": DIRECTORY, "CIK0002056322.json": submissions(FILINGS) }));
  assert.deepEqual({ baseline: first.baseline, bootstrapped: first.bootstrapped, discovered: first.discovered }, { baseline: ["NBIS"], bootstrapped: ["NBIS"], discovered: [] });
  assert.deepEqual(await outbox(db), [
    { type: "company.added", ticker: "NBIS", cik: "0002056322", detail: null },
    { type: "collection.requested", ticker: "NBIS", cik: "0002056322", detail: null },
    // The baseline's 8-K was never announced by a filing.discovered: it is asked to be archived here.
    { type: "archive.requested", ticker: "NBIS", cik: "0002056322", detail: null },
  ]);
  await db.prepare("DELETE FROM pipeline_outbox").bind().run();

  // The CIK is now known, so the directory is not read again; a new 10-Q is the only event.
  const newer: Array<[string, string, string, string]> = [["0001104659-26-000003", "10-Q", "", "2026-10-16"], ...FILINGS];
  const second = await runSecDiscovery(env, new Date("2026-10-17T10:10:00.000Z"), fetcher({ "CIK0002056322.json": submissions(newer) }));
  assert.deepEqual({ baseline: second.baseline, bootstrapped: second.bootstrapped, discovered: second.discovered }, { baseline: [], bootstrapped: [], discovered: ["NBIS:10-Q:0001104659-26-000003"] });
  assert.deepEqual(await outbox(db), [{ type: "filing.discovered", ticker: "NBIS", cik: "0002056322", detail: JSON.stringify({ form: "10-Q", items: "", accession: "0001104659-26-000003" }) }]);

  // A state saved before `current` existed (an upgraded installation): the sweep that first lists the current reports asks for their archive.
  await db.prepare("DELETE FROM pipeline_outbox").bind().run();
  const saved = JSON.parse((await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = 'sec:discovery:v1:NBIS'").first<{ payload: string }>())!.payload);
  delete saved.current;
  await db.prepare("UPDATE sec_cache SET payload = ? WHERE cache_key = 'sec:discovery:v1:NBIS'").bind(JSON.stringify(saved)).run();
  await runSecDiscovery(env, new Date("2026-10-17T10:20:00.000Z"), fetcher({ "CIK0002056322.json": submissions(newer) }));
  assert.deepEqual(await outbox(db), [{ type: "archive.requested", ticker: "NBIS", cik: "0002056322", detail: null }]);
});

test("the archive list keeps the report's filings apart from a run of prospectus supplements, so none pushes a report out", async () => {
  const db = database();
  await switchOn(db, ["NBIS"]);
  const env = { DB: db, SEC_USER_AGENT: "test agent" } as unknown as AnalysisEnv;
  const supplements: Array<[string, string, string, string]> = Array.from({ length: 45 }, (_, i) => [`0001104659-26-00${String(100 + i).padStart(4, "0")}`, "424B2", "", "2026-09-01"]);
  await runSecDiscovery(env, new Date("2026-10-17T10:00:00.000Z"), fetcher({ "company_tickers_exchange.json": DIRECTORY, "CIK0002056322.json": submissions([...supplements, ...FILINGS]) }));
  const state = JSON.parse((await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = 'sec:discovery:v1:NBIS'").first<{ payload: string }>())!.payload) as { current: Array<{ form: string }> };
  assert.deepEqual(state.current.filter(f => f.form !== "424B2").map(f => f.form), ["8-K", "10-K"], "the reports stay listed behind 45 supplements");
  assert.equal(state.current.filter(f => f.form === "424B2").length, 40);

  // Beyond the diff's bounded memory too: 200 Form 4s precede the reports, and the archive list still names them.
  const insiders: Array<[string, string, string, string]> = Array.from({ length: 200 }, (_, i) => [`0001104659-26-01${String(1000 + i).padStart(4, "0")}`, "4", "", "2026-09-02"]);
  await runSecDiscovery(env, new Date("2026-10-17T10:10:00.000Z"), fetcher({ "CIK0002056322.json": submissions([...insiders, ...FILINGS]) }));
  const later = JSON.parse((await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = 'sec:discovery:v1:NBIS'").first<{ payload: string }>())!.payload) as { accessions: string[]; current: Array<{ form: string }> };
  assert.equal(later.accessions.length, 200, "the diff remembers the newest 200");
  assert.deepEqual(later.current.map(f => f.form), ["8-K", "10-K"], "the archive list reads past them");
});

test("a ticker the issuer directory does not list is recorded where the admin's company list looks, and nothing is emitted", async () => {
  const db = database();
  await switchOn(db, ["NBSI"]);
  const env = { DB: db, SEC_USER_AGENT: "test agent" } as unknown as AnalysisEnv;
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

test("a data-only issuer's new earnings release reaches collection from discovery alone, with no reports index", async () => {
  const db = database();
  await switchOn(db, ["GOOGL"]);
  const env = { DB: db, SEC_USER_AGENT: "test agent" } as unknown as AnalysisEnv;
  const recent = (rows: Array<[string, string, string, string, string, string]>) => ({ filings: { recent: {
    accessionNumber: rows.map(r => r[0]), form: rows.map(r => r[1]), items: rows.map(r => r[2]), filingDate: rows.map(r => r[3]), reportDate: rows.map(r => r[4]), primaryDocument: rows.map(r => r[5]),
  } } });
  const tenQ: [string, string, string, string, string, string] = ["0001652044-26-000071", "10-Q", "", "2026-07-23", "2026-06-30", "goog-20260630.htm"];
  const release: [string, string, string, string, string, string] = ["0001652044-26-000080", "8-K", "2.02,9.01", "2026-10-28", "2026-10-28", "googexhibit991q32026.htm"];
  await db.prepare("INSERT INTO sec_cache (cache_key, payload) VALUES (?, ?)").bind("sec:discovery:v1:GOOGL", JSON.stringify({ cik: "0001652044", accessions: [], checkedAt: "", collectable: [release[0]] })).run();
  const newest = { periodEnd: "2026-06-30", reportedAt: "2026-07-23", sources: [{ title: "Form 10-Q", publishedAt: "2026-07-23" }] } as unknown as BusinessFlowQuarter;
  assert.equal(await newFilings(db, "GOOGL", "0001652044", newest), null, "a listing discovery wrote before it kept the details is not read as nothing new");
  await runSecDiscovery(env, new Date("2026-10-28T20:00:00.000Z"), fetcher({ "CIK0001652044.json": recent([release, ["0001652044-26-000079", "4", "", "2026-10-27", "", "xslF345X05/form4.xml"], tenQ]) }));
  assert.equal((await db.prepare("SELECT count(*) n FROM sec_filings").first<{ n: number }>())!.n, 0);
  assert.deepEqual(await newFilings(db, "GOOGL", "0001652044", newest), [{ accession: "0001652044-26-000080", form: "8-K", filedAt: "2026-10-28", reportDate: null,
    url: "https://www.sec.gov/Archives/edgar/data/1652044/000165204426000080/googexhibit991q32026.htm" }]);

  // A filing with a read note under this version is read once.
  await db.prepare("INSERT INTO filing_read_notes (accession, cik, ticker, form, version, status, updated_at) VALUES (?, ?, ?, ?, ?, 'unresolved', ?)")
    .bind("0001652044-26-000080", "0001652044", "GOOGL", "8-K", READ_NOTE_VERSION, "2026-10-28T20:12:00.000Z").run();
  assert.deepEqual(await newFilings(db, "GOOGL", "0001652044", newest), []);
});

test("the issuer's annual form is its latest annual report's, read across its whole recent list", () => {
  const recent = (form: string[]) => ({ filings: { recent: { form } } });
  // A 20-F filer's monthly 6-Ks push its annual report far down the list; an amendment reads as the report it amends.
  assert.equal(annualForm(recent([...Array<string>(300).fill("6-K"), "20-F", "10-K"])), "20-F");
  assert.equal(annualForm(recent(["8-K", "10-K/A", "10-Q"])), "10-K");
  assert.equal(annualForm(recent(["40-F"])), "40-F");
  assert.equal(annualForm(recent(["6-K", "F-1"])), null);
  assert.equal(annualForm(null), null);
});

test("a company without the report summaries gets its filings list from the event rail's read, announced once per new filing", async () => {
  const db = database();
  const list = (rows: Array<[string, string, string]>) => ({ name: "Taiwan Semiconductor", filings: { recent: {
    accessionNumber: rows.map(r => r[0]), form: rows.map(r => r[1]), filingDate: rows.map(r => r[2]), reportDate: rows.map(() => ""),
    primaryDocument: rows.map(r => `${r[0]}.htm`), primaryDocDescription: rows.map(() => ""), items: rows.map(() => ""),
  } } });
  const first: Array<[string, string, string]> = [["0001046179-26-000002", "6-K", "2026-10-15"], ["0001046179-26-000001", "20-F", "2026-04-15"], ["0001046179-26-000000", "SC 13G", "2026-02-01"]];
  assert.equal(await indexFilings(db, "TSM", "0001046179", list(first), "2026-10-16T00:00:00.000Z"), 2);
  assert.deepEqual((await db.prepare("SELECT accession_number a, form FROM sec_filings WHERE ticker = 'TSM' ORDER BY a").all<{ a: string; form: string }>()).results.map(r => ({ ...r })),
    [{ a: "0001046179-26-000001", form: "20-F" }, { a: "0001046179-26-000002", form: "6-K" }]);
  // Nothing new: no rows, no event.
  assert.equal(await indexFilings(db, "TSM", "0001046179", list(first), "2026-10-16T01:00:00.000Z"), 0);
  assert.equal(await indexFilings(db, "TSM", "0001046179", list([["0001046179-26-000003", "6-K", "2026-11-01"], ...first]), "2026-11-01T01:00:00.000Z"), 1);
  assert.deepEqual((await outbox(db)).map(e => e.type), ["filings.indexed", "filings.indexed"]);
});

test("every business filing a data company files reaches the events task, which indexes the filings list", () => {
  const routed = (form: string) => (SUBSCRIPTIONS["filing.discovered"] ?? []).some(s => s.task === "events" && (!s.when || s.when({ type: "filing.discovered", ticker: "TSM", detail: { form } })));
  assert.deepEqual(["10-Q", "10-K", "20-F", "6-K", "8-K", "4", "SC 13G"].map(routed), [true, true, true, true, true, true, false]);
});
