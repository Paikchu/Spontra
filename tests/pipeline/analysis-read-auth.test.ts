import assert from "node:assert/strict";
import test from "node:test";

import {
  AnalysisReadKeyConfigError,
  authenticateReadRequest,
  hasScope,
  parseAnalysisReadKeys,
} from "../../workers/pipeline/src/read-api/auth.ts";
import { handleAnalysisReadRequest } from "../../workers/pipeline/src/read-api/router.ts";
import { handleSecAnalysisRequest } from "../../workers/pipeline/src/core.ts";
import { handleFundamentalsRefreshRequest } from "../../workers/pipeline/src/fundamentals.ts";
import {
  FILINGS_ONLY_KEYS,
  FILINGS_ONLY_TOKEN,
  TEST_READ_KEYS,
  TEST_READ_KEY_ID,
  TEST_READ_SECRET,
  TEST_READ_TOKEN,
  createAnalysisDatabase,
  readEnv,
  readRequest,
} from "./helpers/analysis-backend.ts";

const ALL_KEYS = `${TEST_READ_KEYS},${FILINGS_ONLY_KEYS}`;

test("parses credentials, and refuses a malformed list rather than dropping an entry", async () => {
  const credentials = await parseAnalysisReadKeys(ALL_KEYS);
  assert.deepEqual(credentials.map((credential) => credential.keyId), [TEST_READ_KEY_ID, "filings-only"]);
  assert.deepEqual([...credentials[1]!.scopes], ["filings:read"]);
  // The plaintext secret is not retained anywhere on the parsed credential.
  assert.equal(JSON.stringify(credentials).includes(TEST_READ_SECRET), false);

  for (const bad of [
    "no-colons",
    "only:one-part",
    `short:tooshort:*`,
    `${TEST_READ_KEY_ID}:${TEST_READ_SECRET}:`,
    `${TEST_READ_KEY_ID}:${TEST_READ_SECRET}:not-a-scope`,
    `${TEST_READ_KEY_ID}:${TEST_READ_SECRET}:*,${TEST_READ_KEY_ID}:${TEST_READ_SECRET}:*`,
    `bad key:${TEST_READ_SECRET}:*`,
  ]) {
    await assert.rejects(parseAnalysisReadKeys(bad), AnalysisReadKeyConfigError, bad);
  }
});

test("authenticates a correct credential and rejects every near miss", async () => {
  const ok = await authenticateReadRequest(readRequest("/api/v1/companies/MSFT/analysis"), ALL_KEYS);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.identity.keyId, TEST_READ_KEY_ID);

  const rejected = [
    { token: null, why: "no header" },
    { token: "", why: "empty" },
    { token: TEST_READ_SECRET, why: "secret without a keyId" },
    { token: `${TEST_READ_KEY_ID}.wrong-secret-0123456789abcdef`, why: "wrong secret" },
    { token: `unknown-key.${TEST_READ_SECRET}`, why: "unknown keyId" },
    { token: `${TEST_READ_KEY_ID}.${TEST_READ_SECRET}x`, why: "secret with a trailing character" },
    { token: `${TEST_READ_KEY_ID}.`, why: "empty secret" },
  ];
  for (const { token, why } of rejected) {
    const outcome = await authenticateReadRequest(readRequest("/api/v1/companies/MSFT/analysis", { token }), ALL_KEYS);
    assert.deepEqual(outcome, { ok: false, reason: "unauthorized" }, why);
  }
});

test("a revoked credential stops working as soon as it leaves the list", async () => {
  const before = await authenticateReadRequest(readRequest("/x", { token: FILINGS_ONLY_TOKEN }), ALL_KEYS);
  assert.equal(before.ok, true);
  const after = await authenticateReadRequest(readRequest("/x", { token: FILINGS_ONLY_TOKEN }), TEST_READ_KEYS);
  assert.deepEqual(after, { ok: false, reason: "unauthorized" });
});

