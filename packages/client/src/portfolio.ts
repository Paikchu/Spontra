import type { PortfolioSyncMetadata } from "@/shared/portfolio-contract";
import { buildPortfolioViewModel } from "@/lib/portfolio-view-model";
import { buildHeatmapHoldings } from "@/lib/portfolio-heatmap";
import type { PortfolioSnapshotV1 } from "@/lib/portfolio-snapshot";
import type { CalendarState } from "@/lib/earnings-live";
/** Identical calculations for server-rendered Web and the desktop API. */
export function buildPortfolioPresentation(snapshot: PortfolioSnapshotV1, earnings: CalendarState, portfolioSync?: PortfolioSyncMetadata) {
  const portfolio = buildPortfolioViewModel(snapshot);
  const { netLiquidation, netDeposits, cashBalance } = snapshot.account;
  const optionPnl = snapshot.positions.filter(p => p.assetClass === "OPT").reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const grossValue = snapshot.positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
  return {
    portfolioSync,
    heatmapHoldings: buildHeatmapHoldings(snapshot),
    positionGroups: portfolio.positionGroups,
    historicalPositionGroups: portfolio.historicalPositionGroups,
    stockMarketValue: portfolio.stockMarketValue, optionMarketValue: portfolio.optionMarketValue,
    netPositionsValue: portfolio.netPositionsValue,
    earningsEvents: earnings.events, earningsCalendar: earnings,
    netLiquidation, netDeposits, cashBalance,
    netLiquidationWithoutOptionPnl: netLiquidation - optionPnl,
    portfolioLeverage: netLiquidation === 0 ? 0 : grossValue / netLiquidation,
  };
}
