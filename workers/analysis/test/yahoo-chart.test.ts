import assert from "node:assert/strict";
import test from "node:test";
import { readYahooChart, yahooChartUrl } from "../src/market/yahoo.ts";

test("a current-day daily bar becomes a reference close only after its declared exchange session ends", async () => {
  const end = Date.parse("2026-11-02T21:00:00Z") / 1000;
  const body = (regularEnd: number | null) => ({ chart: { result: [{
    meta: { symbol: "ACME", currency: "USD", exchangeTimezoneName: "America/New_York", currentTradingPeriod: { regular: { end: regularEnd } } },
    timestamp: [Date.parse("2026-10-30T13:30:00Z") / 1000, Date.parse("2026-11-02T14:30:00Z") / 1000],
    indicators: { quote: [{ close: [100, 110] }] },
  }] } });
  const chart = (at: string, regularEnd: number | null = end, interval = "1d") => readYahooChart(
    yahooChartUrl("ACME", { range: "1mo", interval }), async () => Response.json(body(regularEnd)), new Date(at));
  assert.equal((await chart("2026-11-02T20:59:59Z"))?.points.at(-1)?.date, "2026-10-30");
  assert.deepEqual((await chart("2026-11-03T01:00:00Z"))?.points.at(-1), { date: "2026-11-02", close: 110 });
  assert.equal((await chart("2026-11-03T01:00:00Z", null))?.points.at(-1)?.date, "2026-10-30");
  assert.equal((await chart("2026-11-03T01:00:00Z", end - 3 * 86_400))?.points.at(-1)?.date, "2026-10-30");
  assert.equal((await chart("2026-11-03T01:00:00Z", end, "1wk"))?.points.at(-1)?.date, "2026-10-30");
});