/** Fail closed: with nothing configured there is no such thing as an authorised reader. */
test("missing read-key configuration fails closed with 503, not open", async () => {
  for (const keys of [undefined, "", "   ", "garbage"]) {
    const outcome = await authenticateReadRequest(readRequest("/x"), keys);
    assert.deepEqual(outcome, { ok: false, reason: "not_configured" }, JSON.stringify(keys));
  }
  const response = await handleAnalysisReadRequest(
    readRequest("/api/v1/companies/MSFT/analysis"),
    { DB: {} as D1Database, ANALYSIS_READ_KEYS: "" },
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { code: string }).code, "READ_AUTH_NOT_CONFIGURED");
});

test("scope enforcement separates 403 from 401", async () => {
  const filingsOnly = await authenticateReadRequest(readRequest("/x", { token: FILINGS_ONLY_TOKEN }), ALL_KEYS);
  assert.equal(filingsOnly.ok && hasScope(filingsOnly.identity, "filings:read"), true);
  assert.equal(filingsOnly.ok && hasScope(filingsOnly.identity, "analysis:read"), false);

  const wildcard = await authenticateReadRequest(readRequest("/x"), ALL_KEYS);
  assert.equal(wildcard.ok && hasScope(wildcard.identity, "analysis:read"), true);

  const forbidden = await handleAnalysisReadRequest(
    readRequest("/api/v1/companies/MSFT/analysis", { token: FILINGS_ONLY_TOKEN }),
    readEnv({}),
  );
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json() as { code: string }).code, "FORBIDDEN_SCOPE");
});

/**
 * The point of §4.5: the backend's fetch handler is publicly reachable, so being reached over a
 * Service Binding cannot be treated as proof of anything. None of these headers is consulted.
 */
test("no forged header, origin or host claim substitutes for a credential", async () => {
  const forgeries: Array<Record<string, string>> = [
    { "x-internal": "true" },
    { "x-forwarded-host": "earning-report-analysis-sec-web" },
    { origin: "https://earning-report-analysis-sec-web.workers.dev" },
    { referer: "https://earning-report-analysis-sec-web.workers.dev/stocks/MSFT" },
    { "cf-worker": "earning-report-analysis-sec-web.workers.dev" },
    { "x-service-binding": "PIPELINE" },
    { authorization: "Bearer internal" },
    { authorization: `Basic ${TEST_READ_TOKEN}` },
  ];
  for (const headers of forgeries) {
    const response = await handleAnalysisReadRequest(
      new Request("https://analysis.test/api/v1/companies/MSFT/filings", { headers }),
      readEnv({}),
    );
    assert.equal(response.status, 401, JSON.stringify(headers));
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
  }
});

/**
 * A read credential is not an administrative one. The control handlers consult `SEC_REFRESH_KEY`
 * and never the read-key list, so a reader cannot start a workflow, a backfill or a refresh.
 */
test("a read credential cannot reach any control operation", async () => {
  const controlEnv = {
    SEC_REFRESH_KEY: "admin-secret-value",
    SEC_TRACKED_TICKERS: "MSFT",
    SEC_ANALYSIS_WORKFLOW: { create() { throw new Error("a read credential must never start a workflow"); } },
    ANALYSIS_READ_KEYS: ALL_KEYS,
  };
  const attempts = [
    new Request("https://pipeline.test/jobs/MSFT", { method: "POST", headers: { authorization: `Bearer ${TEST_READ_TOKEN}` } }),
    new Request("https://pipeline.test/jobs/MSFT", { method: "POST", headers: { "x-sec-refresh-key": TEST_READ_TOKEN } }),
    new Request("https://pipeline.test/backfill/MSFT", { method: "POST", headers: { "x-sec-refresh-key": TEST_READ_SECRET } }),
  ];
  for (const request of attempts) {
    const response = await handleSecAnalysisRequest(request, controlEnv as never);
    assert.equal(response.status, 401, request.url);
  }

  const refresh = await handleFundamentalsRefreshRequest(
    new Request("https://pipeline.test/fundamentals/refresh/MSFT", {
      method: "POST",
      headers: { "x-sec-refresh-key": TEST_READ_SECRET },
    }),
    controlEnv as never,
  );
  assert.equal(refresh.status, 401);
});

