import test from "node:test";
import assert from "node:assert/strict";
import { createPortfolioDatabase } from "./helpers/portfolio-database.ts";
import { flexFixture } from "./helpers/ibkr-fixture.ts";
import { normalizeFlexStatement, extractCapitalFlows } from "../lib/ibkr-flex.ts";
import { publishFlexSnapshot, readPortfolioResponse, recordSyncFailure } from "../workers/sec-cron/portfolio-store.ts";
import { handlePortfolioRead } from "../workers/sec-cron/portfolio-api.ts";
import { runIbkrFlexSync, handleIbkrSyncRequest, type IbkrSyncEnv } from "../workers/sec-cron/ibkr-sync.ts";
import { fetchPortfolio, loadPortfolio, PortfolioUnavailableError } from "../lib/portfolio-client.ts";
import { portfolioSyncOverdue } from "../shared/portfolio-contract.ts";

const start = "2027-01-01T06:01:00.000Z";
function raw(at = start) {
  return { ...normalizeFlexStatement(flexFixture, { generatedAt: at, queryPeriod: "DAYS_7", queryId: "private-query" }), capitalFlows: extractCapitalFlows(flexFixture) };
}
function env(DB: IbkrSyncEnv["DB"]): IbkrSyncEnv {
  return { DB, PORTFOLIO_READ_TOKEN: "read-only-key", PORTFOLIO_SYNC_KEY: "sync-only-key", IBKR_FLEX_TOKEN: "123456", IBKR_FLEX_QUERY_ID: "1628251" };
}
function request(token = "read-only-key", method = "GET") {
  return new Request("https://portfolio.test/api/v1/portfolio", { method, headers: { authorization: `Bearer ${token}` } });
}

test("read API authenticates separately, handles initialization, and never includes private storage fields", async () => {
  const { database, sqlite } = createPortfolioDatabase();
  try {
    const config = env(database);
    assert.equal((await handlePortfolioRead(request("wrong"), config)).status, 401);
    assert.equal((await handlePortfolioRead(request("sync-only-key"), config)).status, 401);
    assert.equal((await handlePortfolioRead(request("read-only-key", "POST"), config)).status, 405);
    assert.equal((await handleIbkrSyncRequest(new Request("https://portfolio.test/internal/portfolio/sync", {
      method: "POST", headers: { "x-portfolio-sync-key": "read-only-key" },
    }), config)).status, 401);
    assert.equal((await handleIbkrSyncRequest(new Request("https://portfolio.test/internal/portfolio/sync", {
      method: "POST", headers: { "x-portfolio-sync-key": "read-only-key" },
    }), { ...config, PORTFOLIO_SYNC_KEY: config.PORTFOLIO_READ_TOKEN })).status, 401);
    const empty = await handlePortfolioRead(request(), config);
    assert.equal(empty.status, 200);
    assert.equal((await empty.json() as { syncStatus: string }).syncStatus, "uninitialized");
    await recordSyncFailure(database, "2027-01-01T06:00:00.000Z");
    assert.equal((await readPortfolioResponse(database)).syncStatus, "uninitialized");
    await publishFlexSnapshot(database, raw());
    for (let i = 0; i < 3; i++) {
      const response = await handlePortfolioRead(request(), config, new Date(start));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const text = await response.text();
      assert.doesNotMatch(text, /capitalFlows|ACCOUNT|private-query|queryId/);
      const body = JSON.parse(text);
      assert.equal(body.portfolio.positions.length, 1);
      assert.equal(body.portfolio.trades.length, 1);
      assert.equal(body.portfolio.account.netDeposits, 1000);
      assert.equal(body.reportDate, "2026-12-31");
      assert.equal(body.syncStatus, "current");
    }
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM portfolio_history").get()?.n, 1);
  } finally { sqlite.close(); }
});

