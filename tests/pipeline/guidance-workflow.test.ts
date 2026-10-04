import assert from "node:assert/strict";
import test from "node:test";

import type { GuidanceResponse } from "../../shared/analysis-contract/guidance.ts";
import { GUIDANCE_SYSTEM_PROMPT } from "../../workers/pipeline/src/guidance/extract.ts";
import type { FoundMaterial, TranscriptRef } from "../../workers/pipeline/src/guidance/sources.ts";
import { GuidanceStore } from "../../workers/pipeline/src/guidance/store.ts";
import { earningsEvents, executeGuidanceWorkflow, guidanceCacheKey, runGuidanceSweep, type GuidanceDeps, type GuidanceStep } from "../../workers/pipeline/src/guidance/workflow.ts";
import type { SecPipelineEnv } from "../../workers/pipeline/src/operations.ts";
import { handleAnalysisReadRequest } from "../../workers/pipeline/src/read-api/router.ts";
import { D1SecRepository } from "../../workers/pipeline/src/sec/d1.ts";
import { fiscalPeriodKey } from "../../workers/pipeline/src/sec/fiscal-period.ts";
import type { SecFiling, SecFilingFeed } from "../../workers/pipeline/src/sec/sec.ts";
import { createAnalysisDatabase, readEnv, readRequest } from "./helpers/analysis-backend.ts";

const today = new Date().toISOString().slice(0, 10);
const filing = (accessionNumber: string, form: string, filingDate: string, items = "", reportDate = filingDate): SecFiling => ({
  ticker: "ORCL", cik: "0001341439", cikNumber: 1341439, companyName: "Oracle Corporation", form, filingDate, reportDate, accessionNumber,
  primaryDocument: "doc.htm", description: "", items, documentUrl: `https://www.sec.gov/Archives/edgar/data/1341439/${accessionNumber.replaceAll("-", "")}/doc.htm`,
  indexUrl: `https://www.sec.gov/Archives/edgar/data/1341439/${accessionNumber.replaceAll("-", "")}/index.html`,
});
const tenQ = filing("0001341439-26-000030", "10-Q", "2026-09-20", "", "2026-08-31");
const feed: SecFilingFeed = {
  ticker: "ORCL", company: { ticker: "ORCL", cik: "0001341439", name: "Oracle Corporation" }, fetchedAt: "2026-10-01T00:00:00Z", status: "ready",
  filings: [
    { ...filing("0001341439-26-000040", "8-K", today, "2.02,9.01"), summary: null },
    { ...tenQ, summary: null },
    { ...filing("0001341439-26-000020", "8-K", "2026-09-09", "2.02,9.01"), summary: null },
    { ...filing("0001341439-26-000010", "8-K", "2026-06-11", "2.02,9.01"), summary: null },
    { ...filing("0001341439-26-000011", "8-K", "2026-06-20", "5.02"), summary: null },
    { ...filing("0001341439-24-000001", "8-K", "2024-06-11", "2.02"), summary: null },
  ],
};

const juneRelease = `Oracle Announces Fiscal 2026 Fourth Quarter and Fiscal Full Year Financial Results
Total revenues were up 11% to $15.9 billion.
Outlook
For fiscal 2027, we expect total revenues to grow between 15% and 16%.
${"Customer and partner announcements across regions. ".repeat(10)}`;
const septemberRelease = `Oracle Announces Fiscal 2027 First Quarter Financial Results
Outlook
We now expect fiscal 2027 total revenues to grow between 16% and 17%.
For the second quarter of fiscal 2027, we expect total revenues to grow between 12% and 14%, and non-GAAP EPS of $1.46 to $1.50.
${"Customer and partner announcements across regions. ".repeat(10)}`;
const septemberCall = `Operator: Welcome to the Oracle first quarter fiscal 2027 earnings call.
${"Ken Bond: Thank you. Our prepared remarks follow, covering customers and product updates in detail. ".repeat(30)}
Safra Catz: For the full year, we now expect fiscal 2027 total revenues to grow between 16% and 17%.
Safra Catz: We expect OCI growth to accelerate further in the second half of fiscal 2027.
${"Analyst: Can you talk about demand? Larry Ellison: Demand is strong across every region we serve. ".repeat(30)}`;

