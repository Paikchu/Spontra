import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { normalizeCik, parseForm4 } from "../src/events/form4.ts";
import { refreshCompanyEvents, sameIssuer } from "../src/events/workflow.ts";
import { checkInsiderIssuers, eventForm4Url, withoutForeign } from "../src/events/foreign-insider.ts";
import { readEventsPublication } from "../../../shared/analysis-runtime/events.ts";
import type { EventsPublication } from "../../../shared/analysis-contract/events.ts";
import type { AnalysisEnv } from "../src/operations.ts";

/** Form 4 documents as EDGAR serves them: Berkshire selling DaVita, Buffett's own Berkshire filing, an NVIDIA and a TSMC filing. */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/form4/${name}`, import.meta.url), "utf8");
const DVA = fixture("brk-dva-0001193125-26-438090.xml"), BRK_OWN = fixture("brk-own-0001193125-26-304843.xml");
const NVDA = fixture("nvda-0002152188-26-000007.xml"), TSM = fixture("tsm-0001046179-26-000724.xml");

test("parseForm4 reads the issuer, its CIK without leading zeros", () => {
  assert.deepEqual([DVA, BRK_OWN, NVDA, TSM].map(xml => { const t = parseForm4(xml)!; return [t.issuerCik, t.issuerTradingSymbol]; }),
    [["927066", "DVA"], ["1067983", "BRK.A"], ["1045810", "NVDA"], ["1046179", "TSM"]]);
  assert.equal(parseForm4(DVA)!.ownerName, "BERKSHIRE HATHAWAY INC");
  assert.equal(normalizeCik("0001067983"), "1067983");
  assert.equal(normalizeCik(1067983), "1067983");
  assert.equal(normalizeCik("0"), "0");
});

test("a transaction is the company's when its issuer is the company, compared without leading zeros; one read before the issuer was parsed is kept", () => {
  const dva = parseForm4(DVA)!, own = parseForm4(BRK_OWN)!;
  assert.equal(sameIssuer(dva, "0001067983"), false);
  assert.equal(sameIssuer(own, "0001067983"), true);
  assert.equal(sameIssuer(own, 1067983), true);
  assert.equal(sameIssuer(parseForm4(NVDA)!, "0001045810"), true);
  assert.equal(sameIssuer(parseForm4(TSM)!, "0001046179"), true);
  const { issuerCik, issuerTradingSymbol, ...legacy } = dva; void issuerCik; void issuerTradingSymbol;
  assert.equal(sameIssuer(legacy, "0001067983"), true);
});

/* ---------- The event refresh over an in-memory D1 ---------- */

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
const env = (db: D1Database) => ({ DB: db, SEC_USER_AGENT: "test agent", SEC_DATA_TICKERS: "", SEC_AI_TICKERS: "", SEC_AI_ENABLED: "false" }) as unknown as AnalysisEnv;
const now = new Date("2026-10-30T10:00:00.000Z");
const BRK = "0001067983";
const stored = async (db: D1Database, key: string) => { const row = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = ?").bind(key).first<{ payload: string }>(); return row ? JSON.parse(row.payload) : null; };

test("the event refresh keeps the company's own Form 4s and records another issuer's once, neither published nor pending", async () => {
  const db = database();
  await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)").bind("sec:discovery:v1:BRK.B", JSON.stringify({ cik: BRK, accessions: [], checkedAt: now.toISOString() }), now.toISOString()).run();
  const filings = [["0001193125-26-438090", "2026-10-29", DVA], ["0001193125-26-304843", "2026-07-15", BRK_OWN]] as const;
  const submissions = { filings: { recent: {
    accessionNumber: filings.map(f => f[0]), form: filings.map(() => "4"), filingDate: filings.map(f => f[1]), reportDate: filings.map(f => f[1]),
    primaryDocument: filings.map(() => "xslF345X06/ownership.xml"), primaryDocDescription: filings.map(() => "FORM 4"), items: filings.map(() => ""),
  } } };
  const reads: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input); reads.push(url);
    if (url.endsWith(`CIK${BRK}.json`)) return Response.json(submissions);
    const hit = filings.find(f => url.includes(f[0].replaceAll("-", "")));
    return hit ? new Response(hit[2]) : new Response("not here", { status: 404 });
  }) as typeof fetch;
  const first = await refreshCompanyEvents(env(db), "BRK.B", fetcher, now, { forceList: true });
  assert.deepEqual({ insiderReads: first.insiderReads, pending: first.pending }, { insiderReads: 2, pending: 0 });
  const publication = readEventsPublication(await stored(db, "events:v1:BRK.B"), "BRK.B")!;
  assert.deepEqual(publication.events.map(e => [e.id, e.insider?.issuerCik]), [["0001193125-26-304843", "1067983"]]);
  assert.equal(publication.pendingInsider, 0);
  assert.deepEqual(await stored(db, "insider:v1:BRK.B:0001193125-26-438090"), { otherIssuer: "927066" });
  // The next refresh reads neither document again and still leaves the DaVita filing out.
  reads.length = 0;
  const again = await refreshCompanyEvents(env(db), "BRK.B", fetcher, now, { forceList: true });
  assert.equal(again.insiderReads, 0);
  assert.deepEqual(reads.filter(u => u.endsWith(".xml")), []);
  assert.deepEqual(readEventsPublication(await stored(db, "events:v1:BRK.B"), "BRK.B")!.events.map(e => e.id), ["0001193125-26-304843"]);
});

/* ---------- Cleaning publications stored before the issuer was parsed ---------- */

/** A publication as stored before the fix: both filings published, neither naming its issuer. */
function legacyPublication(): EventsPublication {
  const event = (id: string, xml: string, filedAt: string) => {
    const { issuerCik, issuerTradingSymbol, ...insider } = parseForm4(xml)!; void issuerCik; void issuerTradingSymbol;
    const root = `https://www.sec.gov/Archives/edgar/data/1067983/${id.replaceAll("-", "")}`;
    return { id, ticker: "BRK.B", form: "4" as const, filedAt, eventDate: filedAt, items: [], class: "insider" as const, description: "FORM 4", title: null,
      edgarUrl: `${root}/${id}-index.html`, documentUrl: `${root}/xslF345X06/ownership.xml`, exhibits: [], summary: null, insider };
  };
  return { schemaVersion: "events.v1", ticker: "BRK.B", checkedAt: now.toISOString(), pendingInsider: 0,
    events: [event("0001193125-26-438090", DVA, "2026-10-29"), event("0001193125-26-304843", BRK_OWN, "2026-07-15")] };
}

