import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { alphaVantageLimit, AlphaVantageTranscriptProvider, TranscriptAccessError } from "../src/guidance/sources.ts";
import { guidanceWorkflowSuffix } from "../src/guidance/extract.ts";
import { executeGuidanceWorkflow, guidanceCacheKey } from "../src/guidance/workflow.ts";
import type { SecPipelineEnv } from "../src/operations.ts";
import { SEC_TASKS } from "../src/pipeline/sec-tasks.ts";
import { inFiscalSequence, quarterAfterYearEnd } from "../src/sec/fiscal-sequence.ts";
import { syncTranscript } from "../src/transcripts/library.ts";

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

function bucket() {
  const objects = new Map<string, string>();
  return { objects, get: async (key: string) => objects.has(key) ? { text: async () => objects.get(key)! } : null, put: async (key: string, value: string) => { objects.set(key, value); } };
}

const DAILY = "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly remove all daily rate limits.";
const BURST = "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit (20 requests per minute) and instantly remove all daily rate limits.";
const GUIDANCE_LINE = "For the second quarter, we expect total revenue to grow between 14% and 16% in constant currency.";
const call = (ticker: string, quarter: string) => ({ symbol: ticker, quarter, transcript: [
  { speaker: "Operator", title: "Operator", content: `Welcome to the ${ticker} ${quarter} earnings call. ${"Thank you for joining us today. ".repeat(40)}` },
  { speaker: "CFO", title: "Chief Financial Officer", content: `${GUIDANCE_LINE} ${"We continue to see strong demand across the business. ".repeat(20)}` },
] });

/** Alpha Vantage that answers each request from `answer`, recording the fiscal quarters asked for. */
function alphaVantage(answer: (ticker: string, quarter: string) => unknown) {
  const asked: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const ticker = url.searchParams.get("symbol")!, quarter = url.searchParams.get("quarter")!;
    asked.push(`${ticker} ${quarter}`);
    return Response.json(answer(ticker, quarter));
  }) as typeof fetch;
  return { asked, fetcher };
}

const now = new Date("2026-10-19T09:00:00.000Z");
const libraryEnv = (db: D1Database, files: ReturnType<typeof bucket>, tickers: string) => ({
  DB: db, SEC_FILINGS: files, TRANSCRIPTS_ENABLED: "true", ALPHA_VANTAGE_API_KEY: "test-key", SEC_DATA_TICKERS: tickers, SEC_AI_TICKERS: tickers, SEC_AI_ENABLED: "true",
}) as unknown as SecPipelineEnv;
const cache = (db: D1Database, key: string, payload: unknown) => db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)").bind(key, JSON.stringify(payload), now.toISOString()).run();
const dei = (end: string, year: number, period: string) => `<html><body>
  <ix:nonNumeric name="dei:DocumentPeriodEndDate" contextRef="c1">${end}</ix:nonNumeric>
  <ix:nonNumeric name="dei:DocumentFiscalYearFocus" contextRef="c1">${year}</ix:nonNumeric>
  <ix:nonNumeric name="dei:DocumentFiscalPeriodFocus" contextRef="c1">${period}</ix:nonNumeric></body></html>`;
/** One archived document, as the disclosure audit records it. */
async function archived(db: D1Database, files: ReturnType<typeof bucket>, ticker: string, doc: { accession: string; form: string; reportDate: string; filedAt: string; html: string }) {
  const rawKey = `sec/raw/${ticker}/${doc.accession}.htm`;
  files.objects.set(rawKey, doc.html);
  await cache(db, `sec:disclosure-audit:v1:${ticker}:${doc.accession}`, { ticker, rawKey, source: { ticker, accessionNumber: doc.accession, form: doc.form, reportDate: doc.reportDate, filedAt: doc.filedAt, documentUrl: `https://www.sec.gov/Archives/${doc.accession}.htm` } });
}
const fiscalPeriod = (db: D1Database, ticker: string, accession: string, fiscalYear: number, fiscalPeriod: string, periodEnd: string) =>
  cache(db, `sec:fiscal-period:v1:${ticker}:${accession}`, { fiscalYear, fiscalPeriod, periodEnd, source: "sec_dei", sourceAccession: accession, sourceUrl: "https://www.sec.gov/" });
