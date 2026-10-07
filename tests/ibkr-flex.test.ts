import assert from "node:assert/strict";
import test from "node:test";
import { createPortfolioDatabase } from "./helpers/portfolio-database.ts";
import { normalizeIbkrPosition } from "../lib/portfolio-snapshot.ts";

import { extractCapitalFlows, fetchFlexStatement, normalizeFlexStatement, parseCsv, parseFlexDateTime } from "../lib/ibkr-flex.ts";
import { publishFlexSnapshot, readPortfolioSnapshot, type PortfolioDatabase } from "../workers/sec-cron/portfolio-store.ts";
import { handleIbkrSyncRequest, runIbkrFlexSync, type IbkrSyncEnv } from "../workers/sec-cron/ibkr-sync.ts";

import { flexFixture as fixture } from "./helpers/ibkr-fixture.ts";

test("parses quoted commas without shifting Flex columns", () => {
  const rows = parseCsv('"DATA","POST","ACME, INC","10"\n');
  assert.deepEqual(rows[0], ["DATA", "POST", "ACME, INC", "10"]);
});

test("normalizes only summary positions and execution trades", () => {
  const input = normalizeFlexStatement(fixture, {
    generatedAt: "2027-01-01T14:00:00.000Z",
    queryPeriod: "DAYS_7",
    queryId: "1628251",
  });
  assert.equal(input.source.reportDate, "2026-12-31");
  assert.equal(input.summary.net_liquidation, 70_000.5);
  assert.equal(input.balances.balances[0].cash_balance, 12_000.25);
  assert.equal(input.positions.positions.length, 1);
  assert.equal(input.positions.positions[0].average_price, 15);
  assert.equal(input.positions.positions[0].symbol, "ACME");
  assert.equal(input.trades.trades.length, 1);
  assert.equal(input.trades.trades[0].trade_id, "trade-1");
  assert.equal(input.trades.trades[0].trade_date, "2026-12-31");
  assert.equal(input.trades.trades[0].trade_time, "2027-01-01T04:30:00.000Z");
});

test("requires a timezone-qualified Flex execution time", () => {
  assert.throws(() => parseFlexDateTime("20261231;233000"), /timezone-qualified/i);
});

