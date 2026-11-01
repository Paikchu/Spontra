import assert from "node:assert/strict";
import { test } from "node:test";
import { publishPeers } from "../src/peers/projection.ts";
import { auditDb } from "./fixtures/audit-data.ts";

test("A19: every required projection read failure preserves the published peers", async () => {
  const faults: Array<[string, (sql: string, binds: unknown[]) => boolean]> = [
    ["company", sql => sql.includes("SELECT v.payload_json")],
    ["snapshot", (sql, binds) => sql.includes("sec_cache") && binds[0] === "sec:map-derived:v1:ACME"],
    ["fundamentals", sql => sql.includes("FROM sec_facts")],
    ["categories", sql => sql.includes("FROM sec_business_links")],
    ["units", sql => sql.includes("FROM sec_business_units")],
    ["pairs", sql => sql.includes("FROM sec_peer_pairs")],
    ["prior publication", (sql, binds) => sql.includes("sec_cache") && binds[0] === "peers:v1"],
    ["cited findings", (sql, binds) => sql.includes("sec_cache") && binds[0] === "findings:v2:ACME"],
  ];
  for (const [name, fail] of faults) {
    const before = { schemaVersion: "peers.v1", generatedAt: "2026-01-01T00:00:00Z", companies: [] };
    const fixture = auditDb({ fail, cache: { "peers:v1": before } });
    await assert.rejects(publishPeers({ DB: fixture.db, SEC_DATA_TICKERS: "ACME" }, new Date("2026-11-01T00:00:00Z")), /injected read failure/, name);
    assert.equal(fixture.writes.length, 0, name);
    assert.deepEqual(fixture.cache["peers:v1"], before);
  }
});

test("A19: successful reads with genuinely absent optional data can publish", async () => {
  const fixture = auditDb();
  const result = await publishPeers({ DB: fixture.db, SEC_DATA_TICKERS: "ACME" }, new Date("2026-11-01T00:00:00Z"));
  assert.equal(result.companies, 1);
  assert.equal(result.quarters, 2);
  assert.ok(fixture.writes.length > 0);
});
