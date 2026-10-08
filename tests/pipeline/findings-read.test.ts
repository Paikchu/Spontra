import assert from "node:assert/strict";
import test from "node:test";
import { handleAnalysisReadRequest } from "../../workers/pipeline/src/read-api/router.ts";
import { findingsCacheKey } from "../../workers/pipeline/src/findings/read.ts";
import { ORCL_FINDINGS } from "../../workers/pipeline/src/findings/authored/ORCL.ts";
import { D1SecRepository } from "../../workers/pipeline/src/sec/d1.ts";
import { createAnalysisDatabase, readEnv, readRequest } from "./helpers/analysis-backend.ts";
import type { FindingsResponse } from "../../shared/analysis-contract/findings.ts";

const get = async (database: unknown, ticker: string) => handleAnalysisReadRequest(readRequest(`/api/v1/companies/${ticker}/findings`), readEnv(database));

test("findings answer from the authored set until a run publishes, and are preparing for other tickers", async () => {
  const database = await createAnalysisDatabase();
  const authored = await get(database, "ORCL");
  assert.equal(authored.status, 200);
  const body = await authored.json() as FindingsResponse;
  assert.equal(body.status, "ready");
  assert.equal(body.findings?.model, "authored");
  assert.equal(body.findings?.findings.length, 5);
  const none = await get(database, "MSFT");
  assert.deepEqual(await none.json(), { schemaVersion: "findings-response.v1", status: "preparing", findings: null });
  assert.equal(none.headers.get("cache-control"), "no-store");
});

test("a stored publication replaces the authored one, and an invalid stored one falls back rather than leaking", async () => {
  const database = await createAnalysisDatabase();
  const repository = new D1SecRepository(database as unknown as D1Database);
  await repository.setCache(findingsCacheKey("ORCL"), { ...ORCL_FINDINGS, model: "deepseek-chat", findings: ORCL_FINDINGS.findings.slice(0, 2) }, "2026-10-08T00:00:00.000Z");
  assert.equal(((await (await get(database, "ORCL")).json()) as FindingsResponse).findings?.model, "deepseek-chat");
  await repository.setCache(findingsCacheKey("ORCL"), { ...ORCL_FINDINGS, ticker: "MSFT", findings: [{ secret: "PRIVATE" }] }, "2026-10-08T00:00:00.000Z");
  const text = await (await get(database, "ORCL")).text();
  assert.ok(!text.includes("PRIVATE"));
  assert.equal((JSON.parse(text) as FindingsResponse).findings?.model, "authored");
});
