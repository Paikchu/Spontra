import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SecFiling } from "../../../shared/analysis-contract/report.ts";
import type { GuidancePublication } from "../../../shared/analysis-contract/guidance.ts";
import type { VerifiedGuidance } from "../../../shared/analysis-runtime/guidance.ts";
import { GUIDANCE_EXTRACTOR_VERSION, guidanceWorkflowSuffix } from "../src/guidance/extract.ts";
import { GuidanceStore } from "../src/guidance/store.ts";
import { guidanceCacheKey, publishGuidance } from "../src/guidance/workflow.ts";
import { createAnalysisOperations, type AnalysisEnv } from "../src/operations.ts";
import { SEC_TASKS } from "../src/pipeline/sec-tasks.ts";
import { fiscalPeriodKey, fiscalPeriodsFromCompanyFacts } from "../src/sec/fiscal-period.ts";

/** D1 over node:sqlite with every migration applied. */
function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8").replace(/--> statement-breakpoint/g, ""));
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values as never[]).changes) } }),
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
    first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) ?? null) as T | null,
  });
  return { prepare: (sql: string) => statement(sql), batch: async (list: Array<{ run(): Promise<unknown> }>) => { const out = []; for (const s of list) out.push(await s.run()); return out; } } as unknown as D1Database;
}
const bucket = () => { const objects = new Map<string, string>(); return {
  async put(key: string, value: string) { objects.set(key, value); },
  async get(key: string) { return objects.has(key) ? { text: async () => objects.get(key)!, json: async () => JSON.parse(objects.get(key)!) } : null; },
}; };

const CIK = "0001018724";
const filing = (form: string, accessionNumber: string, reportDate: string, filingDate = reportDate): SecFiling => ({
  ticker: "AMZN", cik: CIK, cikNumber: 1018724, companyName: "AMAZON COM INC", form, filingDate, reportDate, accessionNumber,
  primaryDocument: "doc.htm", description: "", items: form === "8-K" ? "2.02,9.01" : "",
  documentUrl: `https://www.sec.gov/Archives/edgar/data/1018724/${accessionNumber.replace(/-/g, "")}/doc.htm`, indexUrl: "",
});
const Q2 = filing("10-Q", "0001018724-26-000026", "2026-06-30", "2026-07-31");
const Q1 = filing("10-Q", "0001018724-26-000014", "2026-03-31", "2026-04-30");
const FY = filing("10-K", "0001018724-26-000004", "2025-12-31", "2026-02-06");
const RELEASE = filing("8-K", "0001018724-26-000024", "2026-07-30");
/** Company Facts as data.sec.gov serves it: each fact names its filing and that filing's DEI focus. */
const fact = (accn: string, fy: unknown, fp: unknown, end: string, form = "10-Q") => ({ accn, fy, fp, end, form, val: 1, filed: "2026-07-31" });
const companyFacts = (facts: object[], extra: object[] = []) => ({ cik: 1018724, facts: {
  dei: { EntityCommonStockSharesOutstanding: { units: { shares: [fact(Q2.accessionNumber, 2026, "Q2", "2026-07-22"), fact(FY.accessionNumber, 2025, "FY", "2026-01-28", "10-K"), ...extra] } } },
  "us-gaap": { RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: facts } } },
} });

test("each periodic filing's fiscal focus comes from its Company Facts, dated by the filing's report date", () => {
  const facts = companyFacts([
    fact(Q2.accessionNumber, 2026, "Q2", "2026-06-30"), fact(Q2.accessionNumber, 2026, "Q2", "2025-06-30"),
    fact(Q1.accessionNumber, 2026, "Q1", "2026-03-31"),
    fact(FY.accessionNumber, 2025, "FY", "2025-12-31", "10-K"), fact(FY.accessionNumber, 2025, "FY", "2024-12-31", "10-K"),
    // An 8-K's facts never label it: an event date is not a fiscal period.
    fact(RELEASE.accessionNumber, 2026, "Q2", "2026-07-30", "8-K"),
  ]);
  assert.deepEqual(fiscalPeriodsFromCompanyFacts(facts, [RELEASE, Q2, Q1, FY]).map(p => [p.sourceAccession, p.fiscalYear, p.fiscalPeriod, p.periodEnd]), [
    [Q2.accessionNumber, 2026, "Q2", "2026-06-30"],
    [Q1.accessionNumber, 2026, "Q1", "2026-03-31"],
    [FY.accessionNumber, 2025, "FY", "2025-12-31"],
  ]);
  const [q2] = fiscalPeriodsFromCompanyFacts(facts, [Q2]);
  assert.equal(q2!.source, "sec_dei");
  assert.equal(q2!.sourceUrl, Q2.documentUrl);
});

