import assert from "node:assert/strict";
import test from "node:test";

import { buildPortfolioViewModel } from "../lib/portfolio-view-model.ts";
import type { PortfolioSnapshotV1 } from "../lib/portfolio-snapshot.ts";

const snapshot: PortfolioSnapshotV1 = {
  schemaVersion: 1,
  generatedAt: "2026-07-22T00:00:00.000Z",
  account: { currency: "USD", netLiquidation: 10_000, cashBalance: 1_000, netDeposits: 9_000 },
  positions: [
    {
      positionKey: "STK:1", symbol: "AAPL", contractDescription: "Apple Inc.", assetClass: "STK",
      quantity: 10, averagePrice: 180, marketPrice: 200, marketValue: 2_000, costBasis: 1_800, unrealizedPnl: 200,
    },
    {
      positionKey: "OPT:2", symbol: "AAPL", contractDescription: "AAPL 20260821 220 C", assetClass: "OPT",
      quantity: -1, averagePrice: 4, marketPrice: 3, marketValue: -300, costBasis: -400, unrealizedPnl: 100,
    },
  ],
  trades: [
    {
      tradeId: "t1", tradeTime: "2026-06-01T00:00:00.000Z", symbol: "AAPL", contractDescription: "Apple Inc.",
      securityType: "STK", side: "SELL", size: 1, price: 190, commission: 0, netAmount: 190,
      realizedPnl: 25, exchange: "NASDAQ", orderId: "1",
    },
    {
      tradeId: "t2", tradeTime: "2025-03-01T00:00:00.000Z", tradeDate: "2025-03-01", symbol: "MSFT", contractDescription: "Microsoft Corp.",
      securityType: "STK", side: "BUY", size: 2, price: 350, commission: -0.5, netAmount: -700.5,
      realizedPnl: 0, exchange: "NASDAQ", orderId: "2",
    },
    {
      tradeId: "t3", tradeTime: "2025-04-01T00:00:00.000Z", tradeDate: "2025-04-01", symbol: "MSFT", contractDescription: "Microsoft Corp.",
      securityType: "STK", side: "SELL", size: -2, price: 380, commission: -0.5, netAmount: 759.5,
      realizedPnl: 59, exchange: "NASDAQ", orderId: "3",
    },
    {
      tradeId: "t4", tradeTime: "2025-04-15T00:00:00.000Z", tradeDate: "2025-04-15", symbol: "MSFT", contractDescription: "MSFT MAY 400 C",
      securityType: "OPT", side: "SELL", size: -1, price: 2, commission: -0.65, netAmount: 199.35,
      realizedPnl: 20, exchange: "SMART", orderId: "4",
    },
  ],
  tradeSync: { status: "current", queryPeriod: "YEAR_TO_DATE", lastSuccessfulTradeAt: null, message: null },
};

test("groups stock and option legs into one ticker view model", () => {
  const model = buildPortfolioViewModel(snapshot);

  assert.equal(model.positionGroups.length, 1);
  assert.equal(model.positionGroups[0].symbol, "AAPL");
  assert.equal(model.positionGroups[0].value, 1_700);
  assert.equal(model.positionGroups[0].unrealized, 300);
  assert.equal(model.positionGroups[0].realized, 25);
  assert.equal(model.positionGroups[0].stock?.actualCost, 177.5);
  assert.equal(model.stockMarketValue, 2_000);
  assert.equal(model.optionMarketValue, -300);
  assert.deepEqual(model.historicalPositionGroups, [{
    symbol: "MSFT",
    name: "Microsoft Corp.",
    firstTradeDate: "2025-03-01",
    lastTradeDate: "2025-04-15",
    stockTrades: 2,
    optionTrades: 1,
    realized: 79,
  }]);
});

test("uses the Flex report year and trade date around New Year", () => {
  const model = buildPortfolioViewModel({
    ...snapshot,
    generatedAt: "2027-01-01T04:30:00.000Z",
    source: { provider: "IBKR", method: "FLEX", reportDate: "2026-12-31", queryId: "1628251" },
    trades: [{ ...snapshot.trades[0], tradeDate: "2026-12-31", tradeTime: "2027-01-01T04:30:00.000Z" }],
  });

  assert.equal(model.positionGroups[0].realized, 25);
  const apiModel = buildPortfolioViewModel({
    ...snapshot, source: undefined, generatedAt: "2027-01-01T06:00:00.000Z",
    trades: [{ ...snapshot.trades[0], tradeDate: "2026-12-31", tradeTime: "2027-01-01T04:30:00.000Z" }],
  }, "2026-12-31");
  assert.equal(apiModel.positionGroups[0].realized, 25);
});
