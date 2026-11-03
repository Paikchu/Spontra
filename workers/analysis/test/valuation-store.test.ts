import { latestValuationQuote, refreshValuationQuotes } from "../src/valuation/quotes.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ValuationEvidence, ValuationPublication } from "../../../shared/analysis-contract/valuation.ts";
import { readValuationPublication } from "../../../shared/analysis-runtime/valuation/read.ts";
import { readValuationResponse, ValuationStore } from "../src/valuation/store.ts";
import { featureShown } from "../src/admin/feature-settings.ts";
import { recordFeatureFailure } from "../src/admin/messages.ts";

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

const dimension = (key: ValuationPublication["dimensions"][number]["key"], score: number | null) => ({ key, score, confidence: "medium" as const, rationale: "r", supportingEvidenceIds: ["e0123456789"], counterEvidenceIds: [], gaps: score == null ? ["gap"] : [], nextCheck: "n" });
const evidence: ValuationEvidence = { evidenceId: "e0123456789", kind: "sec", title: "ACME 10-K 2026-05-31", url: "https://www.sec.gov/x", documentId: "d1", passageId: "p1", form: "10-K", publishedAt: "2026-06-20", fetchedAt: "2026-10-28T00:00:00.000Z", excerpt: "We sell widgets.", contentSha256: "abc", path: "Item 1 › Business" };
function publication(versionId: string, reportStatus: "ready" | "insufficient", generatedAt: string): ValuationPublication {
  return {
    schemaVersion: "valuation.v1", ticker: "ACME", cik: "0000000001", companyName: "Acme", currency: "USD", researchAsOf: generatedAt, financialPeriodEnd: "2026-08-31", generatedAt, methodVersion: "valuation.v1", calculatorVersion: "valuation.calc.v1",
    baseInputFingerprint: "fp1", evidenceSetHash: "h", reportStatus, verdict: "pending", weightedScore: reportStatus === "ready" ? 6.7 : null, confidence: "medium",
    dimensions: [dimension("businessQuality", 8), dimension("growthExecution", 7), dimension("valuationSafety", reportStatus === "ready" ? 6 : null), dimension("mispricingCatalysts", 5), dimension("financialResilience", 9)],
    quote: { price: 80, currency: "USD", priceDate: "2026-10-27", source: "Yahoo Finance", sourceUrl: "https://example.test", fetchedAt: generatedAt, usable: true, limitations: [] },
    model: null, facts: [], diagnostics: [], distributions: [], sections: { summary: "s", thesis: "t", expectationsGap: "g", catalysts: [], counterEvidence: [], nextChecks: ["c"], modelNotes: "" }, evidence: [evidence], gaps: [], versionId,
  };
}

test("the migration widens the feature switch and inbox to the valuation and keeps existing rows", async () => {
  const db = database();
  await db.prepare("INSERT INTO business_feature_settings (ticker, feature, generate, display, updated_at) VALUES ('ACME', 'valuation', 1, 1, '2026-10-28T00:00:00Z')").bind().run();
  assert.equal(await featureShown(db, "ACME", "valuation"), true);
  assert.equal(await featureShown(db, "OTHER", "valuation"), false);
  await recordFeatureFailure(db, "ACME", "valuation", "boom", "2026-10-28T01:00:00Z");
  const row = await db.prepare("SELECT generate, display FROM business_feature_settings WHERE ticker = 'ACME' AND feature = 'valuation'").bind().first<{ generate: number; display: number }>();
  assert.deepEqual({ ...row }, { generate: 0, display: 1 });
});

test("publish: a ready report becomes current only under the generation it started with; an insufficient one never replaces a ready one", async () => {
  const db = database();
  const store = new ValuationStore(db);
  const g1 = await store.advance("ACME", "2026-10-28T00:00:00.000Z");
  assert.equal(g1, 1);
  const first = await store.publish("ACME", publication("v1", "insufficient", "2026-10-28T01:00:00.000Z"), [evidence], g1, "fp1", "2026-10-28T01:00:00.000Z");
  assert.deepEqual(first, { current: true, stored: true });
  let response = await readValuationResponse(db, "ACME");
  assert.equal(response.availability, "insufficient");
  assert.equal(response.report?.versionId, "v1");
  assert.equal(await store.publishedFingerprint("ACME"), "fp1");
  // A ready report replaces the insufficient one.
  const second = await store.publish("ACME", publication("v2", "ready", "2026-10-28T02:00:00.000Z"), [evidence], g1, "fp2", "2026-10-28T02:00:00.000Z");
  assert.equal(second.current, true);
  response = await readValuationResponse(db, "ACME");
  assert.equal(response.availability, "ready");
  assert.equal(response.report?.versionId, "v2");
  // A later insufficient report is stored as a version but the ready one stays current.
  const third = await store.publish("ACME", publication("v3", "insufficient", "2026-10-28T03:00:00.000Z"), [evidence], g1, "fp3", "2026-10-28T03:00:00.000Z");
  assert.deepEqual(third, { current: false, stored: true });
  response = await readValuationResponse(db, "ACME");
  assert.equal(response.report?.versionId, "v2");
  assert.equal(response.versions.length, 3);
  assert.equal(await store.publishedFingerprint("ACME"), "fp3");
  // The generation moved on (a switch change, a reassessment): a run from the old generation cannot publish.
  const g2 = await store.advance("ACME", "2026-10-28T04:00:00.000Z");
  assert.equal(g2, 2);
  const stale = await store.publish("ACME", publication("v4", "ready", "2026-10-28T05:00:00.000Z"), [evidence], g1, "fp4", "2026-10-28T05:00:00.000Z");
  assert.equal(stale.current, false);
  assert.equal((await readValuationResponse(db, "ACME")).report?.versionId, "v2");
  // The same content published twice is one version.
  const again = await store.publish("ACME", publication("v2", "ready", "2026-10-28T06:00:00.000Z"), [evidence], g2, "fp2", "2026-10-28T06:00:00.000Z");
  assert.deepEqual(again, { current: true, stored: false });
  assert.equal((await store.versions("ACME")).length, 4);
  // Evidence is read only through a version that cites it, and a hidden company answers with nothing.
  assert.equal((await store.evidence("ACME", "v2", "e0123456789"))?.title, evidence.title);
  assert.equal(await store.evidence("ACME", "v2", "e9999999999"), null);
  assert.equal(await store.evidence("OTHER", "v2", "e0123456789"), null);
  assert.equal((await readValuationResponse(db, "ACME", { hidden: true })).availability, "hidden");
  const outbox = await db.prepare("SELECT count(*) n FROM pipeline_outbox WHERE type = 'valuation.published'").bind().first<{ n: number }>();
  assert.equal(outbox?.n, 3);
});

