import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { HISTORY_VERSION, runHistoryStep } from "../src/financial-data/history.ts";
import type { SecReader } from "../src/financial-data/provider.ts";
import { refreshCompanyEvents, secAccessPaused } from "../src/events/workflow.ts";
import { AI_TASKS } from "../src/pipeline/ai-tasks.ts";
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

const now = new Date("2026-10-17T10:00:00.000Z");
const CIK = "0000789019";
const columns = (rows: Array<[string, string, string]>) => ({
  form: rows.map(r => r[0]), filingDate: rows.map(r => r[1]), accessionNumber: rows.map(r => r[2]),
  primaryDocument: rows.map(() => "doc.htm"), reportDate: rows.map(() => ""), items: rows.map(() => ""),
});

test("a history scan after a finished one lists EDGAR again but reads only the filings not read before", async () => {
  const db = database();
  const listing = { cik: CIK, sic: "7372", filings: { recent: columns([["10-Q", "2026-10-16", "0000789019-26-000030"], ["10-Q", "2026-07-30", "0000789019-26-000020"], ["10-K", "2026-04-30", "0000789019-26-000010"]]) } };
  const reader: SecReader = { submissions: async () => listing, issuerDirectory: async () => ({ fields: [], data: [] }), async read() { throw new Error("no document reads expected"); } };
  const finished = { version: HISTORY_VERSION, ticker: "MSFT", industry: "standard", documents: [], index: 0, facts: [], issues: [], startedAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:10:00.000Z",
    read: ["0000789019-26-000020", "0000789019-26-000010", "0000789019-23-000001"] };
  await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)").bind(`sec:revenue-history-cursor:v1:${CIK}`, JSON.stringify(finished), finished.finishedAt).run();
  await runHistoryStep(db, reader, { ticker: "MSFT", cik: CIK }, now, 0, { restartFinished: true });
  const cursor = JSON.parse((await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = ?").bind(`sec:revenue-history-cursor:v1:${CIK}`).first<{ payload: string }>())!.payload) as { documents: Array<{ accession: string }>; read: string[]; finishedAt?: string };
  // Only the new 10-Q is to be read; the accession no longer listed is forgotten.
  assert.deepEqual(cursor.documents.map(d => d.accession), ["0000789019-26-000030"]);
  assert.deepEqual(cursor.read.sort(), ["0000789019-26-000010", "0000789019-26-000020"]);
  assert.equal(cursor.finishedAt, undefined);
});

test("a cursor from before incremental scans reads everything once more", async () => {
  const db = database();
  const listing = { cik: CIK, sic: "7372", filings: { recent: columns([["10-Q", "2026-10-16", "0000789019-26-000030"], ["10-K", "2026-04-30", "0000789019-26-000010"]]) } };
  const reader: SecReader = { submissions: async () => listing, issuerDirectory: async () => ({ fields: [], data: [] }), async read() { throw new Error("no document reads expected"); } };
  const legacy = { version: HISTORY_VERSION, ticker: "MSFT", industry: "standard", documents: [], index: 0, facts: [], issues: [], startedAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:10:00.000Z" };
  await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)").bind(`sec:revenue-history-cursor:v1:${CIK}`, JSON.stringify(legacy), legacy.finishedAt).run();
  await runHistoryStep(db, reader, { ticker: "MSFT", cik: CIK }, now, 0, { restartFinished: true });
  const cursor = JSON.parse((await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = ?").bind(`sec:revenue-history-cursor:v1:${CIK}`).first<{ payload: string }>())!.payload) as { documents: Array<{ accession: string }> };
  assert.deepEqual(cursor.documents.map(d => d.accession), ["0000789019-26-000030", "0000789019-26-000010"]);
});

const eventsEnv = (db: D1Database) => ({ DB: db, SEC_USER_AGENT: "test agent" }) as unknown as AnalysisEnv;
const knownCompany = (db: D1Database) => db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)").bind("sec:discovery:v1:MSFT", JSON.stringify({ cik: CIK, accessions: [], checkedAt: now.toISOString() }), now.toISOString()).run();
const fetcher = (respond: (url: string) => Response | Promise<Response>): typeof fetch => (async (input: RequestInfo | URL) => respond(String(input))) as typeof fetch;

test("SEC pausing access ends the event refresh with SEC_ACCESS_PAUSED instead of a generic failure", async () => {
  const db = database();
  await knownCompany(db);
  await assert.rejects(refreshCompanyEvents(eventsEnv(db), "MSFT", fetcher(() => new Response("blocked", { status: 403 })), now), (error: unknown) => secAccessPaused(error));
});

test("the event refresh reads EDGAR through the paced reader; a Form 4 SEC does not serve is recorded unreadable, not left pending", async () => {
  const db = database();
  await knownCompany(db);
  const submissions = { filings: { recent: {
    accessionNumber: ["0000789019-26-000040"], form: ["4"], filingDate: ["2026-10-15"], reportDate: ["2026-10-14"], primaryDocument: ["xslF345X05/form4.xml"], primaryDocDescription: ["FORM 4"], items: [""],
  } } };
  const agents: string[] = [];
  const read = fetcher((url) => {
    if (url.endsWith(`CIK${CIK}.json`)) return Response.json(submissions);
    return new Response("not here", { status: 404 });
  });
  const spy: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { agents.push(String((init?.headers as Record<string, string>)["user-agent"])); return read(input, init); }) as typeof fetch;
  const result = await refreshCompanyEvents(eventsEnv(db), "MSFT", spy, now, { forceList: true });
  assert.deepEqual({ published: result.published, insiderReads: result.insiderReads }, { published: true, insiderReads: 1 });
  assert.ok(agents.length >= 2 && agents.every(agent => agent === "test agent"), "every read carries the SEC contact user-agent");
  const cached = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = ?").bind("insider:v1:MSFT:0000789019-26-000040").first<{ payload: string }>();
  assert.deepEqual(JSON.parse(cached!.payload), { unreadable: true });
  // Recorded, so the next refresh does not ask SEC for it again.
  const again = await refreshCompanyEvents(eventsEnv(db), "MSFT", spy, now, { forceList: true });
  assert.equal(again.insiderReads, 0);
});

test("findings wait while a recent earnings release's guidance is queued or running, not after it published or went silent", async () => {
  const db = database();
  const env = { DB: db, FINDINGS_ENABLED: "true", GUIDANCE_ENABLED: "true" } as unknown as AnalysisEnv;
  const context = { causeId: "m1", now, trigger: "e1" };
  const event = (accession: string, status: string, eventDate: string, updatedAt: string) =>
    db.prepare("INSERT INTO earnings_events (ticker, accession, event_date, status, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ticker, accession) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at").bind("ORCL", accession, eventDate, status, updatedAt).run();
  const run = () => AI_TASKS.findings.run(env, "ORCL", context);

  // Started yesterday (the model budget pushed it to today): still on the way.
  await event("a1", "started", "2026-10-15", "2026-10-16T09:00:00.000Z");
  assert.equal((await run()).status, "later");
  // Published its guidance: nothing to wait for (the Workflow has no binding here, so the task is done).
  await event("a1", "extracted", "2026-10-15", "2026-10-17T09:00:00.000Z");
  assert.equal((await run()).status, "done");
  // Queued a month after the release, inside the window: waited for.
  await event("a2", "queued", "2026-09-20", "2026-10-17T09:00:00.000Z");
  assert.equal((await run()).status, "later");
  // A run silent for days is not waited for.
  await event("a2", "started", "2026-09-20", "2026-10-14T09:00:00.000Z");
  assert.equal((await run()).status, "done");
  // An old release outside the window is not waited for even when queued.
  await event("a3", "queued", "2026-07-01", "2026-10-17T09:00:00.000Z");
  assert.equal((await run()).status, "done");
});
