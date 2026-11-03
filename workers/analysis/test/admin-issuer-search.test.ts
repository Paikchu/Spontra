import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { companyName, issuerDirectory, parseIssuerDirectory, refreshListings, searchIssuers, securities } from "../src/catalog/issuer-directory.ts";

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
  const reader = { issuerDirectory: async () => { reads++; if (fail) throw new Error("SEC_ACCESS_PAUSED"); return directory; } };
  const first = await issuerDirectory(db, reader, new Date("2026-10-22T08:00:00Z"));
  assert.equal(first.length, 12);
  assert.equal(reads, 1);
  await issuerDirectory(db, reader, new Date("2026-10-22T20:00:00Z"));
  assert.equal(reads, 1);
  const stored = await db.prepare("SELECT fetched_at FROM sec_cache WHERE cache_key='catalog:issuer-directory:v2'").first<{ fetched_at: string }>();
  assert.equal(stored?.fetched_at, "2026-10-22T08:00:00.000Z");
  fail = true;
  const stale = await issuerDirectory(db, reader, new Date("2026-10-24T08:00:00Z"));
  assert.equal(reads, 2);
  assert.equal(stale.length, 12);
});

test("a company is named by its listing title, else by EDGAR's name; an ETF says so; the listing is read from Nasdaq Trader at most once a day", async () => {
  const db = database();
  await issuerDirectory(db, { read: async () => new Response(JSON.stringify(directory)) }, new Date());
  const filler = Array.from({ length: 1000 }, (_, i) => `Y|Q${String.fromCharCode(65 + i % 26)}${String.fromCharCode(65 + Math.floor(i / 26) % 26)}${String.fromCharCode(65 + Math.floor(i / 676))}|Filler ${i} Common Stock|N| |N|100|N||||N`);
  const listing = ["Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares",
    "Y|GOOGL|Alphabet Inc. - Class A Common Stock|Q|Q|N|40|N|N||GOOGL|N", "Y|BRK.B|Berkshire Hathaway Inc. New Common Stock|N| |N|40|N||BRK.B|BRK.B|N", "Y|IDXF|Example Index Fund|P| |Y|100|N||IDXF|IDXF|N", ...filler].join("\n");
  let reads = 0;
  const fetcher = (async () => { reads++; return new Response(listing); }) as unknown as typeof fetch;
  await refreshListings(db, fetcher, new Date());
  await refreshListings(db, fetcher, new Date());
  assert.equal(reads, 1);
  const named = await securities(db);
  assert.deepEqual(named("GOOGL"), { name: "Alphabet Inc.", etf: false });
  assert.deepEqual(named("brk-b"), { name: "Berkshire Hathaway Inc.", etf: false });
  assert.deepEqual(named("IDXF"), { name: "Example Index Fund", etf: true });
  // Listed by EDGAR only: EDGAR's own spelling.
  assert.deepEqual(named("AMZN"), { name: "AMAZON COM INC", etf: false });
  assert.equal(named("ZZZZZZ"), null);
  assert.equal(await companyName(db, "GOOGL"), "Alphabet Inc.");
  // A day later the listing is read again; a failed read keeps the copy and says why.
  await assert.rejects(refreshListings(db, (async () => new Response("", { status: 503 })) as unknown as typeof fetch, new Date(Date.now() + 2 * 86_400_000)), /LISTINGS_UNAVAILABLE/);
  assert.deepEqual((await securities(db))("GOOGL"), { name: "Alphabet Inc.", etf: false });
});
