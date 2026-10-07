import { buildAllocation, buildSectorAllocation } from "./portfolio-dashboard.ts";
import { buildHeatmapHoldings } from "./portfolio-heatmap.ts";
import { buildPortfolioViewModel } from "./portfolio-view-model.ts";
import { canonicalUnderlying, type PortfolioSnapshotV1 } from "./portfolio-snapshot.ts";

/** The same accounting projection used by the Web homepage; no broker credentials or IDs. */
export function buildMobilePortfolio(snapshot: PortfolioSnapshotV1, dataSource: "live" | "fallback", reportDate?: string | null) {
  const view = buildPortfolioViewModel(snapshot, reportDate);
  const optionPnl = snapshot.positions.filter(p => p.assetClass === "OPT").reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const gross = snapshot.positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
  return {
    schemaVersion: "mobile-portfolio.v1", generatedAt: snapshot.generatedAt, dataSource,
    account: { ...snapshot.account, netLiquidationWithoutOptionPnl: snapshot.account.netLiquidation - optionPnl,
      portfolioLeverage: snapshot.account.netLiquidation === 0 ? 0 : gross / snapshot.account.netLiquidation,
      totalPnl: snapshot.account.netLiquidation - snapshot.account.netDeposits,
      totalPnlRate: snapshot.account.netDeposits === 0 ? 0 : (snapshot.account.netLiquidation - snapshot.account.netDeposits) / snapshot.account.netDeposits * 100 },
    positionGroups: view.positionGroups, historicalPositionGroups: view.historicalPositionGroups,
    stockMarketValue: view.stockMarketValue, optionMarketValue: view.optionMarketValue, netPositionsValue: view.netPositionsValue,
    allocation: buildAllocation(view.positionGroups), sectorAllocation: buildSectorAllocation(view.positionGroups),
    heatmapHoldings: buildHeatmapHoldings(snapshot),
    tradeSync: snapshot.tradeSync,
    trades: snapshot.trades.map(({ tradeId, tradeTime, tradeDate, symbol, contractDescription, securityType, side, size, price, commission, netAmount, realizedPnl }) =>
      ({ tradeId, tradeTime, tradeDate, symbol: canonicalUnderlying(symbol), contractDescription, securityType, side, size, price, commission, netAmount, realizedPnl })),
  };
}