for (const status of ["Fail", "Warn"]) {
  test(`polls the same generated report while IBKR returns ${status} 1019`, async () => {
    const calls: string[] = [];
    const delays: number[] = [];
    const responses = [
      '<FlexStatementResponse><Status>Success</Status><ReferenceCode>123456</ReferenceCode></FlexStatementResponse>',
      `<FlexStatementResponse><Status>${status}</Status><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress.</ErrorMessage></FlexStatementResponse>`,
      fixture,
    ];
    const result = await fetchFlexStatement({
      token: "1234567890",
      queryId: "1628251",
      periodDays: 7,
      retryDelaysMs: [0],
      sleep: async (ms) => { delays.push(ms); },
      fetcher: (async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        return new Response(responses.shift(), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(result, fixture);
    assert.match(calls[0], /SendRequest/);
    assert.match(calls[1], /GetStatement/);
    assert.equal(calls[1], calls[2]);
    assert.deepEqual(delays, [1000, 0]);
  });

}

test("warning errors stop at the retry limit and permanent errors never retry", async () => {
  for (const code of ["1019", "1015"]) {
    let gets = 0;
    await assert.rejects(fetchFlexStatement({
      token: "123", queryId: "123", periodDays: 7, retryDelaysMs: [0, 0],
      sleep: async () => undefined,
      fetcher: async (url) => {
        if (String(url).includes("SendRequest")) return new Response('<FlexStatementResponse><Status>Success</Status><ReferenceCode>456</ReferenceCode></FlexStatementResponse>');
        gets += 1;
        return new Response(`<FlexStatementResponse><Status>Warn</Status><ErrorCode>${code}</ErrorCode><ErrorMessage>Provider warning</ErrorMessage></FlexStatementResponse>`);
      },
    }), new RegExp(code));
    assert.equal(gets, code === "1019" ? 3 : 1);
  }
});

test("does not retry an invalid Flex token", async () => {
  await assert.rejects(fetchFlexStatement({
    token: "1234567890",
    queryId: "1628251",
    periodDays: 7,
    retryDelaysMs: [],
    fetcher: (async () => new Response(
      '<FlexStatementResponse><Status>Fail</Status><ErrorCode>1015</ErrorCode><ErrorMessage>Token is invalid.</ErrorMessage></FlexStatementResponse>',
      { status: 200 },
    )) as typeof fetch,
  }), /1015/);
});

test("publishes a validated Flex snapshot and history in one D1 batch", async () => {
  const batches: unknown[][] = [];
  const database: PortfolioDatabase = {
    prepare(query) {
      const statement = {
        query,
        values: [] as unknown[],
        bind(...values: unknown[]) { this.values = values; return this; },
        async first<T>() { return null as T | null; },
      };
      return statement;
    },
    async batch(statements) { batches.push(statements); return [{ meta: { changes: 1 } }]; },
  };
  const raw = normalizeFlexStatement(fixture, {
    generatedAt: "2027-01-01T14:00:00.000Z",
    queryPeriod: "DAYS_7",
    queryId: "1628251",
  });

  const result = await publishFlexSnapshot(database, raw);

  assert.equal(result.status, "published");
  assert.equal(result.snapshot.source?.method, "FLEX");
  assert.equal(result.snapshot.positions[0].symbol, "ACME");
  assert.equal(result.snapshot.trades.some((trade) => trade.tradeId === "trade-1"), true);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
  assert.equal(await readPortfolioSnapshot(database), null);
});

test("repairs symbols in a migrated legacy Flex snapshot without using demo account data", async () => {
  const { database, sqlite } = createPortfolioDatabase();
  try {
    const raw = normalizeFlexStatement(fixture, { generatedAt: "2027-01-01T00:00:00Z", queryPeriod: "DAYS_7", queryId: "1" });
    const { snapshot } = await publishFlexSnapshot(database, raw);
    snapshot.positions[0] = { ...snapshot.positions[0], positionKey: "STK:272093", symbol: "MICROSOFT", contractDescription: "MICROSOFT CORP" };
    sqlite.prepare("UPDATE portfolio_state SET payload = ?").run(JSON.stringify(snapshot));
    const repaired = await readPortfolioSnapshot(database);
    assert.equal(repaired?.positions[0].symbol, "MSFT");
  } finally { sqlite.close(); }
});

test("extracts and reconciles capital flows, rejecting incomplete cash data", () => {
  const report = extractCapitalFlows(fixture);
  assert.equal(report.flows[0].amount, 1000);
  assert.equal(report.fromDate, "2026-01-01");
  assert.throws(() => extractCapitalFlows(fixture.replace('"1000","deposit1"', '"900","deposit1"')), /reconcile/);
});

test("Flex sync owns persistence and only contacts IBKR", async () => {
  const { database, sqlite } = createPortfolioDatabase();
  const calls: Request[] = [];
  try {
    const responses = [new Response('<FlexStatementResponse><Status>Success</Status><ReferenceCode>123456</ReferenceCode></FlexStatementResponse>'), new Response(fixture)];
    const env = { DB: database, IBKR_FLEX_TOKEN: "1234567890", IBKR_FLEX_QUERY_ID: "1628251", PORTFOLIO_SYNC_KEY: "write", PORTFOLIO_READ_TOKEN: "read" } satisfies IbkrSyncEnv;
    const result = await runIbkrFlexSync(env, async (input, init) => {
      const request = new Request(input, init);
      assert.equal(new URL(request.url).hostname, "ndcdyn.interactivebrokers.com");
      calls.push(request);
      return responses.shift()!;
    }, () => new Date("2027-01-01T06:05:00.000Z"));
    assert.equal(result.status, "published");
    assert.equal(calls.length, 2);
    assert.equal((await readPortfolioSnapshot(database))?.trades.length, 1);
    assert.equal((await readPortfolioSnapshot(database))?.account.netDeposits, 1000);
  } finally { sqlite.close(); }
});

test("manual portfolio trigger requires POST and a matching secret before fetching IBKR", async () => {
  const env = { PORTFOLIO_SYNC_KEY: "test-key" } as IbkrSyncEnv;
  let calls = 0;
  const sync = async () => {
    calls++;
    return { status: "unchanged" as const, reportDate: "2026-09-04", positions: 1, trades: 1 };
  };
  const url = "https://worker.example/internal/portfolio/sync";
  assert.equal((await handleIbkrSyncRequest(new Request(url), env, sync)).status, 405);
  assert.equal((await handleIbkrSyncRequest(new Request(url, { method: "POST" }), env, sync)).status, 401);
  assert.equal((await handleIbkrSyncRequest(new Request(url, { method: "POST", headers: { "x-portfolio-sync-key": "wrong" } }), env, sync)).status, 401);
  assert.equal(calls, 0);
  const authorized = new Request(url, { method: "POST", headers: { "x-portfolio-sync-key": "test-key" } });
  const response = await handleIbkrSyncRequest(authorized, env, sync);
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { status: string }).status, "unchanged");
  assert.equal(calls, 1);
  const failure = await handleIbkrSyncRequest(authorized, env, async () => { throw new Error("private-provider-detail"); });
  assert.equal(failure.status, 502);
  assert.doesNotMatch(await failure.text(), /private-provider-detail/);
});

test("backfills same-date net deposits atomically, then refreshes time for identical reports", async () => {
  const { database, sqlite } = createPortfolioDatabase();
  try {
    const raw = normalizeFlexStatement(fixture, { generatedAt: "2027-01-01T06:00:00.000Z", queryPeriod: "DAYS_7", queryId: "1628251" });
    await publishFlexSnapshot(database, raw);
    raw.capitalFlows = extractCapitalFlows(fixture);
    const result = await publishFlexSnapshot(database, raw);
    assert.equal(result.status, "published");
    assert.equal(result.snapshot.account.netDeposits, 1000);
    const later = { ...raw, generatedAt: "2027-01-01T07:00:00.000Z" };
    assert.equal((await publishFlexSnapshot(database, later)).status, "unchanged");
    assert.equal(sqlite.prepare("SELECT synced_at FROM portfolio_state").get()?.synced_at, later.generatedAt);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM portfolio_history").get()?.n, 1);
  } finally { sqlite.close(); }
});

test("retains actual option multipliers and reported cost through normalization", () => {
  for (const multiplier of [10, 100, 150]) {
    const csv = fixture.replace(
      '"STK","ACME","ACME, INC","123","","1","20261231","10","20","200","15","150","50","SUMMARY"',
      `"OPT","ACME","ACME CALL","123","ACME","${multiplier}","20261231","1","20","200","15","150","50","SUMMARY"`,
    );
    const raw = normalizeFlexStatement(csv, { generatedAt: "2027-01-01T00:00:00Z", queryPeriod: "DAYS_7", queryId: "1" });
    const position = normalizeIbkrPosition(raw.positions.positions[0]);
    assert.equal(position.multiplier, multiplier);
    assert.equal(position.costBasis, 150);
    assert.equal(position.currency, "USD");
  }
});

test("publishes a reconciled cash-only account but rejects missing or inconsistent position data", async () => {
  const { database, sqlite } = createPortfolioDatabase();
  try {
    const options = { generatedAt: "2027-01-01T00:00:00Z", queryPeriod: "DAYS_7" as const, queryId: "1" };
    await publishFlexSnapshot(database, normalizeFlexStatement(fixture, options));
    const empty = fixture.split("\n").filter(line => !line.startsWith('"DATA","POST"')).join("\n");
    assert.throws(() => normalizeFlexStatement(empty, options), /reconcile/);
    const reconciled = empty.replace('"70000.50"', '"12000.25"');
    assert.throws(() => normalizeFlexStatement(reconciled.split("\n").filter(line => !line.startsWith('"HEADER","POST"')).join("\n"), options), /missing the positions/);
    const result = await publishFlexSnapshot(database, normalizeFlexStatement(reconciled, { ...options, generatedAt: "2027-01-01T01:00:00Z" }));
    assert.equal(result.snapshot.positions.length, 0);
    assert.equal(result.snapshot.account.netLiquidation, 12000.25);
    assert.ok(result.snapshot.trades.some(trade => trade.tradeId === "trade-1"));
    assert.equal((await readPortfolioSnapshot(database))!.positions.length, 0);
  } finally { sqlite.close(); }
});

test("same-date corrections publish while identical later fetches and older corrections do not", async () => {
  const { database, sqlite } = createPortfolioDatabase();
  try {
    const raw = normalizeFlexStatement(fixture, { generatedAt: "2027-01-01T00:00:00Z", queryPeriod: "DAYS_7", queryId: "1" });
    raw.capitalFlows = extractCapitalFlows(fixture);
    await publishFlexSnapshot(database, raw);
    const correction = structuredClone(raw);
    correction.generatedAt = "2027-01-01T01:00:00Z";
    correction.summary.net_liquidation = 71000;
    correction.trades.trades[0].realized_pnl = 9;
    assert.equal((await publishFlexSnapshot(database, correction)).status, "published");
    assert.equal((await publishFlexSnapshot(database, { ...correction, generatedAt: "2027-01-02T01:00:00Z" })).status, "unchanged");
    assert.equal((await publishFlexSnapshot(database, raw)).status, "unchanged");
    assert.equal((await readPortfolioSnapshot(database))!.account.netLiquidation, 71000);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM portfolio_history").get()?.n, 1);
    assert.equal(sqlite.prepare("SELECT net_liquidation AS nav FROM portfolio_history").get()?.nav, "71000");
  } finally { sqlite.close(); }
});

test("a concurrent older report cannot overwrite the latest snapshot or its history", async () => {
  const { database, sqlite } = createPortfolioDatabase();
  try {
    const older = normalizeFlexStatement(fixture, { generatedAt: "2027-01-01T00:00:00Z", queryPeriod: "DAYS_7", queryId: "1" });
    const newer = structuredClone(older);
    newer.source.reportDate = "2027-01-01";
    newer.generatedAt = "2027-01-02T00:00:00Z";
    newer.summary.net_liquidation = 72000;
    let interleave = true;
    const racing: PortfolioDatabase = {
      prepare: database.prepare,
      async batch(statements) {
        if (interleave) { interleave = false; await publishFlexSnapshot(database, newer); }
        return database.batch(statements);
      },
    };
    assert.equal((await publishFlexSnapshot(racing, older)).status, "unchanged");
    assert.equal((await readPortfolioSnapshot(database))!.source?.reportDate, "2027-01-01");
    assert.deepEqual(sqlite.prepare("SELECT date, net_liquidation FROM portfolio_history").all().map(row => ({ ...row })), [
      { date: "2027-01-02", net_liquidation: "72000" },
    ]);
  } finally { sqlite.close(); }
});

test("a losing newer writer rereads and retains the concurrent writer's trade history", async () => {
  const { database, sqlite } = createPortfolioDatabase();
  try {
    const older = normalizeFlexStatement(fixture, { generatedAt: "2027-01-01T00:00:00Z", queryPeriod: "DAYS_7", queryId: "1" });
    const newer = structuredClone(older);
    newer.generatedAt = "2027-01-01T01:00:00Z";
    newer.trades.trades[0].trade_id = "trade-newer";
    let interleave = true;
    const racing: PortfolioDatabase = {
      prepare: database.prepare,
      async batch(statements) {
        if (interleave) { interleave = false; await publishFlexSnapshot(database, older); }
        return database.batch(statements);
      },
    };
    assert.equal((await publishFlexSnapshot(racing, newer)).status, "published");
    const snapshot = (await readPortfolioSnapshot(database))!;
    assert.ok(snapshot.trades.some(trade => trade.tradeId === "trade-1"));
    assert.ok(snapshot.trades.some(trade => trade.tradeId === "trade-newer"));
  } finally { sqlite.close(); }
});
