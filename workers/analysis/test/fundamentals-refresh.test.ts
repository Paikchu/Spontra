import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { normalizeCompanyFacts } from "../src/sec/history.ts";
import { buildSecFundamentals, secFundamentalsKey } from "../src/fundamentals/sec-fundamentals.ts";
import { refreshSecFundamentals, snapshotQuarter } from "../src/fundamentals/refresh.ts";
import { SUBSCRIPTIONS, TASKS } from "../src/pipeline/registry.ts";
import { readFindingFundamentals } from "../../../shared/analysis-runtime/findings.ts";
import { fundamentalsBehind, latestFundamentalsQuarter } from "../../../shared/analysis-runtime/fundamentals-freshness.ts";

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

/** Alphabet's Company Facts as SEC served them before and after the 10-Q for the quarter to 2026-09-30 reached them. */
const Q = (start: string, end: string, val: number, accn: string, filed: string, fp: string) => ({ start, end, val, form: "10-Q", accn, filed, fy: 2026, fp });
const Q2 = ["0001652044-26-000071", "2026-07-23", "Q2"] as const, Q3 = ["0001652044-26-000084", "2026-10-29", "Q3"] as const;
const facts = (withQ3: boolean) => ({ facts: { "us-gaap": {
  Revenues: { units: { USD: [Q("2026-04-01", "2026-06-30", 119_796e6, ...Q2), ...(withQ3 ? [Q("2026-07-01", "2026-09-30", 127_577e6, ...Q3)] : [])] } },
  OperatingIncomeLoss: { units: { USD: [Q("2026-04-01", "2026-06-30", 40_770e6, ...Q2), ...(withQ3 ? [Q("2026-07-01", "2026-09-30", 40_576e6, ...Q3)] : [])] } },
} } });
const GOOGL = "0001652044";