const row = (db: D1Database, id: string) => db.prepare("SELECT status,error_code errorCode,fiscal_year fiscalYear,fiscal_quarter fiscalQuarter,attempts,next_attempt_at nextAttemptAt,content FROM company_transcripts WHERE id=?").bind(id)
  .first<{ status: string; errorCode: string | null; fiscalYear: number | null; fiscalQuarter: number | null; attempts: number; nextAttemptAt: string; content: string | null }>();
const budget = async (db: D1Database) => (await db.prepare("SELECT units FROM feature_budget WHERE day=? AND feature='guidance-transcript'").bind(now.toISOString().slice(0, 10)).first<{ units: number }>())?.units ?? 0;

test("Alpha Vantage's burst notice is told apart from its daily limit, though both upsell removing daily limits", async () => {
  assert.equal(alphaVantageLimit(DAILY), "daily");
  assert.equal(alphaVantageLimit(BURST), "burst");
  assert.equal(alphaVantageLimit("Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute and 500 calls per day."), "burst");
  assert.equal(alphaVantageLimit("Invalid API call. Please retry or visit the documentation for EARNINGS_CALL_TRANSCRIPT."), null);
  const premium = new AlphaVantageTranscriptProvider("k", (async () => Response.json({ Information: "Thank you for using Alpha Vantage! This is a premium endpoint. You may subscribe to any of the premium plans to instantly unlock all premium endpoints and remove all daily rate limits." })) as typeof fetch);
  await assert.rejects(premium.fetch("ORCL", { fiscalYear: 2027, quarter: 1, date: "2026-09-10" }), TranscriptAccessError);
});

test("a fiscal label that repeats or runs behind last year's takes the year its quarter is reached in", () => {
  // Oracle: FY2026 ends 2026-05-31, and its 10-Q for 2026-08-31 says FY2026 Q1 again.
  const oracle = inFiscalSequence([
    { fiscalYear: 2026, quarter: 1 as const, periodEnd: "2026-08-31" },
    { fiscalYear: 2026, quarter: 4 as const, periodEnd: "2026-05-31" },
    { fiscalYear: 2026, quarter: 1 as const, periodEnd: "2025-08-31" },
  ]);
  assert.deepEqual(oracle.map(l => `${l.periodEnd} FY${l.fiscalYear} Q${l.quarter}`), ["2026-08-31 FY2027 Q1", "2026-05-31 FY2026 Q4", "2025-08-31 FY2026 Q1"]);
  // Only the guidance anchors before the last fiscal year end: the quarter still runs behind it.
  assert.equal(inFiscalSequence([{ fiscalYear: 2026, quarter: 1 as const, periodEnd: "2026-08-31" }, { fiscalYear: 2026, quarter: 4 as const, periodEnd: "2026-05-31" }])[0]!.fiscalYear, 2027);
  // A 52/53-week calendar in order is left alone.
  const nvidia = [{ fiscalYear: 2027, quarter: 1 as const, periodEnd: "2026-04-26" }, { fiscalYear: 2027, quarter: 2 as const, periodEnd: "2026-07-26" }, { fiscalYear: 2026, quarter: 4 as const, periodEnd: "2026-01-25" }];
  assert.deepEqual(inFiscalSequence(nvidia), nvidia);
  // A 6-K quarter counts on from the 20-F's fiscal year.
  assert.deepEqual(quarterAfterYearEnd([{ fiscalYear: 2025, quarter: 4, periodEnd: "2025-12-31" }], "2026-06-30"), { fiscalYear: 2026, quarter: 2, periodEnd: "2026-06-30" });
  assert.equal(quarterAfterYearEnd([{ fiscalYear: 2024, quarter: 4, periodEnd: "2024-12-31" }], "2026-06-30"), null);
});

