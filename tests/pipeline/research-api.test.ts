import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { SqliteD1Database } from "./helpers/sqlite-d1.ts";
import { handleResearchRequest } from "../../workers/pipeline/src/research/api.ts";
import type { SecPipelineEnv } from "../../workers/pipeline/src/operations.ts";

test("research universe requires its own credential, ignores older holdings, and exposes no fake reports", async t => {
  const db = new SqliteD1Database(); t.after(() => db.close());
  db.raw.exec(readFileSync(new URL("../../workers/pipeline/migrations/0012_autonomous_research.sql", import.meta.url), "utf8"));
  const env = { DB: db, RESEARCH_SYNC_KEY: "test-research-key" } as unknown as SecPipelineEnv;
  const request = (tickers: string[], asOf: string, key = "test-research-key") => new Request("https://test/research/universe", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ tickers, asOf }),
  });
  assert.equal((await handleResearchRequest(request(["ORCL"], "2025-01-01T00:00:00.000Z", "analysis-reader"), env)).status, 401);
  assert.equal((await handleResearchRequest(request(["ORCL", "ORCL", "BOXX", "DRAM", "VOO", "SPCX"], "2025-01-02T00:00:00.000Z"), env)).status, 200);
  await handleResearchRequest(request(["MSFT"], "2025-01-01T00:00:00.000Z"), env);
  const universe = JSON.parse(String(db.raw.prepare("SELECT payload FROM research_state WHERE key='universe'").get()?.payload));
  assert.deepEqual(universe.tickers, ["ORCL", "SPCX"]);
  const feed = await handleResearchRequest(new Request("https://test/research/feed", { headers: { authorization: "Bearer test-research-key" } }), env);
  assert.deepEqual((await feed.json() as { reports: unknown[] }).reports, []);
  assert.equal((await handleResearchRequest(new Request("https://test/research/feed?cursor=broken", { headers: { authorization: "Bearer test-research-key" } }), env)).status, 400);
});