test("the cleanup re-reads stored Form 4s without an issuer and removes only another issuer's", async () => {
  const publication = legacyPublication();
  assert.equal(eventForm4Url(publication.events[0]!), "https://www.sec.gov/Archives/edgar/data/1067983/000119312526438090/ownership.xml");
  const documents: Record<string, string> = { "000119312526438090": DVA, "000119312526304843": BRK_OWN };
  const read = async (url: string) => documents[Object.keys(documents).find(k => url.includes(k))!] ?? null;
  const checks = await checkInsiderIssuers(publication, BRK, read);
  assert.deepEqual(checks.map(c => [c.event.id, c.issuerCik, c.foreign, c.via]), [
    ["0001193125-26-438090", "927066", true, "document"], ["0001193125-26-304843", "1067983", false, "document"]]);
  assert.deepEqual(withoutForeign(publication, checks)!.events.map(e => e.id), ["0001193125-26-304843"]);
  // A document that cannot be read is kept, and a clean publication needs no write.
  const unreadable = await checkInsiderIssuers(publication, BRK, async () => null);
  assert.deepEqual(unreadable.map(c => c.foreign), [false, false]);
  assert.equal(withoutForeign(publication, unreadable), null);
});

test("the company's own filings are never removed: NVIDIA's and TSMC's Form 4s name the company as issuer", async () => {
  for (const [xml, cik, ticker] of [[NVDA, "0001045810", "NVDA"], [TSM, "0001046179", "TSM"]] as const) {
    const t = parseForm4(xml)!;
    const publication: EventsPublication = { schemaVersion: "events.v1", ticker, checkedAt: now.toISOString(), pendingInsider: 0, events: [{
      id: "x", ticker, form: "4", filedAt: "2026-10-01", eventDate: "2026-10-01", items: [], class: "insider", description: "FORM 4", title: null,
      edgarUrl: "https://www.sec.gov/x-index.html", documentUrl: "https://www.sec.gov/Archives/edgar/data/1/2/xslF345X06/form4.xml", exhibits: [], summary: null, insider: t }] };
    const checks = await checkInsiderIssuers(publication, cik, async () => { throw new Error("a stored issuer needs no read"); });
    assert.deepEqual(checks.map(c => [c.foreign, c.via]), [[false, "stored"]]);
    assert.equal(withoutForeign(publication, checks), null);
  }
});