test("a filing is left unlabelled when its facts disagree, none ends on its report date, or the focus does not fit the form", () => {
  const amendment = filing("10-K/A", "0001018724-26-000030", "2025-12-31");
  const labelled = (facts: object[], filings: SecFiling[], extra: object[] = []) => fiscalPeriodsFromCompanyFacts(companyFacts(facts, extra), filings).map(p => p.sourceAccession);
  assert.deepEqual(labelled([fact(Q2.accessionNumber, 2026, "Q2", "2026-06-30"), fact(Q2.accessionNumber, 2025, "Q2", "2026-06-30")], [Q2]), []);
  assert.deepEqual(labelled([fact(Q2.accessionNumber, 2026, "Q2", "2026-06-30"), fact(Q2.accessionNumber, 2026, "Q3", "2026-06-30")], [Q2]), []);
  // A cover-only amendment: its one fact is the share count's date, not the period it amends.
  assert.deepEqual(labelled([], [amendment], [fact(amendment.accessionNumber, 2025, "FY", "2026-04-20", "10-K/A")]), []);
  assert.deepEqual(labelled([fact(Q2.accessionNumber, 2026, "FY", "2026-06-30")], [Q2]), []);
  assert.deepEqual(labelled([fact(FY.accessionNumber, 2025, "Q4", "2025-12-31", "10-K")], [FY]), []);
  assert.deepEqual(labelled([fact(Q2.accessionNumber, "2026", "Q2", "2026-06-30")], [Q2]), []);
  assert.deepEqual(fiscalPeriodsFromCompanyFacts(null, [Q2]), []);
  assert.deepEqual(fiscalPeriodsFromCompanyFacts({ facts: { dei: { X: { units: { shares: "bad" } } } } }, [Q2]), []);
});

const env = (db: D1Database) => ({ DB: db, SEC_FILINGS: bucket(), SEC_USER_AGENT: "test agent", SEC_AI_TICKERS: "AMZN", SEC_DATA_TICKERS: "AMZN" }) as unknown as AnalysisEnv;
const feed = { ticker: "AMZN", company: { ticker: "AMZN", cik: CIK, name: "AMAZON COM INC" }, filings: [RELEASE, Q2, Q1, FY].map(f => ({ ...f, summary: null })), fetchedAt: "2026-10-19T10:00:00.000Z", status: "ready" };
const revenueFacts = companyFacts([
  { ...fact(Q2.accessionNumber, 2026, "Q2", "2026-06-30"), start: "2026-04-01", val: 167_000_000_000 },
  { ...fact(Q1.accessionNumber, 2026, "Q1", "2026-03-31"), start: "2026-01-01", val: 155_000_000_000 },
  { ...fact(FY.accessionNumber, 2025, "FY", "2025-12-31", "10-K"), start: "2025-01-01", val: 690_000_000_000 },
]);
const cached = async <T>(db: D1Database, key: string) => {
  const row = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = ?").bind(key).first<{ payload: string }>();
  return row ? JSON.parse(row.payload) as T : null;
};

