import { test } from "node:test";
import assert from "node:assert/strict";
import type { HomeDigest } from "../../../shared/analysis-contract/home.ts";
import { handleMapRead } from "../src/read-api/router.ts";
import { dataResponse } from "../src/read-api/http.ts";

// Empty stored publications; only read operations are available to the route.
function emptyDatabase(): D1Database {
  const statement = {
    bind: () => statement,
    all: async () => ({ results: [] }),
  };
  return { prepare: (sql: string) => {
    assert.match(sql.trim(), /^SELECT\b/i);
    return statement;
  } } as unknown as D1Database;
}

test("home revalidates unchanged content across generation times and invalidates changed content", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T00:00:00Z") });
  const env = { DB: emptyDatabase(), SEC_DATA_TICKERS: "ACME" };
  const url = "https://analysis.internal/api/v1/home";
  const first = await handleMapRead(new Request(url), env);
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  assert.ok(etag?.startsWith('W/"'));
  const firstBody = await first.json() as HomeDigest;
  assert.equal(firstBody.generatedAt, "2026-11-02T00:00:00.000Z");

  t.mock.timers.tick(1_000);
  const fresh = await handleMapRead(new Request(url), env);
  assert.equal(fresh.status, 200);
  const freshBody = await fresh.json() as HomeDigest;
  assert.equal(freshBody.generatedAt, "2026-11-02T00:00:01.000Z");
  assert.deepEqual({ ...freshBody, generatedAt: firstBody.generatedAt }, firstBody);

  const conditional = () => new Request(url, { headers: { "if-none-match": etag! } });
  const unchanged = await handleMapRead(conditional(), env);
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get("etag"), etag);
  assert.equal(unchanged.headers.get("cache-control"), first.headers.get("cache-control"));
  assert.equal(await unchanged.text(), "");

  const changed = await handleMapRead(conditional(), { ...env, SEC_DATA_TICKERS: "ACME,WAIT" });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), etag);
  const changedBody = await changed.json() as HomeDigest;
  assert.deepEqual(changedBody.companies.map(company => company.ticker), ["ACME", "WAIT"]);
  assert.equal(changedBody.generatedAt, freshBody.generatedAt);
});

test("other read responses still validate generatedAt as part of their full body", async () => {
  const url = "https://analysis.internal/api/v1/companies/ACME/findings";
  const payload = { schemaVersion: "findings.v1", generatedAt: "2026-11-02T00:00:00Z" };
  const first = await dataResponse(new Request(url), payload);
  const etag = first.headers.get("etag");
  assert.ok(etag);
  const changed = await dataResponse(new Request(url, { headers: { "if-none-match": etag } }), {
    ...payload, generatedAt: "2026-11-02T00:00:01Z",
  });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), etag);
});
