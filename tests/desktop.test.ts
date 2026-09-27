import test from "node:test";
import assert from "node:assert/strict";
import { handleDesktopRequest } from "../lib/desktop-auth";
import { buildPortfolioPresentation } from "../packages/client/src/portfolio";
import { emptyCalendar } from "../lib/earnings-live";
import type { PortfolioSnapshotV1 } from "../lib/portfolio-snapshot";
const token = "desktop-unit-test-credential-000000000";
const request = (supplied?: string, method = "GET") => new Request("https://example.test/api/desktop/v1/plans/AAPL", { method, headers: supplied ? { authorization: `Bearer ${supplied}` } : {} });

test("desktop authentication denies missing/incorrect credentials before any data access", async () => {
  let called = 0;
  const dispatch = async () => { called++; return Response.json({ ok: true }); };
  for (const supplied of [undefined, "bad", token + "x", "x".repeat(token.length)]) {
    const response = await handleDesktopRequest(request(supplied), token, dispatch);
    assert.equal(response.status, 401); assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(called, 0);
  assert.equal((await handleDesktopRequest(request(token), undefined, dispatch)).status, 503);
  assert.equal(called, 0);
});
test("desktop auth gates both reads and writes and strips public caching", async () => {
  for (const method of ["GET", "PUT"]) {
    let calls = 0;
    const response = await handleDesktopRequest(request(token, method), token, async () => {
      calls++; return Response.json({ plan: { ticker: "AAPL" } }, { headers: { "cache-control": "public, max-age=30", "access-control-allow-origin": "*" } });
    });
    assert.equal(calls, 1); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { plan: { ticker: "AAPL" } });
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});
test("desktop preserves meaningful errors and contains backend failures", async () => {
  for (const status of [400, 404, 429, 503]) {
    const response = await handleDesktopRequest(request(token), token, async () => Response.json({ error: "unavailable" }, { status }));
    assert.equal(response.status, status);
  }
  const response = await handleDesktopRequest(request(token), token, async () => { throw new Error("secret backend exception"); });
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /secret/);
});
test("portfolio presentation preserves stock/option values and zero-NAV leverage", () => {
  const snapshot = { generatedAt: "2026-09-28T00:00:00Z", account: { netLiquidation: 1000, netDeposits: 800, cashBalance: 400 }, positions: [
    { symbol: "AAPL", assetClass: "STK", name: "Apple", quantity: 3, marketValue: 500, unrealizedPnl: 100, averageCost: 100 },
    { symbol: "AAPL  270115C00200000", assetClass: "OPT", name: "Apple option", quantity: 1, marketValue: 100, unrealizedPnl: 30, averageCost: 70 },
  ], trades: [] } as unknown as PortfolioSnapshotV1;
  const result = buildPortfolioPresentation(snapshot, emptyCalendar());
  assert.equal(result.netLiquidationWithoutOptionPnl, 970);
  assert.equal(result.netPositionsValue, 600);
  assert.equal(result.portfolioLeverage, 0.6);
  assert.equal(buildPortfolioPresentation({ ...snapshot, account: { ...snapshot.account, netLiquidation: 0 } }, emptyCalendar()).portfolioLeverage, 0);
});