test("the read router refuses every method that is not a read", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await handleAnalysisReadRequest(
      new Request("https://analysis.test/api/v1/companies/MSFT/filings", {
        method,
        headers: { authorization: `Bearer ${TEST_READ_TOKEN}` },
      }),
      readEnv({}),
    );
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
    // The method check runs before authentication, so nothing can slip through to a write handler.
    assert.equal((await response.json() as { code: string }).code, "METHOD_NOT_ALLOWED");
  }
});

// A new consumer must never require replacing the existing opaque Cloudflare Secret.
test("additional credentials preserve original readers and do not broaden scopes or write access", async () => {
  const { createAnalysisDatabase } = await import("./helpers/analysis-backend.ts");
  const { seedAnalysisFixtures, FIXTURE_TICKER } = await import("./helpers/analysis-fixtures.ts");
  const db = await createAnalysisDatabase();
  try {
    await seedAnalysisFixtures(db);
    const additionalToken = "investment-test.independent-read-secret-0123456789";
    const env = readEnv(db, { ANALYSIS_ADDITIONAL_READ_KEYS: "investment-test:independent-read-secret-0123456789:filings:read" });
    const path = `/api/v1/companies/${FIXTURE_TICKER}/filings`;
    for (const token of [TEST_READ_TOKEN, additionalToken]) {
      assert.equal((await handleAnalysisReadRequest(readRequest(path, { token }), env)).status, 200);
    }
    assert.equal((await handleAnalysisReadRequest(readRequest(`/api/v1/companies/${FIXTURE_TICKER}/analysis`, { token: additionalToken }), env)).status, 403);
    assert.equal((await handleAnalysisReadRequest(readRequest(path, { token: additionalToken, method: "POST" }), env)).status, 405);
    assert.equal((await handleAnalysisReadRequest(readRequest(path, { token: "investment-test.wrong-secret" }), env)).status, 401);
    assert.equal((await handleAnalysisReadRequest(readRequest(path), { ...env, ANALYSIS_ADDITIONAL_READ_KEYS: "malformed" })).status, 200);
  } finally { db.close(); }
});

test("a named-entrypoint binding reads without a credential as the fixed map identity, scoped and rate-limited like any reader", async () => {
  const { handleBoundReadRequest, BOUND_MAP_READER } = await import("../../workers/pipeline/src/read-api/router.ts");
  const database = await createAnalysisDatabase();
  const env = readEnv(database, { ANALYSIS_READ_KEYS: undefined });
  const bare = new Request("https://spontra-analysis.internal/api/v1/companies/ORCL/findings");
  const bound = await handleBoundReadRequest(bare, env, BOUND_MAP_READER);
  assert.equal(bound.status, 200);
  assert.equal(((await bound.json()) as { status: string }).status, "ready");
  // The default entrypoint still demands a credential for the same request.
  assert.equal((await handleAnalysisReadRequest(bare, env)).status, 503, "no keys configured");
  assert.equal((await handleAnalysisReadRequest(bare, readEnv(database))).status, 401);
  // The bound identity keeps the read scopes only, and is counted under its own key by the limiter.
  const limited: string[] = [];
  const throttled = readEnv(database, { ANALYSIS_READ_KEYS: undefined, ANALYSIS_READ_RATE_LIMIT: { async limit({ key }: { key: string }) { limited.push(key); return { success: false }; } } });
  assert.equal((await handleBoundReadRequest(bare, throttled, BOUND_MAP_READER)).status, 429);
  assert.deepEqual(limited, ["business-map"]);
  assert.equal((await handleBoundReadRequest(new Request("https://spontra-analysis.internal/api/v1/companies/ORCL/findings", { method: "POST" }), env, BOUND_MAP_READER)).status, 405);
  assert.equal((await handleBoundReadRequest(bare, env, { keyId: "narrow", scopes: new Set(["filings:read"]) })).status, 403);
});
