import assert from "node:assert/strict";
import test from "node:test";
import { buildMobilePortfolio } from "../lib/mobile-portfolio.ts";
import { buildPortfolioViewModel } from "../lib/portfolio-view-model.ts";
import { buildAllocation, buildSectorAllocation } from "../lib/portfolio-dashboard.ts";
import type { PortfolioSnapshotV1 } from "../lib/portfolio-snapshot.ts";
const snapshot: PortfolioSnapshotV1 = {
  schemaVersion: 1, generatedAt: "2026-09-12T00:00:00Z",
  account: {currency:"USD",netLiquidation:1000,cashBalance:200,netDeposits:800},
  positions: [
    {positionKey:"STK:private-id",symbol:"AAPL",contractDescription:"Apple",assetClass:"STK",quantity:5,averagePrice:150,marketPrice:200,marketValue:1000,costBasis:750,unrealizedPnl:250},
    {positionKey:"OPT:private-id",symbol:"AAPL",contractDescription:"AAPL Call",assetClass:"OPT",quantity:-1,averagePrice:3,marketPrice:2,marketValue:-200,costBasis:-300,unrealizedPnl:100},
  ],
  trades:[{tradeId:"t1",tradeTime:"2026-09-01T00:00:00Z",symbol:"AAPL",contractDescription:"Apple",securityType:"STK",side:"SELL",size:-1,price:190,commission:-1,netAmount:189,realizedPnl:39,exchange:"private",orderId:"private-order"}],
  tradeSync:{status:"current",queryPeriod:"YEAR_TO_DATE",lastSuccessfulTradeAt:null,message:null},
  source:{provider:"IBKR",method:"FLEX",queryId:"private-query"},
};
test("mobile portfolio uses the Web projection, allocation and accounting", () => {
  const result=buildMobilePortfolio(snapshot,"live"), view=buildPortfolioViewModel(snapshot);
  assert.deepEqual(result.positionGroups, view.positionGroups);
  assert.deepEqual(result.historicalPositionGroups, view.historicalPositionGroups);
  assert.deepEqual(result.allocation, buildAllocation(view.positionGroups));
  assert.deepEqual(result.sectorAllocation, buildSectorAllocation(view.positionGroups));
  assert.equal(result.netPositionsValue,800);
  assert.equal(result.account.netLiquidationWithoutOptionPnl,900);
  assert.equal(result.account.portfolioLeverage,1.2);
  assert.equal(result.account.totalPnl,200);
  assert.equal(result.account.totalPnlRate,25);
  assert.equal(result.heatmapHoldings.length,1);
});
test("fallback retains the original snapshot timestamp and identifies its source",()=>{
  const result=buildMobilePortfolio(snapshot,"fallback");
  assert.equal(result.generatedAt,snapshot.generatedAt);
  assert.equal(result.dataSource,"fallback");
});
test("mobile contract does not expose broker query, position or order identifiers",()=>{
  const json=JSON.stringify(buildMobilePortfolio(snapshot,"live"));
  assert.ok(!json.includes("private-"));
  assert.ok(!json.includes('"orderId"'));
});
test("zero account balance and deposits have finite summary metrics",()=>{
  const result=buildMobilePortfolio({...snapshot,positions:[],account:{...snapshot.account,netLiquidation:0,netDeposits:0}},"live");
  assert.equal(result.account.portfolioLeverage,0);
  assert.equal(result.account.totalPnlRate,0);
});
test("API report date keeps year-end realized gains after a January sync", () => {
  const result = buildMobilePortfolio({ ...snapshot, source: undefined, generatedAt: "2027-01-01T06:00:00Z" }, "live", "2026-12-31");
  assert.equal(result.positionGroups[0].realized, 39);
});