const releases: Record<string, string> = {
  "0001341439-26-000010": juneRelease, "0001341439-26-000020": septemberRelease, "0001341439-26-000040": septemberRelease.replace("first quarter", "second quarter").replace("16% and 17%", "17% and 18%"),
};

function bucket() {
  const objects = new Map<string, string>();
  return { objects, async get(key: string) { const v = objects.get(key); return v === undefined ? null : { etag: "e", async text() { return v; } }; },
    async put(key: string, value: string) { objects.set(key, value); return {}; } };
}

type Item = Record<string, unknown>;
const item = (overrides: Item): Item => ({ metric: "revenue", measure: "growth", segment: null, label: "Total revenues", basis: "unspecified", horizon: "annual", form: "range",
  fiscalYear: 2027, fiscalQuarter: null, unit: "percent", currency: "USD", direction: null, text: "收入指引", ...overrides });

/** Answers from the excerpt it was given, like an extraction model would; the first answer for a release has one paraphrased quote. */
function fakeModel() {
  const calls: Array<{ stage: string; kind: string; system: string }> = [];
  const model = async (stage: string, system: string, payload: unknown) => {
    const { documentContext, excerpt } = payload as { documentContext: { documentKind: string }; excerpt: string };
    calls.push({ stage, kind: documentContext.documentKind, system });
    const quarter = item({ horizon: "quarter", fiscalQuarter: 2, low: 12, high: 14, quote: "For the second quarter of fiscal 2027, we expect total revenues to grow between 12% and 14%" });
    if (stage === "guidance-repair") return { items: [quarter] };
    const items: Item[] = [];
    const annual = /grow between (1\d)% and (1\d)%\./.exec(excerpt);
    if (annual) items.push(item({ low: Number(annual[1]), high: Number(annual[2]), quote: excerpt.split("\n").find(l => l.includes(annual[0]))!.replace(/^Safra Catz: /, "") }));
    if (documentContext.documentKind === "press_release" && excerpt.includes("second quarter of fiscal 2027")) {
      items.push({ ...quarter, quote: "Q2 revenue is expected to grow 12% to 14%" });
      items.push(item({ metric: "eps", measure: "per_share", basis: "non_gaap", horizon: "quarter", fiscalQuarter: 2, unit: "USD_per_share", low: 1.46, high: 1.5, quote: "non-GAAP EPS of $1.46 to $1.50" }));
    }
    if (documentContext.documentKind === "transcript") items.push(item({ metric: "segment_revenue", segment: "OCI", form: "qualitative", low: null, high: null, direction: "up", quote: "We expect OCI growth to accelerate further in the second half of fiscal 2027." }));
    return { items };
  };
  return { calls, model };
}

function harness(options: { transcriptAfter?: number } = {}) {
  const sleeps: Array<{ name: string; ms: number }> = [];
  const step: GuidanceStep = { do: (_name, callback) => callback({ attempt: 1 }), async sleep(name, ms) { sleeps.push({ name, ms }); } };
  let probes = 0;
  const transcripts = {
    async find(_ticker: string, eventDate: string): Promise<TranscriptRef | null> {
      probes++;
      if (eventDate !== "2026-09-09" && probes <= (options.transcriptAfter ?? Infinity)) return null;
      return { fiscalYear: 2027, quarter: 1, date: eventDate };
    },
    async fetch(): Promise<FoundMaterial> {
      return { kind: "transcript", sourceKind: "transcript_api", title: "ORCL Q1 FY2027 call", text: septemberCall, publishedAt: "2026-09-09",
        url: "https://financialmodelingprep.com/stable/earning-call-transcript?symbol=ORCL&year=2027&quarter=1" };
    },
  };
  const exhibits: string[] = [];
  const secExhibits: GuidanceDeps["secExhibits"] = async (f) => {
    exhibits.push(f.accessionNumber);
    return [
      { kind: "press_release", sourceKind: "sec", title: "Oracle results", publishedAt: f.filingDate, text: releases[f.accessionNumber]!,
        url: `https://www.sec.gov/Archives/edgar/data/1341439/${f.accessionNumber.replaceAll("-", "")}/ex99-1.htm` },
      { kind: "deck", sourceKind: "sec", title: "EX-99.2 deck.pdf", publishedAt: f.filingDate, unsupported: "binary exhibit",
        url: `https://www.sec.gov/Archives/edgar/data/1341439/${f.accessionNumber.replaceAll("-", "")}/deck.pdf` },
    ];
  };
  return { step, sleeps, transcripts, secExhibits, exhibits, probes: () => probes };
}