test("an in-flight/failed sync keeps reads available; unchanged recovery advances only the successful sync time", async () => {
  const { database, sqlite } = createPortfolioDatabase();
  try {
    await publishFlexSnapshot(database, raw());
    const config = env(database);
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const job = runIbkrFlexSync(config, () => pending, () => new Date("2027-01-01T06:10:00Z"));
    const failed = assert.rejects(job, /SendRequest/);
    assert.equal((await handlePortfolioRead(request(), config, new Date(start))).status, 200);
    finish(new Response("upstream down", { status: 503 }));
    await failed;
    const delayed = await readPortfolioResponse(database, new Date(start));
    assert.equal(delayed.syncStatus, "delayed");
    assert.equal(delayed.syncedAt, start);
    const later = "2027-01-01T06:20:00.000Z";
    assert.equal((await publishFlexSnapshot(database, raw(later))).status, "unchanged");
    const recovered = await readPortfolioResponse(database, new Date(later));
    assert.equal(recovered.syncStatus, "current");
    assert.equal(recovered.syncedAt, later);
    assert.equal(recovered.portfolio?.generatedAt, start);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM portfolio_history").get()?.n, 1);
    await recordSyncFailure(database, "2027-01-01T06:15:00.000Z");
    assert.equal((await readPortfolioResponse(database, new Date(later))).syncStatus, "current");
    const oldCorrection = raw("2027-01-01T06:12:00.000Z");
    oldCorrection.summary.net_liquidation = 1;
    await publishFlexSnapshot(database, oldCorrection);
    assert.equal((await readPortfolioResponse(database, new Date(later))).portfolio?.account.netLiquidation, 70000.5);
    await assert.rejects(runIbkrFlexSync(config, async () => { throw new DOMException("Timed out", "TimeoutError"); }, () => new Date("2027-01-01T06:25:00Z")), /Timed out/);
    const timeout = await handlePortfolioRead(request(), config, new Date(later));
    assert.equal(timeout.status, 200);
    const timeoutBody = await timeout.json() as { syncStatus: string; syncedAt: string };
    assert.equal(timeoutBody.syncStatus, "delayed");
    assert.equal(timeoutBody.syncedAt, later);
  } finally { sqlite.close(); }
});

test("delay follows Tuesday–Saturday UTC schedule with 30 minutes grace, including weekends and year boundaries", () => {
  const saturday = "2026-10-03T06:01:00Z";
  for (const now of ["2026-10-04T12:00:00Z", "2026-10-05T23:00:00Z", "2026-10-06T06:29:59Z"]) {
    assert.equal(portfolioSyncOverdue(saturday, new Date(now)), false, now);
  }
  assert.equal(portfolioSyncOverdue(saturday, new Date("2026-10-06T06:30:00Z")), true);
  assert.equal(portfolioSyncOverdue("2026-12-31T06:01:00Z", new Date("2027-01-01T06:31:00Z")), true);
  assert.equal(portfolioSyncOverdue("2027-01-01T06:10:00Z", new Date("2027-01-01T06:31:00Z")), false);
});

test("app reads use the service API; initialization and transport errors never fall back to private JSON", async () => {
  let calls = 0;
  const config = { PORTFOLIO_READ_TOKEN: "read", PORTFOLIO_DATA_SERVICE: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    const req = new Request(input, init);
    assert.equal(new URL(req.url).pathname, "/api/v1/portfolio");
    assert.equal(req.headers.get("authorization"), "Bearer read");
    assert.equal(req.redirect, "manual");
    return Response.json({ portfolio: null, syncedAt: null, reportDate: null, syncStatus: "uninitialized" });
  } } };
  await assert.rejects(loadPortfolio(config), (error: unknown) => error instanceof PortfolioUnavailableError && error.reason === "uninitialized");
  assert.equal(calls, 1);
  await assert.rejects(fetchPortfolio({ ...config, PORTFOLIO_DATA_SERVICE: { fetch: async () => new Response(null, { status: 503 }) } }), PortfolioUnavailableError);
  await assert.rejects(fetchPortfolio({ ...config, PORTFOLIO_DATA_SERVICE: { fetch: async () => { throw new TypeError("network offline"); } } }), PortfolioUnavailableError);
});
