import assert from "node:assert/strict";
import test from "node:test";

import { ANALYSIS_API_SCHEMAS, validateJsonSchema } from "../../workers/pipeline/src/read-api/contract-support/index.ts";
import { handleAnalysisReadRequest } from "../../workers/pipeline/src/read-api/router.ts";
import {
  FILINGS_ONLY_TOKEN,
  ReadOnlyGuardDatabase,
  createAnalysisDatabase,
  readEnv,
  readRequest,
} from "./helpers/analysis-backend.ts";
import {
  EMPTY_TICKER,
  ETF_TICKER,
  EVENT_ACCESSION,
  FAILED_ACCESSION,
  FIXTURE_TICKER,
  PARTIAL_ACCESSION,
  QUEUED_ACCESSION,
  UNKNOWN_ACCESSION,
  UNTRACKED_TICKER,
  VERIFIED_ACCESSION,
  VERIFIED_PERIOD_ID,
  seedAnalysisFixtures,
  seedCompanyAnalysisPublication,
  seedFundamentals,
} from "./helpers/analysis-fixtures.ts";
import type { PublicFilingDetail, PublicFilingPage } from "../../shared/analysis-contract/filings.ts";
import type { PublicCompanyAnalysisResponse } from "../../workers/pipeline/src/company-analysis/contracts.ts";
import type { PublicFundamentalsResponse } from "../../shared/analysis-contract/fundamentals.ts";

/**
 * The backend answering on its own, with no Web Worker anywhere in the picture: a real SQLite
 * database carrying the project's real migrations, the real repositories, and the real router.
 */
async function backend() {
  const database = await createAnalysisDatabase();
  await seedAnalysisFixtures(database);
  seedCompanyAnalysisPublication(database);
  seedFundamentals(database, { fetchedAt: "2026-08-28T00:00:00.000Z" });
  return database;
}

async function get(database: unknown, path: string, init: Parameters<typeof readRequest>[1] = {}) {
  return handleAnalysisReadRequest(readRequest(path, init), readEnv(database));
}

test("filing list answers without Web, and validates against the published schema", async () => {
  const database = await backend();
  const response = await get(database, `/api/v1/companies/${FIXTURE_TICKER}/filings`);
  assert.equal(response.status, 200);
  const page = await response.json() as PublicFilingPage;
  assert.deepEqual(validateJsonSchema(ANALYSIS_API_SCHEMAS.FilingPage, page), []);
  assert.equal(page.ticker, FIXTURE_TICKER);
  assert.equal(page.total, 5);
  assert.equal(page.filings.length, 5);
  // Newest first, unchanged ordering.
  assert.deepEqual(page.filings.map((filing) => filing.accessionNumber), [
    VERIFIED_ACCESSION, PARTIAL_ACCESSION, EVENT_ACCESSION, QUEUED_ACCESSION, FAILED_ACCESSION,
  ]);
  database.close();
});

