import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { CompanyEvent, InsiderLine, InsiderTransaction } from "../../../shared/analysis-contract/events.ts";
import { insiderPersonKey, personsFromEvents, readInsidersPublication } from "../../../shared/analysis-runtime/insiders.ts";
import { parseForm4 } from "../src/events/form4.ts";
import { readInsidersResponse, readInsiderTransactionsResponse, recordedAccessions, recordInsiderFilings, type InsiderFilingInput } from "../src/events/insider-ledger.ts";
import { refreshCompanyEvents } from "../src/events/workflow.ts";
import { AnalysisRequestError } from "../src/read-api/contract-support/errors.ts";
import type { AnalysisEnv } from "../src/operations.ts";

/** Form 4 documents as EDGAR serves them: TSMC's purchase, NVIDIA's grant, Buffett's Berkshire filing and Berkshire selling DaVita. */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/form4/${name}`, import.meta.url), "utf8");
const TSM = parseForm4(fixture("tsm-0001046179-26-000724.xml"))!, DVA = parseForm4(fixture("brk-dva-0001193125-26-438090.xml"))!, BRK_OWN = parseForm4(fixture("brk-own-0001193125-26-304843.xml"))!;
const TSM_CIK = "0001046179", BRK = "0001067983";

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

const NOW = new Date("2026-10-30T10:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10);
const root = "https://www.sec.gov/Archives/edgar/data/1046179";
const line = (date: string, code: InsiderLine["code"], shares: number, price: number | null, ownedAfter: number, acquiredDisposed: "A" | "D" = code === "S" ? "D" : "A"): InsiderLine =>
  ({ date, code, acquiredDisposed, shares, price, ownedAfter, ownership: "D", derivative: false });
/** A filing for the company, built on TSMC's parsed document: the owner and the lines are what each test sets. */
const filing = (id: string, filedAt: string, lines: InsiderLine[], owner: Partial<InsiderTransaction> = {}, seenAt = `${filedAt}T00:00:00.000Z`): InsiderFilingInput => ({
  ticker: "TSM", companyCik: TSM_CIK, seenAt, transaction: { ...TSM, lines, ...owner },
  event: { id, form: "4", filedAt, documentUrl: `${root}/${id.replaceAll("-", "")}/xslF345X06/form4.xml`, edgarUrl: `${root}/${id.replaceAll("-", "")}/${id}-index.html` },
});
const count = async (db: D1Database, sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

test("lines group by reporting owner CIK across filings, padded or not; a filing without one groups by its normalized name", async () => {
  const db = database();
  const result = await recordInsiderFilings(db, [
    filing("0001046179-26-000724", "2026-10-08", [line("2026-10-07", "P", 1_000, 290, 11_000)]),
    filing("0001046179-26-000800", "2026-10-20", [line("2026-10-19", "P", 500, 300, 11_500), line("2026-10-19", "S", 200, 310, 11_300)], { ownerCik: "0002114024" }),
    filing("0001046179-26-000900", "2026-09-01", [line("2026-08-30", "S", 3_000, 250, 90_000)], { ownerCik: "", ownerName: "  Wei  C.C. ", title: "Chief Executive Officer" }),
  ], NOW);
  assert.deepEqual(result, { recorded: 3, skipped: 0, persons: 2 });
  const response = await readInsidersResponse(db, "tsm", NOW);
  assert.equal(response.status, "ready");
  const persons = response.insiders!.persons;
  assert.equal(response.insiders!.source, "ledger");
  // Latest trade first: Yuan's two filings are one person with three lines, netted; Wei is keyed by name.
  assert.deepEqual(persons.map(p => [p.key, p.name, p.transactions, p.filings, p.lastTradeAt]), [["2114024", "Yuan Lipen", 3, 2, "2026-10-19"], ["name:wei c c", "Wei C.C.", 1, 1, "2026-08-30"]]);
  const yuan = persons[0]!;
  assert.deepEqual({ sold: yuan.sold, bought: yuan.bought, net: yuan.net, heldAfter: yuan.heldAfter }, {
    sold: { shares: 200, value: 62_000, count: 1, pricedValue: 62_000, pricedCount: 1, unpricedCount: 0 },
    bought: { shares: 1_500, value: 440_000, count: 2, pricedValue: 440_000, pricedCount: 2, unpricedCount: 0 },
    net: { shares: 1_300, value: 378_000, complete: true }, heldAfter: 11_300,
  });
  assert.equal(yuan.latest!.id, "0001046179-26-000800:1");
  assert.equal(yuan.latest!.side, "sell");
  assert.deepEqual([persons[1]!.role.title, persons[1]!.ownerCik], ["Chief Executive Officer", null]);
  // The same grouping from the rail, so the fallback and the ledger name the same people.
  const events = [filing("0001046179-26-000724", "2026-10-08", [line("2026-10-07", "P", 1_000, 290, 11_000)]), filing("0001046179-26-000800", "2026-10-20", [line("2026-10-19", "P", 500, 300, 11_500)], { ownerCik: "0002114024" })]
    .map((f): CompanyEvent => ({ ...f.event, ticker: "TSM", eventDate: f.event.filedAt, items: [], class: "insider", description: "", title: null, importance: "normal", exhibits: [], summary: null, insider: f.transaction }));
  assert.deepEqual(personsFromEvents(events, NOW).map(p => [p.key, p.transactions]), [["2114024", 2]]);
  assert.equal(insiderPersonKey({ ownerCik: "0002114024", ownerName: "x" }), "2114024");
});

for (const side of ["S", "P"] as const) test(`an older unpriced ${side} line makes ledger and fallback totals and net unknown`, async () => {
  const db = database();
  const filings = [
    filing("0001046179-26-000700", "2026-07-10", [line("2026-07-09", side, 100, null, 10_000)]),
    filing("0001046179-26-000800", "2026-10-20", [line("2026-10-19", side, 200, 310, 10_200), line("2026-10-19", "G", 50, null, 10_250)]),
  ];
  await recordInsiderFilings(db, filings, NOW);
  const ledger = (await readInsidersResponse(db, "TSM", NOW)).insiders!;
  const person = ledger.persons[0]!;
  const totals = side === "S" ? person.sold : person.bought;
  const other = side === "S" ? person.bought : person.sold;
  assert.deepEqual(totals, { shares: 300, value: null, count: 2, pricedValue: 62_000, pricedCount: 1, unpricedCount: 1 });
  assert.deepEqual(other, { shares: 0, value: 0, count: 0, pricedValue: 0, pricedCount: 0, unpricedCount: 0 });
  assert.deepEqual(person.net, { shares: side === "S" ? -300 : 300, value: null, complete: false });
  assert.equal(person.transactions, 3, "unpriced gifts are not counted in open-market totals");
  // The existing NOT NULL columns still hold known subtotals; the API derives coverage from all lines, including history.
  const stored = await db.prepare("SELECT sold_value, bought_value, net_value FROM insider_persons WHERE ticker = ?").bind("TSM").first<{ sold_value: number; bought_value: number; net_value: number }>();
  assert.deepEqual({ ...stored }, { sold_value: side === "S" ? 62_000 : 0, bought_value: side === "P" ? 62_000 : 0, net_value: side === "S" ? -62_000 : 62_000 });
  const events = filings.map((f): CompanyEvent => ({ ...f.event, ticker: "TSM", eventDate: f.event.filedAt, items: [], class: "insider", description: "", title: null, importance: "normal", exhibits: [], summary: null, insider: f.transaction }));
  const fallback = personsFromEvents(events, NOW)[0]!;
  assert.deepEqual({ sold: fallback.sold, bought: fallback.bought, net: fallback.net }, { sold: person.sold, bought: person.bought, net: person.net });
  const parsed = readInsidersPublication(ledger, "TSM")!.persons[0]!;
  assert.deepEqual({ sold: parsed.sold, bought: parsed.bought, net: parsed.net }, { sold: person.sold, bought: person.bought, net: person.net }, "null values and coverage survive validation");
  // Re-reading an unpriced filing with its price supplied restores exact values without a migration.
  await recordInsiderFilings(db, [{ ...filings[0]!, transaction: { ...filings[0]!.transaction, lines: [line("2026-07-09", side, 100, 300, 10_000)] } }], NOW);
  const corrected = (await readInsidersResponse(db, "TSM", NOW)).insiders!.persons[0]!;
  assert.deepEqual(side === "S" ? corrected.sold : corrected.bought, { shares: 300, value: 92_000, count: 2, pricedValue: 92_000, pricedCount: 2, unpricedCount: 0 });
  assert.deepEqual(corrected.net, { shares: side === "S" ? -300 : 300, value: side === "S" ? -92_000 : 92_000, complete: true });
});

test("fully unpriced lines stay unknown while a reported zero price counts as priced", async () => {
  const db = database();
  await recordInsiderFilings(db, [filing("0001046179-26-000724", "2026-10-08", [line("2026-10-07", "S", 100, null, 10_000), line("2026-10-07", "P", 50, 0, 10_050)])], NOW);
  const person = (await readInsidersResponse(db, "TSM", NOW)).insiders!.persons[0]!;
  assert.deepEqual(person.sold, { shares: 100, value: null, count: 1, pricedValue: 0, pricedCount: 0, unpricedCount: 1 });
  assert.deepEqual(person.bought, { shares: 50, value: 0, count: 1, pricedValue: 0, pricedCount: 1, unpricedCount: 0 });
  assert.deepEqual(person.net, { shares: -50, value: null, complete: false });
});

test("legacy person publications without coverage retain their reported amounts", async () => {
  const db = database();
  await recordInsiderFilings(db, [filing("0001046179-26-000724", "2026-10-08", [line("2026-10-07", "S", 100, 300, 10_000)])], NOW);
  const publication = (await readInsidersResponse(db, "TSM", NOW)).insiders!;
  const person = publication.persons[0]!;
  const legacy = { ...publication, persons: [{ ...person,
    sold: { shares: 100, value: 30_000, count: 1 }, bought: { shares: 0, value: 0, count: 0 }, net: { shares: -100, value: -30_000 },
  }] };
  assert.deepEqual(readInsidersPublication(legacy, "TSM"), readInsidersPublication(publication, "TSM"));
  for (const value of [NaN, Infinity]) {
    assert.equal(readInsidersPublication({ ...publication, persons: [{ ...person, sold: { ...person.sold, value } }] }, "TSM"), null);
    assert.equal(readInsidersPublication({ ...publication, persons: [{ ...person, net: { ...person.net, value } }] }, "TSM"), null);
  }
});

test("recording the same filing again rewrites the same rows and keeps when they were first seen", async () => {
  const db = database();
  const first = filing("0001046179-26-000724", daysAgo(3), [line(daysAgo(4), "P", 1_000, 290, 11_000), line(daysAgo(4), "P", 200, 291, 11_200)], {}, NOW.toISOString());
  await recordInsiderFilings(db, [first], NOW);
  const later = new Date(NOW.getTime() + 5 * 86_400_000);
  const again = await recordInsiderFilings(db, [{ ...first, seenAt: later.toISOString(), transaction: { ...first.transaction, title: "Director" } }], later);
  assert.deepEqual(again, { recorded: 1, skipped: 0, persons: 1 });
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM insider_transactions WHERE ticker = ?", "TSM"), 2);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM insider_persons WHERE ticker = ?", "TSM"), 1);
  const rows = await db.prepare("SELECT first_seen_at, ingested_at, title FROM insider_transactions WHERE ticker = ? ORDER BY line_no").bind("TSM").all<{ first_seen_at: string; ingested_at: string; title: string }>();
  assert.deepEqual(rows.results.map(r => [r.first_seen_at, r.ingested_at, r.title]), [[NOW.toISOString(), later.toISOString(), "Director"], [NOW.toISOString(), later.toISOString(), "Director"]]);
  const person = (await readInsidersResponse(db, "TSM", later)).insiders!.persons[0]!;
  assert.deepEqual([person.transactions, person.filings, person.bought.shares, person.role.title], [2, 1, 1_200, "Director"]);
  assert.deepEqual([...await recordedAccessions(db, "TSM")], ["0001046179-26-000724"]);
});

test("a line is new while it was filed and first recorded within the window; history filled in bulk never is", async () => {
  const db = database();
  await recordInsiderFilings(db, [
    // Read by the refresh two days after it was filed: new, for fourteen days from the read.
    filing("0001046179-26-000800", daysAgo(2), [line(daysAgo(3), "S", 200, 310, 11_300)], {}, NOW.toISOString()),
    // Backfilled history: first seen on its filing date, sixty days ago.
    filing("0001046179-26-000724", daysAgo(60), [line(daysAgo(61), "P", 1_000, 290, 11_000)]),
    // An old filing the ledger only learned of now (a late re-read): the filing itself is old, so it is not news.
    filing("0001046179-26-000500", daysAgo(120), [line(daysAgo(121), "P", 100, 200, 10_000)], { ownerCik: "7", ownerName: "Old Hand" }, NOW.toISOString()),
  ], NOW);
  const read = async (at: Date) => (await readInsidersResponse(db, "TSM", at)).insiders!.persons;
  const [yuan, old] = await read(NOW);
  assert.deepEqual([yuan!.newCount, yuan!.latest!.isNew, yuan!.lastNewTradeAt], [1, true, NOW.toISOString()]);
  assert.deepEqual([old!.newCount, old!.latest!.isNew, old!.lastNewTradeAt], [0, false, null]);
  const history = (await readInsiderTransactionsResponse(db, "TSM", "2114024", null, null, NOW)).transactions!;
  assert.deepEqual(history.items.map(r => [r.accession, r.isNew]), [["0001046179-26-000800", true], ["0001046179-26-000724", false]]);
  // Twenty days on, nothing is new any more, and the last time something was stays on the person.
  const twentyDays = new Date(NOW.getTime() + 20 * 86_400_000);
  const [yuanLater] = await read(twentyDays);
  assert.deepEqual([yuanLater!.newCount, yuanLater!.latest!.isNew, yuanLater!.lastNewTradeAt], [0, false, NOW.toISOString()]);
});

test("a filing whose issuer is another company never enters the ledger, from a direct record or from the event refresh", async () => {
  const db = database();
  const foreign: InsiderFilingInput = { ticker: "BRK.B", companyCik: BRK, seenAt: NOW.toISOString(), transaction: DVA, event: { id: "0001193125-26-438090", form: "4", filedAt: "2026-10-29", documentUrl: "https://www.sec.gov/a/b/x.xml", edgarUrl: "https://www.sec.gov/a/b/x-index.html" } };
  const own: InsiderFilingInput = { ...foreign, transaction: BRK_OWN, event: { ...foreign.event, id: "0001193125-26-304843", filedAt: "2026-07-15" } };
  assert.deepEqual(await recordInsiderFilings(db, [foreign, own], NOW), { recorded: 1, skipped: 1, persons: 1 });
  assert.deepEqual((await readInsidersResponse(db, "BRK.B", NOW)).insiders!.persons.map(p => [p.key, p.name, p.filings]), [["315090", "BUFFETT WARREN E", 1]]);

  // The refresh itself: the DaVita filing is recorded as another issuer's and the ledger holds only the company's own.
  const viaRefresh = database();
  await viaRefresh.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)").bind("sec:discovery:v1:BRK.B", JSON.stringify({ cik: BRK, accessions: [], checkedAt: NOW.toISOString() }), NOW.toISOString()).run();
  const filings = [["0001193125-26-438090", "2026-10-29", fixture("brk-dva-0001193125-26-438090.xml")], ["0001193125-26-304843", "2026-07-15", fixture("brk-own-0001193125-26-304843.xml")]] as const;
  const submissions = { filings: { recent: {
    accessionNumber: filings.map(f => f[0]), form: filings.map(() => "4"), filingDate: filings.map(f => f[1]), reportDate: filings.map(f => f[1]),
    primaryDocument: filings.map(() => "xslF345X06/ownership.xml"), primaryDocDescription: filings.map(() => "FORM 4"), items: filings.map(() => ""),
  } } };
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(`CIK${BRK}.json`)) return Response.json(submissions);
    const hit = filings.find(f => url.includes(f[0].replaceAll("-", "")));
    return hit ? new Response(hit[2]) : new Response("not here", { status: 404 });
  }) as typeof fetch;
  const env = { DB: viaRefresh, SEC_USER_AGENT: "test agent", SEC_DATA_TICKERS: "", SEC_AI_TICKERS: "", SEC_AI_ENABLED: "false" } as unknown as AnalysisEnv;
  await refreshCompanyEvents(env, "BRK.B", fetcher, NOW, { forceList: true });
  assert.deepEqual([...await recordedAccessions(viaRefresh, "BRK.B")], ["0001193125-26-304843"]);
  // Read just now by the refresh, the July filing is not news: the filing itself is months old.
  const persons = (await readInsidersResponse(viaRefresh, "BRK.B", NOW)).insiders!.persons;
  assert.deepEqual(persons.map(p => [p.name, p.transactions, p.newCount]), [["BUFFETT WARREN E", BRK_OWN.lines.length, 0]]);
  // A second refresh records nothing twice.
  await refreshCompanyEvents(env, "BRK.B", fetcher, NOW, { forceList: true });
  assert.equal(await count(viaRefresh, "SELECT COUNT(*) AS n FROM insider_transactions WHERE ticker = ?", "BRK.B"), BRK_OWN.lines.length);
});

test("a person's history pages newest first through an opaque cursor, without gaps or repeats", async () => {
  const db = database();
  await recordInsiderFilings(db, [
    filing("0001046179-26-000700", "2026-09-10", [line("2026-09-09", "P", 10, 100, 110), line("2026-09-09", "S", 5, 101, 105)]),
    filing("0001046179-26-000800", "2026-10-01", [line("2026-09-30", "P", 20, 102, 125)]),
    filing("0001046179-26-000900", "2026-10-20", [line("2026-10-19", "S", 1, 103, 124), line("2026-10-18", "P", 2, 104, 126)]),
    filing("0001046179-26-000950", "2026-10-21", [line("2026-10-19", "M", 4, null, 128)], { ownerCik: "99", ownerName: "Someone Else" }),
  ], NOW);
  const pages: string[][] = [];
  let cursor: string | null = null;
  do {
    const page = (await readInsiderTransactionsResponse(db, "TSM", "2114024", cursor, "2", NOW)).transactions!;
    assert.ok(page.items.length <= 2);
    pages.push(page.items.map(r => r.id));
    cursor = page.nextCursor;
  } while (cursor);
  // Within a filing, lines of one date list in reverse: the later-listed line first, as the cursor orders them.
  assert.deepEqual(pages, [["0001046179-26-000900:0", "0001046179-26-000900:1"], ["0001046179-26-000800:0", "0001046179-26-000700:1"], ["0001046179-26-000700:0"]]);
  const whole = (await readInsiderTransactionsResponse(db, "TSM", "2114024", null, null, NOW)).transactions!;
  assert.equal(whole.nextCursor, null);
  assert.deepEqual(whole.items.map(r => [r.date, r.code, r.shares, r.price, r.value, r.ownedAfter]), [
    ["2026-10-19", "S", 1, 103, 103, 124], ["2026-10-18", "P", 2, 104, 208, 126], ["2026-09-30", "P", 20, 102, 2_040, 125], ["2026-09-09", "S", 5, 101, 505, 105], ["2026-09-09", "P", 10, 100, 1_000, 110]]);
  assert.equal(whole.items[0]!.filingUrl, `${root}/000104617926000900/xslF345X06/form4.xml`);
  // Someone else's page is theirs alone; an unknown person has an empty page; a bad cursor or key is refused.
  assert.deepEqual((await readInsiderTransactionsResponse(db, "TSM", "99", null, "50", NOW)).transactions!.items.map(r => r.code), ["M"]);
  assert.deepEqual((await readInsiderTransactionsResponse(db, "TSM", "12345", null, null, NOW)).transactions!.items, []);
  await assert.rejects(readInsiderTransactionsResponse(db, "TSM", "2114024", "yesterday", null, NOW), (e: unknown) => e instanceof AnalysisRequestError && e.code === "INVALID_CURSOR");
  await assert.rejects(readInsiderTransactionsResponse(db, "TSM", "../x", null, null, NOW), (e: unknown) => e instanceof AnalysisRequestError && e.code === "ROUTE_NOT_FOUND");
});

test("before the ledger is filled, the stored event rail answers both reads, grouped the same way", async () => {
  const db = database();
  assert.equal((await readInsidersResponse(db, "TSM", NOW)).status, "preparing");
  const events = [filing("0001046179-26-000724", "2026-10-08", [line("2026-10-07", "P", 1_000, 290, 11_000)]), filing("0001046179-26-000800", "2026-10-20", [line("2026-10-19", "S", 200, 310, 10_800)])]
    .map((f): CompanyEvent => ({ ...f.event, ticker: "TSM", eventDate: f.event.filedAt, items: [], class: "insider", description: "", title: null, importance: "normal", exhibits: [], summary: null, insider: f.transaction }));
  await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)").bind("events:v1:TSM", JSON.stringify({ schemaVersion: "events.v1", ticker: "TSM", checkedAt: NOW.toISOString(), events, pendingInsider: 0 }), NOW.toISOString()).run();
  const persons = await readInsidersResponse(db, "TSM", NOW);
  assert.deepEqual([persons.insiders!.source, persons.insiders!.persons.map(p => [p.key, p.transactions, p.net.shares])], ["events", [["2114024", 2, 800]]]);
  const page = (await readInsiderTransactionsResponse(db, "TSM", "2114024", null, "1", NOW)).transactions!;
  assert.deepEqual([page.source, page.items.map(r => r.id), page.nextCursor != null], ["events", ["0001046179-26-000800:0"], true]);
  const rest = (await readInsiderTransactionsResponse(db, "TSM", "2114024", page.nextCursor, "1", NOW)).transactions!;
  assert.deepEqual([rest.items.map(r => r.id), rest.nextCursor], [["0001046179-26-000724:0"], null]);
});