/* ---------- GOOGL: GV 2019 GP selling Ethos (LIFE) ---------- */

/** GV's sale of Ethos Technologies (LIFE) stock lists Alphabet as a reporting owner, so EDGAR files it in Alphabet's submissions. */
const GV_LIFE = fixture("googl-gv-life-0001168404-26-000041.xml");
const GOOGL = "0001652044";

test("GV 2019 GP's sale of Ethos (LIFE) is another issuer's Form 4, left off Alphabet's rail", async () => {
  const t = parseForm4(GV_LIFE)!;
  assert.deepEqual([t.issuerCik, t.issuerTradingSymbol, t.ownerName], ["1788451", "LIFE", "GV 2019 GP, L.L.C."]);
  assert.equal(sameIssuer(t, GOOGL), false);

  const db = database();
  await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)").bind("sec:discovery:v1:GOOGL", JSON.stringify({ cik: GOOGL, accessions: [], checkedAt: now.toISOString() }), now.toISOString()).run();
  const id = "0001168404-26-000041";
  const submissions = { filings: { recent: {
    accessionNumber: [id], form: ["4"], filingDate: ["2026-07-29"], reportDate: ["2026-07-27"],
    primaryDocument: ["xslF345X06/form4-07292026_110704.xml"], primaryDocDescription: ["FORM 4"], items: [""],
  } } };
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(`CIK${GOOGL}.json`)) return Response.json(submissions);
    return url.includes(id.replaceAll("-", "")) ? new Response(GV_LIFE) : new Response("not here", { status: 404 });
  }) as typeof fetch;
  const result = await refreshCompanyEvents(env(db), "GOOGL", fetcher, now, { forceList: true });
  assert.deepEqual({ insiderReads: result.insiderReads, pending: result.pending }, { insiderReads: 1, pending: 0 });
  assert.deepEqual(readEventsPublication(await stored(db, "events:v1:GOOGL"), "GOOGL")!.events.map(e => e.id), []);
  assert.deepEqual(await stored(db, `insider:v1:GOOGL:${id}`), { otherIssuer: "1788451" });

  // Stored before the fix (no issuer on the transaction), the cleanup re-reads the document and removes it.
  const { issuerCik, issuerTradingSymbol, ...insider } = t; void issuerCik; void issuerTradingSymbol;
  const root = `https://www.sec.gov/Archives/edgar/data/1652044/${id.replaceAll("-", "")}`;
  const legacy: EventsPublication = { schemaVersion: "events.v1", ticker: "GOOGL", checkedAt: now.toISOString(), pendingInsider: 0, events: [{
    id, ticker: "GOOGL", form: "4", filedAt: "2026-07-29", eventDate: "2026-07-27", items: [], class: "insider", description: "FORM 4", title: null,
    edgarUrl: `${root}/${id}-index.html`, documentUrl: `${root}/xslF345X06/form4-07292026_110704.xml`, exhibits: [], summary: null, insider }] };
  const checks = await checkInsiderIssuers(legacy, GOOGL, async url => url === `${root}/form4-07292026_110704.xml` ? GV_LIFE : null);
  assert.deepEqual(checks.map(c => [c.issuerTradingSymbol, c.foreign, c.via]), [["LIFE", true, "document"]]);
  assert.deepEqual(withoutForeign(legacy, checks)!.events, []);
});
