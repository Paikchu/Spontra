import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { issuerDirectory, parseIssuerDirectory, searchIssuers } from "../src/admin/issuer-search.ts";

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
const directory = {
  fields: ["cik", "name", "ticker", "exchange"],
  data: [
    [320193, "Apple Inc.", "AAPL", "Nasdaq"], [1067983, "BERKSHIRE HATHAWAY INC", "BRK-B", "NYSE"], [1067983, "BERKSHIRE HATHAWAY INC", "BRK-A", "NYSE"],
    [1018724, "AMAZON COM INC", "AMZN", "Nasdaq"], [1652044, "Alphabet Inc.", "GOOGL", "Nasdaq"], [1652044, "Alphabet Inc.", "GOOG", "Nasdaq"],
    [1769628, "CoreWeave, Inc.", "CRWV", "Nasdaq"], [2000001, "Applied Materials Inc", "AMAT", "Nasdaq"], [2000002, "Snapple Beverage Co", "SNPL", "NYSE"],
    [2000003, "Berkshire Hills Bancorp", "BHLB", "NYSE"], [2000004, "AAPL Units Corp", "AAPLU", null], [2000005, "AppLovin Corp", "APP", "Nasdaq"],
  ],
};
const entries = parseIssuerDirectory(directory);

test("a fragment ranks the ticker itself, then ticker and name starts, later name words, name substrings, and tickers containing it", () => {
  assert.deepEqual(searchIssuers(entries, "aapl").map(s => s.ticker), ["AAPL", "AAPLU"]);
  // A name's start ranks with a ticker prefix, the shorter ticker first; a later word next; a substring (Snapple) last.
  assert.deepEqual(searchIssuers(entries, "app").map(s => s.ticker), ["APP", "AAPL", "AMAT", "SNPL"]);
  assert.deepEqual(searchIssuers(entries, "hathaway").map(s => s.ticker), ["BRK.A", "BRK.B"]);
  // Dashes read as dots, the way the whitelist spells share classes; the shorter ticker lists first.
  assert.deepEqual(searchIssuers(entries, "brk-").map(s => s.ticker), ["BRK.A", "BRK.B"]);
  assert.deepEqual(searchIssuers(entries, "berkshire").map(s => s.ticker), ["BHLB", "BRK.A", "BRK.B"]);
  assert.deepEqual(searchIssuers(entries, "GOOG"), [{ ticker: "GOOG", name: "Alphabet Inc.", exchange: "Nasdaq" }, { ticker: "GOOGL", name: "Alphabet Inc.", exchange: "Nasdaq" }]);
  assert.deepEqual(searchIssuers(entries, "  "), []);
  assert.equal(searchIssuers(entries, "a", 3).length, 3);
  // Regex characters in the fragment are text.
  assert.deepEqual(searchIssuers(entries, "(inc"), []);
  assert.deepEqual(searchIssuers(entries, "AAPLU").at(0)?.exchange, "");
});

test("the directory is read from SEC once a day, served from D1 between reads, and the stored copy serves when SEC fails", async () => {
  const db = database();
  let reads = 0, fail = false;
  const reader = { read: async () => { reads++; if (fail) throw new Error("SEC_ACCESS_PAUSED"); return new Response(JSON.stringify(directory)); } };
  const first = await issuerDirectory(db, reader, new Date("2026-10-22T08:00:00Z"));
  assert.equal(first.length, 12);
  assert.equal(reads, 1);
  await issuerDirectory(db, reader, new Date("2026-10-22T20:00:00Z"));
  assert.equal(reads, 1);
  const stored = await db.prepare("SELECT fetched_at FROM sec_cache WHERE cache_key='admin:issuer-directory:v1'").first<{ fetched_at: string }>();
  assert.equal(stored?.fetched_at, "2026-10-22T08:00:00.000Z");
  fail = true;
  const stale = await issuerDirectory(db, reader, new Date("2026-10-24T08:00:00Z"));
  assert.equal(reads, 2);
  assert.equal(stale.length, 12);
});