test("a burst refusal retries the period a minute later and leaves the day's budget open; the daily limit closes the day", async () => {
  const db = database(), files = bucket();
  await archived(db, files, "ADSK", { accession: "0000769397-26-000060", form: "10-Q", reportDate: "2026-07-31", filedAt: "2026-08-28", html: dei("2026-07-31", 2027, "Q2") });
  const env = libraryEnv(db, files, "ADSK");
  const burst = alphaVantage(() => ({ Information: BURST }));
  const throttled = await syncTranscript(env, now, burst.fetcher);
  assert.equal(throttled.status, "retry");
  let stored = await row(db, "ADSK-2026-07-31");
  assert.equal(stored?.errorCode, "PROVIDER_THROTTLED");
  assert.equal(stored?.attempts, 0, "a refusal for rate is not a try");
  assert.equal(stored?.nextAttemptAt, new Date(now.getTime() + 65_000).toISOString());
  assert.equal(await budget(db), 1, "only the request itself is counted");

  const later = new Date(now.getTime() + 70_000);
  const daily = alphaVantage(() => ({ Information: DAILY }));
  await syncTranscript(env, later, daily.fetcher);
  stored = await row(db, "ADSK-2026-07-31");
  assert.equal(stored?.errorCode, "PROVIDER_DAILY_LIMIT");
  assert.equal(stored?.nextAttemptAt, "2026-10-20T00:10:00.000Z");
  assert.equal(await budget(db), 25);
  assert.deepEqual([...burst.asked, ...daily.asked], ["ADSK 2027Q2", "ADSK 2027Q2"]);
  assert.equal((await syncTranscript(env, new Date(later.getTime() + 60_000), daily.fetcher)).status, "daily_budget");
});

test("a stored call filed under a label its fiscal sequence corrects is fetched again under the corrected quarter", async () => {
  const db = database(), files = bucket();
  await archived(db, files, "ORCL", { accession: "0001193125-26-389274", form: "10-Q", reportDate: "2026-08-31", filedAt: "2026-09-11", html: dei("2026-08-31", 2026, "Q1") });
  await fiscalPeriod(db, "ORCL", "0001193125-25-200095", 2026, "Q1", "2025-08-31");
  await fiscalPeriod(db, "ORCL", "0001193125-26-277521", 2026, "FY", "2026-05-31");
  await fiscalPeriod(db, "ORCL", "0001193125-26-389274", 2026, "Q1", "2026-08-31");
  const env = libraryEnv(db, files, "ORCL");
  // The production row: last year's call, stored as this period's.
  await db.prepare(`INSERT INTO company_transcripts(id,ticker,period_end,accession,form,filing_url,filed_at,raw_key,fiscal_year,fiscal_quarter,status,title,content,characters,attempts,next_attempt_at,fetched_at,updated_at)
    VALUES ('ORCL-2026-08-31','ORCL','2026-08-31','0001193125-26-389274','10-Q','https://www.sec.gov/','2026-09-11','sec/raw/ORCL/0001193125-26-389274.htm',2026,1,'ready','ORCL Q1 FY2026 earnings call transcript','Q1 FY2026 call',14,4,?,?,?)`)
    .bind(now.toISOString(), now.toISOString(), now.toISOString()).run();
  const av = alphaVantage(call);
  const result = await syncTranscript(env, now, av.fetcher);
  assert.equal(result.status, "ready");
  assert.deepEqual(av.asked, ["ORCL 2027Q1"]);
  const stored = await row(db, "ORCL-2026-08-31");
  assert.deepEqual([stored?.fiscalYear, stored?.fiscalQuarter, stored?.attempts], [2027, 1, 1]);
  assert.match(stored!.content!, /2027Q1 earnings call/);
  const events = (await db.prepare("SELECT type,ticker FROM pipeline_outbox").bind().all<{ type: string; ticker: string }>()).results;
  assert.deepEqual(events.map(e => ({ ...e })), [{ type: "transcript.stored", ticker: "ORCL" }]);
});