test("the stored payload reads back through the contract; a payload for another ticker or with a missing dimension does not", () => {
  const p = publication("v1", "ready", "2026-10-28T01:00:00.000Z");
  assert.ok(readValuationPublication(p, "ACME"));
  assert.equal(readValuationPublication(p, "OTHER"), null);
  assert.equal(readValuationPublication({ ...p, dimensions: p.dimensions.slice(1) }, "ACME"), null);
});

test("an unfinished refresh invalidates the public resource while retaining the prior report", async () => {
  const db = database(), store = new ValuationStore(db);
  const issuedAt = "2026-10-28T01:00:00.000Z";
  const generation = await store.advance("ACME", issuedAt);
  await store.publish("ACME", publication("ready-report", "ready", issuedAt), [evidence], generation, "fp1", issuedAt);
  for (const [status, updatedAt] of [["running", "2026-10-28T02:00:00.000Z"], ["empty", "2026-10-28T02:10:00.000Z"]] as const) {
    await store.noteAttempt("ACME", { runId: "refresh", status, stage: status === "running" ? "input" : "publish", updatedAt, reportStatus: status === "empty" ? "insufficient" : null, gaps: [], errorCode: null }, updatedAt);
    const response = await readValuationResponse(db, "ACME");
    assert.equal(response.report?.versionId, "ready-report");
    assert.equal(response.latestAttempt?.status, status);
    assert.equal(response.outdated, true);
    assert.equal((await db.prepare("SELECT revision FROM publication_revisions WHERE ticker='ACME' AND resource='valuation'").bind().first<{ revision: string }>())?.revision, updatedAt);
  }
});


test("reference closes refresh visible ranges and their read revision without rewriting research", async () => {
  const db = database();
  const report = publication("quote-version", "ready", "2026-10-28T00:00:00Z");
  await db.prepare("INSERT INTO valuation_versions (version_id,ticker,generated_at,research_as_of,report_status,method_version,calculator_version,base_input_fingerprint,evidence_set_hash,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(report.versionId, "ACME", report.generatedAt, report.researchAsOf, "ready", "v6", "v8", "input", "evidence", JSON.stringify({ ...report, model: { fairValueRange: { status: "available" } } })).run();
  await db.prepare("INSERT INTO valuation_current (ticker,version_id,request_generation,updated_at) VALUES ('ACME',?,1,?)").bind(report.versionId, report.generatedAt).run();
  await db.prepare("INSERT INTO business_feature_settings (ticker,feature,generate,display,updated_at) VALUES ('ACME','valuation',1,NULL,?)").bind(report.generatedAt).run();
  const before = await db.prepare("SELECT payload_json FROM valuation_versions WHERE version_id=?").bind(report.versionId).first<{ payload_json: string }>();
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({ chart: { result: [{ meta: { symbol: "ACME", currency: "USD", exchangeTimezoneName: "America/New_York" }, timestamp: [Date.parse("2026-11-02T14:30:00Z") / 1000], indicators: { quote: [{ close: [110] }] } }] } }); };
  const at = new Date("2026-11-03T10:00:00Z");
  assert.deepEqual(await refreshValuationQuotes({ DB: db }, at, fetcher), { refreshed: 1, failed: [] });
  assert.equal((await latestValuationQuote(db, "ACME", report.quote))?.price, 110);
  const revision = await db.prepare("SELECT revision FROM publication_revisions WHERE ticker='ACME' AND resource='valuation'").bind().first<{ revision: string }>();
  assert.equal(revision?.revision, at.toISOString());
  assert.deepEqual(await db.prepare("SELECT payload_json FROM valuation_versions WHERE version_id=?").bind(report.versionId).first(), before);
  assert.equal((await refreshValuationQuotes({ DB: db }, new Date(at.getTime() + 60_000), fetcher)).refreshed, 0);
  assert.equal(calls, 1);
  const failedAt = new Date("2026-11-11T10:00:00Z");
  assert.deepEqual(await refreshValuationQuotes({ DB: db }, failedAt, async () => new Response("unavailable", { status: 503 })), { refreshed: 0, failed: ["ACME"] });
  assert.equal((await latestValuationQuote(db, "ACME", report.quote))?.price, 110);
  assert.equal((await db.prepare("SELECT revision FROM publication_revisions WHERE ticker='ACME' AND resource='valuation'").bind().first<{ revision: string }>())?.revision, failedAt.toISOString());
});