test("publishing the filing list writes every periodic filing's fiscal period from the one Company Facts read, without fetching a filing", async () => {
  const db = database();
  const reads: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    reads.push(String(input));
    if (String(input) === `https://data.sec.gov/api/xbrl/companyfacts/CIK${CIK}.json`) return Response.json(revenueFacts);
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  await createAnalysisOperations(env(db), fetcher).publishFeed(feed);
  assert.deepEqual(reads, [`https://data.sec.gov/api/xbrl/companyfacts/CIK${CIK}.json`]);
  assert.deepEqual(await cached(db, fiscalPeriodKey(Q2)), { fiscalYear: 2026, fiscalPeriod: "Q2", periodEnd: "2026-06-30", source: "sec_dei", sourceAccession: Q2.accessionNumber, sourceUrl: Q2.documentUrl });
  assert.equal((await cached<{ fiscalPeriod: string }>(db, fiscalPeriodKey(FY)))?.fiscalPeriod, "FY");
  assert.equal(await cached(db, fiscalPeriodKey(RELEASE)), null);
  assert.ok(await cached(db, "sec:fundamentals:AMZN"), "the same read still publishes the fundamentals");
  const events = (await db.prepare("SELECT type FROM pipeline_outbox ORDER BY type").all<{ type: string }>()).results.map(r => r.type);
  assert.deepEqual(events, ["filings.indexed", "fundamentals.updated"]);

  // Unchanged periods are not rewritten on the next sweep; a Company Facts outage keeps them and still indexes the list.
  const fetchedAt = async () => (await db.prepare("SELECT fetched_at FROM sec_cache WHERE cache_key = ?").bind(fiscalPeriodKey(Q2)).first<{ fetched_at: string }>())?.fetched_at;
  await createAnalysisOperations(env(db), fetcher).publishFeed({ ...feed, fetchedAt: "2026-10-19T11:00:00.000Z" });
  assert.equal(await fetchedAt(), "2026-10-19T10:00:00.000Z");
  await createAnalysisOperations(env(db), (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch).publishFeed({ ...feed, fetchedAt: "2026-10-19T12:00:00.000Z" });
  assert.equal((await cached<{ fiscalPeriod: string }>(db, fiscalPeriodKey(Q2)))?.fiscalPeriod, "Q2");
  assert.equal((await db.prepare("SELECT fetched_at FROM sec_cache WHERE cache_key = 'sec:filings:AMZN'").first<{ fetched_at: string }>())?.fetched_at, "2026-10-19T12:00:00.000Z");
});

test("guidance published before its fiscal periods were known is dated once they are, and only then", async () => {
  const db = database();
  const e = env(db);
  const store = new GuidanceStore(db, e.SEC_FILINGS);
  await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)").bind("sec:filings:AMZN", JSON.stringify(feed), feed.fetchedAt).run();
  await store.recordEvents("AMZN", [{ accession: RELEASE.accessionNumber, eventDate: RELEASE.filingDate }], feed.fetchedAt);
  const text = "Net sales are expected to be between $194.0 billion and $199.0 billion in the third quarter. ".repeat(10);
  const saved = await store.saveMaterial("AMZN", RELEASE.accessionNumber, { kind: "press_release", sourceKind: "sec", title: "Q2 2026 results", url: RELEASE.documentUrl, publishedAt: RELEASE.filingDate, text }, feed.fetchedAt);
  const item: VerifiedGuidance = { metric: "revenue", measure: "amount", segment: null, label: "Net sales", basis: "unspecified", horizon: "quarter", form: "range",
    fiscalYear: 2026, fiscalQuarter: 3, unit: "USD", low: 194_000_000_000, high: 199_000_000_000, direction: null,
    text: "Net sales of $194.0 billion to $199.0 billion.", quote: "Net sales are expected to be between $194.0 billion and $199.0 billion in the third quarter." };
  await store.saveExtraction((await store.material(saved.id))!, RELEASE.filingDate, GUIDANCE_EXTRACTOR_VERSION, { model: "m", items: [item], rejected: 0, modelCalls: 1, inputCharacters: text.length }, feed.fetchedAt);

  assert.equal((await publishGuidance(e, "AMZN", "2026-10-19T10:00:00.000Z")).published, true);
  assert.equal((await cached<GuidancePublication>(db, guidanceCacheKey("AMZN")))?.items[0]?.periodEnd, null);
  // Nothing new: the stored view stays, and no event wakes the findings.
  assert.equal((await publishGuidance(e, "AMZN", "2026-10-19T10:05:00.000Z", { onlyIfChanged: true })).published, false);

  // The filing list's next publication brings the fiscal periods; the guidance task it triggers finds its one event
  // settled and dates the stored items, with no extraction run.
  const fetcher = (async () => Response.json(revenueFacts)) as unknown as typeof fetch;
  await createAnalysisOperations(e, fetcher).publishFeed(feed);
  await store.updateEvent("AMZN", RELEASE.accessionNumber, { status: "complete", workflowInstanceId: `guidance-AMZN-${RELEASE.accessionNumber}-${guidanceWorkflowSuffix()}` }, feed.fetchedAt);
  const workflows = { create: async () => { throw new Error("no extraction expected"); }, get: async () => { throw new Error("no instance expected"); } };
  const task = () => SEC_TASKS.guidance.run({ ...e, GUIDANCE_ENABLED: "true", GUIDANCE_WORKFLOW: workflows } as unknown as AnalysisEnv, "AMZN",
    { causeId: "c1", now: new Date("2026-10-19T10:10:00.000Z"), trigger: null });
  assert.deepEqual(await task(), { status: "done", detail: { recorded: 1, transcripts: [], started: [], retried: 0, republished: true } });
  const publication = await cached<GuidancePublication>(db, guidanceCacheKey("AMZN"));
  assert.equal(publication?.items[0]?.periodEnd, "2026-09-30");
  assert.equal(publication?.updatedAt, "2026-10-19T10:10:00.000Z");
  assert.equal(((await task()).detail as { republished: boolean }).republished, false);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM pipeline_outbox WHERE type = 'guidance.published'").first<{ n: number }>())?.n, 2);
});