async function setup() {
  const db = await createAnalysisDatabase();
  const repository = new D1SecRepository(db);
  await repository.setCache(`sec:filings:ORCL`, feed, "2026-10-01T00:00:00Z");
  await repository.setCache(fiscalPeriodKey(tenQ), { fiscalYear: 2027, fiscalPeriod: "Q1", periodEnd: "2026-08-31", source: "sec_dei", sourceAccession: tenQ.accessionNumber, sourceUrl: tenQ.documentUrl }, "2026-10-01");
  const created: Array<{ id: string; params: { ticker: string; accession: string; eventDate: string } }> = [];
  const env = {
    DB: db, SEC_FILINGS: bucket(), SEC_USER_AGENT: "test", SEC_AI_TICKERS: "ORCL", SEC_AI_ENABLED: "true", GUIDANCE_ENABLED: "true",
    GUIDANCE_WORKFLOW: { async create(options: (typeof created)[number]) { created.push(options); return {}; } },
  } as unknown as SecPipelineEnv;
  return { db, env, created };
}

test("earnings events are 8-K Item 2.02 filings within the lookback", () => {
  assert.deepEqual(earningsEvents(feed, Date.parse("2026-10-04")).map(e => e.accession), ["0001341439-26-000040", "0001341439-26-000020", "0001341439-26-000010"]);
});

test("sweep records events from the cached feed and starts each event once, newest first", async () => {
  const { db, env, created } = await setup();
  try {
    assert.equal((await runGuidanceSweep({ ...env, GUIDANCE_ENABLED: "false" })).enabled, false);
    const first = await runGuidanceSweep(env);
    assert.equal(first.recorded, 3);
    assert.deepEqual(created.map(c => c.params.accession), ["0001341439-26-000040", "0001341439-26-000020"]);
    assert.match(created[0]!.id, /^guidance-ORCL-0001341439-26-000040-guidanceextractorv1$/);
    await runGuidanceSweep(env);
    await runGuidanceSweep(env);
    assert.deepEqual(created.map(c => c.params.accession), ["0001341439-26-000040", "0001341439-26-000020", "0001341439-26-000010"]);
  } finally { db.close(); }
});

test("an event publishes verified guidance, links revisions, and never sends the same document to the model twice", async () => {
  const { db, env } = await setup();
  try {
    const h = harness();
    const fake = fakeModel();
    const deps: GuidanceDeps = { model: fake.model, transcripts: h.transcripts, secExhibits: h.secExhibits, deckSearch: null };
    const pending = await handleAnalysisReadRequest(readRequest("/api/v1/companies/ORCL/guidance"), readEnv(db));
    assert.equal((await pending.json() as GuidanceResponse).status, "preparing");

    await executeGuidanceWorkflow({ ticker: "ORCL", accession: "0001341439-26-000010", eventDate: "2026-06-11" }, h.step, env, { ...deps, transcripts: null });
    await executeGuidanceWorkflow({ ticker: "ORCL", accession: "0001341439-26-000020", eventDate: "2026-09-09" }, h.step, env, deps);

    assert.deepEqual(fake.calls.map(c => `${c.kind}:${c.stage}`), [
      "press_release:guidance-extract", "press_release:guidance-extract", "press_release:guidance-repair", "transcript:guidance-extract",
    ], "one call per document, one repair for the paraphrased quote, nothing for the unsupported PDF");
    assert.ok(fake.calls.every(c => c.system.startsWith(GUIDANCE_SYSTEM_PROMPT)), "the fixed prompt prefix is shared by every call");
    assert.equal(h.sleeps.length, 0, "a past event's transcript is fetched without waiting");

    const response = await handleAnalysisReadRequest(readRequest("/api/v1/companies/ORCL/guidance"), readEnv(db));
    const body = await response.json() as GuidanceResponse;
    assert.equal(body.status, "ready");
    const items = body.guidance!.items;
    const annual = items.filter(i => i.metric === "revenue" && i.horizon === "annual");
    assert.equal(annual.length, 2);
    const raised = annual.find(i => i.issuedAt === "2026-09-09")!;
    assert.equal(raised.action, "raised");
    assert.equal(raised.periodEnd, "2027-05-31");
    assert.equal(raised.sourceIds.length, 2, "the call repeats the release and is cited, not duplicated");
    const quarter = items.find(i => i.horizon === "quarter" && i.metric === "revenue")!;
    assert.equal(quarter.periodEnd, "2026-11-30");
    assert.equal(quarter.low, 12);
    assert.ok(items.some(i => i.metric === "eps" && i.basis === "non_gaap" && i.high === 1.5));
    assert.ok(items.some(i => i.form === "qualitative" && i.segment === "OCI" && i.direction === "up"));
    assert.ok(!JSON.stringify(body).includes("apikey"), "the transcript citation carries no credential");
    const september = body.guidance!.coverage.find(c => c.accession === "0001341439-26-000020")!;
    assert.deepEqual(september.materials.map(m => `${m.kind}:${m.status}`).sort(), ["deck:unsupported", "press_release:extracted", "transcript:extracted"]);
    const june = body.guidance!.coverage.find(c => c.accession === "0001341439-26-000010")!;
    assert.ok(june.materials.some(m => m.kind === "transcript" && m.status === "unavailable"));

    // A re-run (retry, redeploy, duplicate start) reuses every stored extraction.
    await executeGuidanceWorkflow({ ticker: "ORCL", accession: "0001341439-26-000020", eventDate: "2026-09-09" }, h.step, env, deps);
    assert.equal(fake.calls.length, 4);
    assert.ok(readEnv(db) && (await new D1SecRepository(db).getCache(guidanceCacheKey("ORCL")))?.payload);
  } finally { db.close(); }
});

