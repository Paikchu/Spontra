import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchMarketObservation, priceSignal, type MarketObservation } from "../../workers/pipeline/src/research/market.ts";
const now = "2026-09-25T15:00:00.000Z";
const quote: MarketObservation = { ticker: "ORCL", price: 95, previousClose: 100, changePercent: -5, sourceAt: now, fetchedAt: now, sourceUrl: "https://example.com", session: "regular", stale: false };
test("stale, repeated and closed-session prices cannot become fresh anomaly alerts", () => {
  assert.ok(priceSignal(quote, null));
  assert.equal(priceSignal({ ...quote, stale: true }, null), null);
  assert.equal(priceSignal({ ...quote, session: "outside_regular" }, null), null);
  assert.equal(priceSignal(quote, quote), null);
  assert.equal(priceSignal({ ...quote, sourceAt: "2026-09-25T14:00:00.000Z" }, quote), null);
});
test("day move buckets deduplicate noise; meaningful escalation gets a new bucket", () => {
  assert.equal(priceSignal(quote, null)?.bucket, priceSignal({ ...quote, changePercent: -5.4 }, null)?.bucket);
  assert.notEqual(priceSignal(quote, null)?.bucket, priceSignal({ ...quote, changePercent: -6.1 }, null)?.bucket);
});
test("market source time, not retrieval time, determines quote freshness", async () => {
  const timestamp = Date.parse(now) / 1000;
  const fetcher = (async () => Response.json({ chart: { result: [{ meta: { symbol: "ORCL", regularMarketPrice: 95, chartPreviousClose: 100,
    regularMarketTime: timestamp - 3600, currentTradingPeriod: { regular: { start: timestamp - 7200, end: timestamp + 7200 } } } }] } })) as typeof fetch;
  const result = await fetchMarketObservation("ORCL", now, fetcher);
  assert.equal(result.stale, true); assert.equal(result.fetchedAt, now);
  assert.notEqual(result.sourceAt, now); assert.equal(priceSignal(result, null), null);
});