test("pagination is bounded, keyset-stable, and terminates", async () => {
  const database = await backend();
  const first = await (await get(database, `/api/v1/companies/${FIXTURE_TICKER}/filings?limit=2`)).json() as PublicFilingPage;
  assert.equal(first.filings.length, 2);
  assert.equal(first.total, 5);
  assert.ok(first.nextCursor);

  const second = await (await get(database, `/api/v1/companies/${FIXTURE_TICKER}/filings?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)).json() as PublicFilingPage;
  assert.equal(second.filings.length, 2);
  // Only the first page carries a count; a later page reports null and the client keeps what it has.
  assert.equal(second.total, null);
  assert.equal(
    new Set([...first.filings, ...second.filings].map((filing) => filing.accessionNumber)).size,
    4,
    "pages must not overlap",
  );

  // A limit beyond the published maximum is clamped rather than honoured.
  const huge = await (await get(database, `/api/v1/companies/${FIXTURE_TICKER}/filings?limit=9999`)).json() as PublicFilingPage;
  assert.equal(huge.filings.length, 5);
  assert.deepEqual(validateJsonSchema(ANALYSIS_API_SCHEMAS.FilingPage, huge), []);
  database.close();
});

test("a company with nothing collected is an empty success, not an error", async () => {
  const database = await backend();
  const response = await get(database, `/api/v1/companies/${EMPTY_TICKER}/filings`);
  assert.equal(response.status, 200);
  const page = await response.json() as PublicFilingPage;
  assert.deepEqual(page.filings, []);
  assert.equal(page.total, 0);
  assert.equal(page.nextCursor, null);
  database.close();
});

test("filing detail carries the report, its provenance, its period and its revision", async () => {
  const database = await backend();
  const response = await get(database, `/api/v1/companies/${FIXTURE_TICKER}/filings/${VERIFIED_ACCESSION}`);
  assert.equal(response.status, 200);
  const detail = await response.json() as PublicFilingDetail;
  assert.deepEqual(validateJsonSchema(ANALYSIS_API_SCHEMAS.FilingDetail, detail), []);
  assert.equal(detail.filing.analysisStatus, "complete");
  assert.equal(detail.filing.provenance, "sec_edgar");
  assert.equal(detail.filing.periodId, VERIFIED_PERIOD_ID);
  assert.equal(detail.filing.analysisSchemaVersion, "sec-analysis.v2");
  assert.equal(detail.filing.contentRevision, "aaaa1111");
  // Structured facts and their evidence are reachable without reading prose.
  assert.equal(detail.filing.analysis?.keyMetrics[0]?.metricKey, "revenue");
  assert.deepEqual(detail.filing.analysis?.keyMetrics[0]?.evidenceIds, ["ev-1"]);
  assert.ok(detail.filing.edgarUrl.startsWith("https://www.sec.gov/"));
  database.close();
});

/**
 * §4.2 and A12: an 8-K legitimately carries a narrative summary and no structured report, and a
 * partial report is partial — neither may be dressed up as a verified full earnings report.
 */
test("summary-only event filings and partial reports keep their real quality", async () => {
  const database = await backend();
  const page = await (await get(database, `/api/v1/companies/${FIXTURE_TICKER}/filings`)).json() as PublicFilingPage;
  const byAccession = new Map(page.filings.map((filing) => [filing.accessionNumber, filing]));

  const event = byAccession.get(EVENT_ACCESSION)!;
  assert.equal(event.analysis, null);
  assert.equal(event.analysisStatus, "not_collected");
  assert.equal(event.summary?.eventCategory, "executive");
  assert.ok(event.summary?.headline);
  assert.equal(event.periodId, null);

  const partial = byAccession.get(PARTIAL_ACCESSION)!;
  assert.equal(partial.analysisStatus, "partial");
  assert.equal(partial.analysis?.dataQuality.verificationStatus, "partial");
  assert.notEqual(partial.analysisStatus, "complete");
  assert.deepEqual(partial.analysis?.dataQuality.warnings, ["Synthetic coverage warning."]);
  database.close();
});

/** §4.4 / A09 for filings: a failed run is never presented as "never collected" and nothing else. */
test("filing run state distinguishes queued, failed, succeeded and no history", async () => {
  const database = await backend();
  const page = await (await get(database, `/api/v1/companies/${FIXTURE_TICKER}/filings`)).json() as PublicFilingPage;
  const byAccession = new Map(page.filings.map((filing) => [filing.accessionNumber, filing]));

  assert.deepEqual(byAccession.get(QUEUED_ACCESSION)!.analysisRun, {
    state: "queued", updatedAt: "2026-02-10T10:00:00.000Z", errorCode: null,
  });
  assert.equal(byAccession.get(QUEUED_ACCESSION)!.analysisStatus, "processing");

  const failed = byAccession.get(FAILED_ACCESSION)!;
  assert.equal(failed.analysisStatus, "not_collected");
  assert.equal(failed.analysisRun.state, "failed", "a failed run must be visible, not hidden behind not_collected");
  assert.equal(failed.analysisRun.errorCode, "MODEL_RATE_LIMITED");

  assert.equal(byAccession.get(VERIFIED_ACCESSION)!.analysisRun.state, "succeeded");
  // No job row at all is genuinely-absent history, distinct from a failure.
  assert.equal(byAccession.get(EVENT_ACCESSION)!.analysisRun.state, "none");
  database.close();
});

test("company analysis returns the published result and validates", async () => {
  const database = await backend();
  const response = await get(database, `/api/v1/companies/${FIXTURE_TICKER}/analysis`);
  assert.equal(response.status, 200);
  const payload = await response.json() as PublicCompanyAnalysisResponse;
  assert.deepEqual(validateJsonSchema(ANALYSIS_API_SCHEMAS.CompanyAnalysis, payload), []);
  assert.equal(payload.status, "ready");
  assert.equal(payload.overview?.highlights.length, 4);
  assert.deepEqual(payload.overview?.highlights[0]?.evidenceRefs, ["evidence-1"]);
  // API schema, content revision and pipeline versions are three different things.
  assert.equal(payload.versions.apiSchema, "analysis-api.v1");
  assert.equal(payload.versions.payloadSchema, "company-analysis.v1");
  assert.equal(payload.versions.contentRevision, "input-hash-0001");
  assert.equal(payload.versions.model, "test-model.v1");
  assert.notEqual(payload.versions.contentRevision, payload.versions.apiSchema);
  database.close();
});

test("fundamentals report SEC provenance and never fall back to Yahoo", async () => {
  const database = await backend();
  const response = await get(database, `/api/v1/companies/${FIXTURE_TICKER}/fundamentals?periodCount=2`);
  assert.equal(response.status, 200);
  const payload = await response.json() as PublicFundamentalsResponse;
  assert.deepEqual(validateJsonSchema(ANALYSIS_API_SCHEMAS.Fundamentals, payload), []);
  assert.equal(payload.source, "sec_xbrl");
  assert.equal(payload.status, "pending", "Yahoo snapshots cannot fill missing SEC quarters");
  assert.equal(payload.refresh.scheduled, false);
  assert.equal(payload.refresh.mode, "backend_scheduled");
  database.close();
});

test("malformed input, unknown resources and unknown routes are each their own answer", async () => {
  const database = await backend();
  const cases: Array<[string, number, string]> = [
    [`/api/v1/companies/not-a-ticker/filings`, 400, "INVALID_TICKER"],
    [`/api/v1/companies/${FIXTURE_TICKER}/filings?cursor=%7Bnot-base64%7D`, 400, "INVALID_CURSOR"],
    [`/api/v1/companies/${FIXTURE_TICKER}/fundamentals?metrics=nope`, 400, "INVALID_METRICS"],
    [`/api/v1/companies/${FIXTURE_TICKER}/fundamentals?periodCount=99`, 400, "INVALID_PERIOD_COUNT"],
    [`/api/v1/companies/${FIXTURE_TICKER}/filings/${UNKNOWN_ACCESSION}`, 404, "FILING_NOT_FOUND"],
    [`/api/v1/companies/${FIXTURE_TICKER}/filings/not-an-accession`, 404, "FILING_NOT_FOUND"],
    [`/api/v1/companies/${ETF_TICKER}/fundamentals`, 404, "FUNDAMENTALS_NOT_AVAILABLE"],
    [`/api/v1/companies/${FIXTURE_TICKER}/nonsense`, 404, "ROUTE_NOT_FOUND"],
    [`/api/v1/nonsense`, 404, "ROUTE_NOT_FOUND"],
  ];
  for (const [path, status, code] of cases) {
    const response = await get(database, path);
    const body = await response.json() as { code: string };
    assert.equal(response.status, status, path);
    assert.equal(body.code, code, path);
    assert.deepEqual(validateJsonSchema(ANALYSIS_API_SCHEMAS.AnalysisError, body), [], path);
  }

  // A URL long enough to be an attack rather than a query is refused before it reaches storage.
  const long = await get(database, `/api/v1/companies/${FIXTURE_TICKER}/filings?cursor=${"a".repeat(2_100)}`);
  assert.equal(long.status, 400);
  assert.equal((await long.json() as { code: string }).code, "REQUEST_TOO_LARGE");
  database.close();
});

/** §4.2: an infrastructure failure must never be served as an empty success. */
test("a storage failure is a 503 with no internal detail, not an empty result", async () => {
  const exploding = {
    prepare() { throw new Error("D1_ERROR: no such table: sec_filings at internal-host-9"); },
    batch() { throw new Error("D1_ERROR"); },
  };
  for (const path of ["filings", "analysis", "fundamentals"]) {
    const response = await handleAnalysisReadRequest(
      readRequest(`/api/v1/companies/${FIXTURE_TICKER}/${path}`),
      readEnv(exploding),
    );
    const text = await response.text();
    assert.equal(response.status, 503, path);
    assert.match(text, /STORAGE_UNAVAILABLE/, path);
    assert.doesNotMatch(text, /no such table|internal-host-9|D1_ERROR/, path);
  }

  // A deployment with no database at all says so rather than reporting empty data.
  const unbound = await handleAnalysisReadRequest(
    readRequest(`/api/v1/companies/${FIXTURE_TICKER}/filings`),
    { ANALYSIS_READ_KEYS: readEnv({}).ANALYSIS_READ_KEYS },
  );
  assert.equal(unbound.status, 503);
  assert.equal((await unbound.json() as { code: string }).code, "STORAGE_UNAVAILABLE");
});

/**
 * A07: not "we did not call the refresh helper" — the database itself refuses every statement that
 * is not a read, so any write on any read path fails the request instead of passing the test.
 */
test("no read path writes anything, on any of the four resources", async () => {
  const database = await backend();
  const guard = new ReadOnlyGuardDatabase(database);
  const paths = [
    `/api/v1/companies/${FIXTURE_TICKER}/filings`,
    `/api/v1/companies/${FIXTURE_TICKER}/filings/${VERIFIED_ACCESSION}`,
    `/api/v1/companies/${FIXTURE_TICKER}/analysis`,
    `/api/v1/companies/${FIXTURE_TICKER}/fundamentals`,
    // Missing and stale data are the cases that used to trigger work.
    `/api/v1/companies/${EMPTY_TICKER}/filings`,
    `/api/v1/companies/${EMPTY_TICKER}/analysis`,
    `/api/v1/companies/${EMPTY_TICKER}/fundamentals`,
  ];
  for (const path of paths) {
    const response = await handleAnalysisReadRequest(readRequest(path), readEnv(guard));
    assert.ok(response.status === 200 || response.status === 404, `${path} -> ${response.status}`);
  }
  assert.deepEqual(guard.attemptedWrites, []);
  database.close();
});

/**
 * A07 again, from the other side: reads must not reach a model, a Workflow, or the network. The
 * environment here has no workflow bindings and no model key, and global fetch is booby-trapped.
 */
test("reads work with no model credential, no workflow binding and no network", async () => {
  const database = await backend();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("a read must not make an outbound request"); }) as typeof fetch;
  try {
    for (const path of ["filings", "analysis", "fundamentals"]) {
      const response = await handleAnalysisReadRequest(
        readRequest(`/api/v1/companies/${FIXTURE_TICKER}/${path}`),
        // No AI_API_KEY, no SEC_ANALYSIS_WORKFLOW, no SEC_TRACKED_TICKERS.
        { DB: database as unknown as D1Database, ANALYSIS_READ_KEYS: readEnv({}).ANALYSIS_READ_KEYS },
      );
      assert.equal(response.status, 200, path);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  database.close();
});

/** A20: history stays readable for a company that is not on the generation whitelist. */
test("an untracked company's existing results stay readable, and reading does not enlist it", async () => {
  const database = await backend();
  const response = await handleAnalysisReadRequest(
    readRequest(`/api/v1/companies/${UNTRACKED_TICKER}/filings`),
    // Deliberately narrower than the ticker being read, and never consulted by a read anyway.
    { DB: database as unknown as D1Database, ANALYSIS_READ_KEYS: readEnv({}).ANALYSIS_READ_KEYS, SEC_TRACKED_TICKERS: FIXTURE_TICKER } as never,
  );
  assert.equal(response.status, 200);
  const page = await response.json() as PublicFilingPage;
  assert.equal(page.filings.length, 1);
  database.close();
});

test("caching is private, validated by an ETag that covers status metadata, and authorised first", async () => {
  const database = await backend();
  const first = await get(database, `/api/v1/companies/${FIXTURE_TICKER}/filings`);
  const etag = first.headers.get("etag")!;
  assert.ok(etag);
  assert.match(first.headers.get("cache-control") ?? "", /^private, max-age=30, must-revalidate$/);
  assert.equal(first.headers.get("vary"), "Authorization");

  const revalidated = await get(database, `/api/v1/companies/${FIXTURE_TICKER}/filings`, {
    headers: { "if-none-match": etag },
  });
  assert.equal(revalidated.status, 304);

  // A 304 is a statement about a resource the caller may read, so it cannot precede authentication.
  const anonymous = await handleAnalysisReadRequest(
    readRequest(`/api/v1/companies/${FIXTURE_TICKER}/filings`, { token: null, headers: { "if-none-match": etag } }),
    readEnv(database),
  );
  assert.equal(anonymous.status, 401);
  const wrongScope = await handleAnalysisReadRequest(
    readRequest(`/api/v1/companies/${FIXTURE_TICKER}/analysis`, { token: FILINGS_ONLY_TOKEN, headers: { "if-none-match": "*" } }),
    readEnv(database),
  );
  assert.equal(wrongScope.status, 403);

  // Changing only the run state changes the ETag: status metadata is part of what the tag covers.
  database.raw.prepare("UPDATE sec_analysis_jobs SET status = 'failed', error_code = 'CHANGED', updated_at = '2026-08-01T00:00:00.000Z' WHERE accession_number = ?")
    .run(QUEUED_ACCESSION);
  const afterRunChange = await get(database, `/api/v1/companies/${FIXTURE_TICKER}/filings`, {
    headers: { "if-none-match": etag },
  });
  assert.equal(afterRunChange.status, 200, "a changed run state must invalidate the cached representation");
  assert.notEqual(afterRunChange.headers.get("etag"), etag);
  database.close();
});

test("non-terminal and absent states are never stored as report content", async () => {
  const database = await createAnalysisDatabase();
  await seedAnalysisFixtures(database);
  const analysis = await get(database, `/api/v1/companies/${FIXTURE_TICKER}/analysis`);
  assert.equal((await analysis.clone().json() as PublicCompanyAnalysisResponse).status, "unavailable");
  assert.equal(analysis.headers.get("cache-control"), "no-store");

  const fundamentals = await get(database, `/api/v1/companies/${FIXTURE_TICKER}/fundamentals`);
  assert.equal((await fundamentals.clone().json() as PublicFundamentalsResponse).status, "pending");
  assert.equal(fundamentals.headers.get("cache-control"), "no-store");
  database.close();
});

test("the per-credential rate limit is enforced, and its absence is not faked", async () => {
  const database = await backend();
  const keys: string[] = [];
  const limited = await handleAnalysisReadRequest(
    readRequest(`/api/v1/companies/${FIXTURE_TICKER}/filings`),
    readEnv(database, {
      ANALYSIS_READ_RATE_LIMIT: { async limit({ key }) { keys.push(key); return { success: false }; } },
    }),
  );
  assert.equal(limited.status, 429);
  assert.equal((await limited.json() as { code: string }).code, "RATE_LIMITED");
  // Keyed on the credential, so one consumer cannot spend another's quota.
  assert.deepEqual(keys, ["test-consumer"]);

  const allowed = await handleAnalysisReadRequest(
    readRequest(`/api/v1/companies/${FIXTURE_TICKER}/filings`),
    readEnv(database, { ANALYSIS_READ_RATE_LIMIT: { async limit() { return { success: true }; } } }),
  );
  assert.equal(allowed.status, 200);
  database.close();
});

test("the contract document is reachable without a credential and is the only such resource", async () => {
  const database = await backend();
  const response = await handleAnalysisReadRequest(
    readRequest("/api/v1/openapi.json", { token: null }),
    readEnv(database),
  );
  assert.equal(response.status, 200);
  const document = await response.json() as { openapi: string; paths: Record<string, unknown> };
  assert.equal(document.openapi, "3.1.0");
  // Nothing carrying data is reachable the same way.
  for (const path of ["filings", "analysis", "fundamentals"]) {
    const denied = await handleAnalysisReadRequest(
      readRequest(`/api/v1/companies/${FIXTURE_TICKER}/${path}`, { token: null }),
      readEnv(database),
    );
    assert.equal(denied.status, 401, path);
  }
  database.close();
});

test("no response body carries a credential, a prompt or an internal trace", async () => {
  const database = await backend();
  const bodies: string[] = [];
  for (const path of [
    `/api/v1/companies/${FIXTURE_TICKER}/filings`,
    `/api/v1/companies/${FIXTURE_TICKER}/filings/${FAILED_ACCESSION}`,
    `/api/v1/companies/${FIXTURE_TICKER}/analysis`,
    `/api/v1/companies/${FIXTURE_TICKER}/fundamentals`,
  ]) {
    bodies.push(await (await get(database, path)).text());
  }
  const combined = bodies.join("\n");
  assert.doesNotMatch(combined, /test-read-secret|ANALYSIS_READ_KEYS|SEC_REFRESH_KEY|AI_API_KEY|Bearer /);
  database.close();
});
