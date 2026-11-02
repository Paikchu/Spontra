import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPrimaryTicker } from "../worker/index.ts";

const answer = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;

test("a share class reads as the class its data is kept under, and only an answer for the asked ticker counts", async () => {
  assert.deepEqual(await loadPrimaryTicker("EXB", answer({ schemaVersion: "ticker.v1", requested: "EXB", ticker: "EXA", listed: true })), { ticker: "EXA", listed: true });
  assert.deepEqual(await loadPrimaryTicker("EXA", answer({ schemaVersion: "ticker.v1", requested: "EXA", ticker: "EXA" })), { ticker: "EXA", listed: false });
  assert.equal(await loadPrimaryTicker("EXB", answer({ schemaVersion: "ticker.v1", requested: "OTHER", ticker: "EXA" })), null);
  assert.equal(await loadPrimaryTicker("EXB", answer({ schemaVersion: "ticker.v1", requested: "EXB", ticker: "not a ticker" })), null);
  assert.equal(await loadPrimaryTicker("EXB", answer({ error: "unavailable" }, 503)), null);
  assert.equal(await loadPrimaryTicker("EXB", (async () => { throw new Error("down"); }) as unknown as typeof fetch), null);
});