async function seed(db: D1Database, stored: unknown) {
  const flow = { schemaVersion: "business-flow.v1", ticker: "GOOGL", fetchedAt: "2026-10-29T22:00:00Z", quarters: [
    { id: "q3", periodEnd: "2026-09-30", reportedAt: "2026-10-29T21:00:00Z", figures: {}, segments: [], sources: [] },
    { id: "q2", periodEnd: "2026-06-30", reportedAt: "2026-07-23T21:00:00Z", figures: {}, segments: [], sources: [] }] };
  await db.prepare("INSERT INTO financial_complete_versions (version_id, cik, ticker, generation, payload_json, published_at) VALUES ('v1', ?, 'GOOGL', 1, ?, '2026-10-29T22:00:00Z')").bind(GOOGL, JSON.stringify(flow)).run();
  await db.prepare("INSERT INTO financial_complete_current (cik, version_id, generation) VALUES (?, 'v1', 1)").bind(GOOGL).run();
  if (stored) await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, '2026-10-29T21:05:00Z')").bind(secFundamentalsKey("GOOGL"), JSON.stringify(stored)).run();
}
const answer = (body: unknown) => (async (url: RequestInfo | URL) => String(url).endsWith(`CIK${GOOGL}.json`) ? Response.json(body) : new Response("no", { status: 404 })) as typeof fetch;
const env = (db: D1Database) => ({ DB: db, SEC_USER_AGENT: "test agent" });
const events = async (db: D1Database) => (await db.prepare("SELECT type, ticker FROM pipeline_outbox").all<{ type: string; ticker: string }>()).results.map(r => ({ ...r }));
const stored = async (db: D1Database) => JSON.parse((await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = ?").bind(secFundamentalsKey("GOOGL")).first<{ payload: string }>())!.payload);

test("B9: GOOGL's fundamentals stopped at 2026-06-30 catch up with the 2026-09-30 statements once Company Facts has them", async () => {
  const db = database();
  // Read on discovery, before SEC added the quarter: the stored snapshot ends at 2026-06-30.
  await seed(db, normalizeCompanyFacts("GOOGL", facts(false)));
  const early = await refreshSecFundamentals(env(db), "GOOGL", answer(facts(false)), new Date("2026-10-30T00:00:00Z"));
  assert.deepEqual([early.status, early.published, early.stored, early.facts, early.retryAfterMs], ["behind", "2026-09-30", "2026-06-30", "2026-06-30", 6 * 3_600_000]);
  assert.deepEqual(await events(db), []);
  // Company Facts now has the quarter: the snapshot moves to it and downstream tasks hear of it once.
  const later = await refreshSecFundamentals(env(db), "GOOGL", answer(facts(true)), new Date("2026-10-30T06:00:00Z"));
  assert.deepEqual([later.status, later.facts], ["updated", "2026-09-30"]);
  assert.equal(snapshotQuarter(await stored(db)), "2026-09-30");
  assert.deepEqual(await events(db), [{ type: "fundamentals.updated", ticker: "GOOGL" }]);
  const again = await refreshSecFundamentals(env(db), "GOOGL", answer(facts(true)), new Date("2026-10-30T07:00:00Z"));
  assert.equal(again.status, "unchanged");
  assert.equal((await events(db)).length, 1);
  // The public response then reaches the page's latest quarter.
  const response = await buildSecFundamentals(await stored(db), { ticker: "GOOGL", periodCount: 12 } as never, null);
  assert.equal(fundamentalsBehind(latestFundamentalsQuarter(response.series), "2026-09-30"), false);
});

test("B9: a refresh is retried for two weeks after the filing, and a first read with nothing stored publishes at once", async () => {
  const db = database();
  await seed(db, null);
  const first = await refreshSecFundamentals(env(db), "GOOGL", answer(facts(false)), new Date("2026-11-20T00:00:00Z"));
  // Behind, but 22 days after the filing: written (nothing was stored), not retried.
  assert.deepEqual([first.status, first.retryAfterMs], ["behind", null]);
  assert.equal(snapshotQuarter(await stored(db)), "2026-06-30");
  assert.deepEqual(await events(db), [{ type: "fundamentals.updated", ticker: "GOOGL" }]);
});

test("B9: the fundamentals task runs on every statements publication", () => {
  assert.ok(SUBSCRIPTIONS["financials.published"]!.some(s => s.task === "fundamentals"));
  assert.deepEqual(TASKS.fundamentals.emits, ["fundamentals.updated"]);
});

test("B9: fundamentals are never older than the page's latest quarter (the check)", () => {
  const series = (category: string, points: Array<[string, string | null]>) => ({ category, points: points.map(([periodEnd, valueDecimal]) => ({ periodEnd, valueDecimal })) });
  const googl = [series("income_statement", [["2026-03-31", "1"], ["2026-06-30", "1"]]), series("balance_sheet", [["2026-09-30", "1"]])];
  assert.equal(latestFundamentalsQuarter(googl), "2026-06-30");
  assert.equal(fundamentalsBehind("2026-06-30", "2026-09-30"), true);
  // 52/53-week quarters end a few days apart from the calendar.
  assert.equal(fundamentalsBehind("2026-07-26", "2026-07-31"), false);
  assert.equal(fundamentalsBehind(null, "2026-09-30"), true);
  assert.equal(fundamentalsBehind(null, null), false);
});

/** Nebius as Company Facts serves it: statements tagged only in 20-F annual reports, year-end balances. */
const NBIS = { facts: { "us-gaap": {
  Revenues: { units: { USD: [{ start: "2025-01-01", end: "2025-12-31", val: 529_800_000, form: "20-F", accn: "0001104659-26-000001", filed: "2026-03-01", fy: 2025, fp: "FY" }] } },
  Assets: { units: { USD: [{ end: "2025-12-31", val: 12_430_600_000, form: "20-F", accn: "0001104659-26-000001", filed: "2026-03-01", fy: 2025, fp: "FY" }] } },
} } };

test("B9: NBIS has periods but no quarterly statement value: unavailable, annual only, never ready-and-empty", async () => {
  const response = await buildSecFundamentals(normalizeCompanyFacts("NBIS", NBIS), { ticker: "NBIS", periodCount: 12 } as never, null);
  assert.deepEqual([response.status, response.unavailableReason], ["unavailable", "annual_only"]);
  assert.equal(response.series.find(s => s.metricKey === "total_assets")?.available, true);
  const read = readFindingFundamentals(response, "NBIS")!;
  assert.deepEqual(read.unavailable, { reason: "annual_only" });
  assert.ok(read.series.some(s => s.metricKey === "total_assets"));
  // A company with quarterly values stays ready.
  const ready = await buildSecFundamentals(normalizeCompanyFacts("GOOGL", facts(true)), { ticker: "GOOGL", periodCount: 12 } as never, null);
  assert.equal(ready.status, "ready");
  assert.equal(readFindingFundamentals(ready, "GOOGL")!.unavailable, undefined);
});