test("a foreign issuer's 6-K quarter is seeded from its revenue history and asked for under the quarter after its 20-F year", async () => {
  const db = database(), files = bucket();
  await archived(db, files, "NBIS", { accession: "0001104659-26-030000", form: "20-F", reportDate: "2025-12-31", filedAt: "2026-04-30", html: dei("2025-12-31", 2025, "FY") });
  await archived(db, files, "NBIS", { accession: "0001104659-26-080000", form: "6-K", reportDate: "2026-08-07", filedAt: "2026-08-07", html: "<html>Nebius second quarter 2026 results</html>" });
  await archived(db, files, "NBIS", { accession: "0001104659-26-013946", form: "6-K", reportDate: "2026-02-12", filedAt: "2026-02-12", html: "<html>Nebius fourth quarter 2025 results</html>" });
  await cache(db, "sec:revenue-history:v1:0001513845", { ticker: "NBIS", quarters: [
    { periodStart: "2026-04-01", periodEnd: "2026-06-30", source: { accession: "0001104659-26-080000", url: "https://www.sec.gov/ex99.htm", filedAt: "2026-08-07", form: "6-K" } },
    // The prior-year quarter, read from the same release as a comparative: not that quarter's release.
    { periodStart: "2025-04-01", periodEnd: "2025-06-30", source: { accession: "0001104659-26-080000", url: "https://www.sec.gov/ex99.htm", filedAt: "2026-08-07", form: "6-K" } },
    { periodStart: "2025-10-01", periodEnd: "2025-12-31", source: { accession: "0001104659-26-013946", url: "https://www.sec.gov/q4.htm", filedAt: "2026-02-12", form: "6-K" } },
  ] });
  const env = libraryEnv(db, files, "NBIS");
  const av = alphaVantage(call);
  const result = await syncTranscript(env, now, av.fetcher);
  assert.equal(result.status, "ready");
  assert.deepEqual(av.asked, ["NBIS 2026Q2"], "counted on from the 20-F's FY2025");
  const rows = (await db.prepare("SELECT period_end,form,filed_at FROM company_transcripts ORDER BY period_end").bind().all<{ period_end: string; form: string; filed_at: string }>()).results.map(r => ({ ...r }));
  // The fourth quarter is dated by its 6-K release, not the 20-F; the comparative quarter has no row.
  assert.deepEqual(rows, [{ period_end: "2025-12-31", form: "6-K", filed_at: "2026-02-12" }, { period_end: "2026-06-30", form: "6-K", filed_at: "2026-08-07" }]);
  await syncTranscript(env, new Date(now.getTime() + 60_000), av.fetcher);
  assert.deepEqual(av.asked, ["NBIS 2026Q2", "NBIS 2025Q4"]);
});

/** A Workflow binding that records the instances created. */
function workflows() {
  const created: Array<{ id: string; params: { ticker: string; accession: string; eventDate: string } }> = [];
  return { created, binding: { create: async (options: { id: string; params: { ticker: string; accession: string; eventDate: string } }) => { created.push(options); return { id: options.id }; }, get: async () => ({ status: async () => ({ status: "running" }) }) } };
}
const guidanceEnv = (db: D1Database, files: ReturnType<typeof bucket>, tickers: string, binding: unknown) => ({ ...libraryEnv(db, files, tickers), GUIDANCE_ENABLED: "true", GUIDANCE_WORKFLOW: binding }) as unknown as SecPipelineEnv;
const ready = (db: D1Database, ticker: string, doc: { periodEnd: string; accession: string; form: string; filedAt: string; fiscalYear: number; quarter: number }) =>
  db.prepare(`INSERT INTO company_transcripts(id,ticker,period_end,accession,form,filing_url,filed_at,raw_key,fiscal_year,fiscal_quarter,status,title,source_url,content,characters,next_attempt_at,fetched_at,updated_at)
    VALUES (?,?,?,?,?,'https://www.sec.gov/',?,'sec/raw/x',?,?,'ready',?,?,?,?,?,?,?)`).bind(`${ticker}-${doc.periodEnd}`, ticker, doc.periodEnd, doc.accession, doc.form, doc.filedAt, doc.fiscalYear, doc.quarter,
    `${ticker} Q${doc.quarter} FY${doc.fiscalYear} earnings call transcript`, `https://www.alphavantage.co/query?function=EARNINGS_CALL_TRANSCRIPT&symbol=${ticker}`,
    `${GUIDANCE_LINE}\n\n${"We continue to see strong demand. ".repeat(80)}`, 3000, now.toISOString(), now.toISOString(), now.toISOString()).run();
const filing = (form: string, accession: string, filingDate: string, items = "") => ({ form, accessionNumber: accession, filingDate, reportDate: filingDate, items, cikNumber: 1341439, documentUrl: "https://www.sec.gov/" });