test("a fresh event publishes the release first and waits a bounded number of times for the transcript", async () => {
  const { db, env } = await setup();
  try {
    const h = harness({ transcriptAfter: 2 });
    const fake = fakeModel();
    const result = await executeGuidanceWorkflow({ ticker: "ORCL", accession: "0001341439-26-000040", eventDate: today }, h.step, env,
      { model: fake.model, transcripts: h.transcripts, secExhibits: h.secExhibits, deckSearch: null });
    assert.equal(result.transcript, "extracted");
    assert.equal(h.probes(), 3);
    assert.deepEqual(h.sleeps.map(s => s.name), ["guidance-transcript-wait-1", "guidance-transcript-wait-2"]);
    assert.ok(h.sleeps.every(s => s.ms > 0));
    const status = await db.prepare(`SELECT status,transcript_status FROM earnings_events WHERE accession=?`).bind("0001341439-26-000040").first();
    assert.deepEqual({ ...status }, { status: "complete", transcript_status: "extracted" });

    const never = harness({ transcriptAfter: Infinity });
    const again = await executeGuidanceWorkflow({ ticker: "ORCL", accession: "0001341439-26-000040", eventDate: today }, never.step, env,
      { model: fake.model, transcripts: { ...never.transcripts, async find() { return null; } }, secExhibits: never.secExhibits, deckSearch: null });
    assert.equal(again.transcript, "unavailable");
    assert.equal(never.sleeps.length, 4, "four re-checks, then it stops");
  } finally { db.close(); }
});

test("the daily model budget is a hard cap and usage accumulates per day", async () => {
  const { db, env } = await setup();
  try {
    const store = new GuidanceStore(db, env.SEC_FILINGS);
    assert.ok(await store.reserve("guidance-model", "2026-10-04", 2));
    assert.ok(await store.reserve("guidance-model", "2026-10-04", 2));
    assert.equal(await store.reserve("guidance-model", "2026-10-04", 2), false);
    assert.ok(await store.reserve("guidance-model", "2026-10-05", 2));
    await store.recordUsage("2026-10-04", "guidance", "deepseek-flash", { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, completion_tokens: 50 });
    await store.recordUsage("2026-10-04", "guidance", "deepseek-flash", { prompt_tokens: 500, prompt_cache_hit_tokens: 0, completion_tokens: 10 });
    assert.deepEqual({ ...await db.prepare(`SELECT calls,input_tokens,cached_tokens,output_tokens FROM ai_usage_log`).bind().first() },
      { calls: 2, input_tokens: 1500, cached_tokens: 800, output_tokens: 60 });
  } finally { db.close(); }
});