test("a stored call joins the earnings release that reports its quarter, and a release already extracted runs again under a new instance", async () => {
  const db = database(), files = bucket(), { created, binding } = workflows();
  await cache(db, "sec:filings:ORCL", { company: { name: "Oracle Corporation" }, filings: [filing("10-Q", "0001193125-26-389274", "2026-09-11"), filing("8-K", "0001193125-26-387905", "2026-09-10", "2.02,9.01")] });
  await ready(db, "ORCL", { periodEnd: "2026-08-31", accession: "0001193125-26-389274", form: "10-Q", filedAt: "2026-09-11", fiscalYear: 2027, quarter: 1 });
  const previous = `guidance-ORCL-0001193125-26-387905-${guidanceWorkflowSuffix()}`;
  await db.prepare("INSERT INTO earnings_events (ticker,accession,event_date,status,workflow_instance_id,transcript_status,updated_at) VALUES ('ORCL','0001193125-26-387905','2026-09-10','complete',?,'unavailable',?)").bind(previous, now.toISOString()).run();
  const outcome = await SEC_TASKS.guidance.run(guidanceEnv(db, files, "ORCL", binding), "ORCL", { now, causeId: "c1", trigger: null });
  assert.deepEqual((outcome.detail as { transcripts: string[] }).transcripts, ["0001193125-26-387905"]);
  const material = await db.prepare("SELECT event_accession,kind,source_kind,status FROM earnings_materials WHERE ticker='ORCL'").bind().first();
  assert.deepEqual({ ...material }, { event_accession: "0001193125-26-387905", kind: "transcript", source_kind: "transcript_api", status: "stored" });
  assert.equal(created.length, 1);
  assert.equal(created[0]!.id, `guidance-ORCL-0001193125-26-387905-r${Math.floor(now.getTime() / 1000)}-${guidanceWorkflowSuffix()}`);
  // Run again: the call is attached once, and the event is not queued twice.
  const again = await SEC_TASKS.guidance.run(guidanceEnv(db, files, "ORCL", binding), "ORCL", { now, causeId: "c2", trigger: null });
  assert.deepEqual((again.detail as { transcripts: string[] }).transcripts, []);
  assert.equal(created.length, 1);
});

test("a company with no earnings 8-K gets an event of its own for each stored call, and the Workflow extracts and publishes it", async () => {
  const db = database(), files = bucket(), { created, binding } = workflows();
  await cache(db, "sec:filings:NBIS", { company: { name: "Nebius Group N.V." }, filings: [filing("6-K", "0001104659-26-080000", "2026-08-07")] });
  await ready(db, "NBIS", { periodEnd: "2026-06-30", accession: "0001104659-26-080000", form: "6-K", filedAt: "2026-08-07", fiscalYear: 2026, quarter: 2 });
  const env = guidanceEnv(db, files, "NBIS", binding);
  await SEC_TASKS.guidance.run(env, "NBIS", { now, causeId: "c1", trigger: null });
  assert.deepEqual(created.map(c => c.params), [{ ticker: "NBIS", accession: "0001104659-26-080000", eventDate: "2026-08-07" }]);

  const step = { do: async <T>(_name: string, fn: (ctx: { attempt: number }) => Promise<T>) => fn({ attempt: 1 }), sleep: async () => {} };
  const quoted = { items: [{ metric: "revenue", measure: "growth", segment: null, label: "Revenue growth", basis: "constant_currency", horizon: "quarter", form: "range",
    fiscalYear: 2026, fiscalQuarter: 3, unit: "percent", currency: "USD", low: 14, high: 16, direction: null, text: "Revenue is expected to grow 14% to 16% next quarter.", quote: GUIDANCE_LINE }] };
  const result = await executeGuidanceWorkflow(created[0]!.params, step as never, env, { model: async () => quoted, deckSearch: null, secExhibits: async () => [] });
  assert.equal(result.transcript, "extracted");
  const publication = JSON.parse((await db.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(guidanceCacheKey("NBIS")).first<{ payload: string }>())!.payload);
  assert.deepEqual(publication.coverage, [{ eventDate: "2026-08-07", accession: "0001104659-26-080000", materials: [{ kind: "transcript", status: "extracted" }] }]);
  assert.equal(publication.items.length, 1);
  assert.equal(publication.items[0].sourceIds.length, 1);
  const event = await db.prepare("SELECT status,transcript_status FROM earnings_events WHERE ticker='NBIS'").bind().first();
  assert.deepEqual({ ...event }, { status: "complete", transcript_status: "extracted" });
});
