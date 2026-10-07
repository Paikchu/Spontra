import { loadPortfolio } from "@/lib/portfolio-client";

import { findSecurity } from "@/lib/site-data";
import { buildPortfolioViewModel } from "@/lib/portfolio-view-model";
import { canonicalUnderlying } from "@/lib/portfolio-snapshot";
import { normalizeTicker } from "@/lib/symbol-directory";

export async function loadStock(rawTicker: string) {
  const ticker = normalizeTicker(rawTicker);
  const { snapshot, sync } = await loadPortfolio();
  const view = buildPortfolioViewModel(snapshot);
  const security = findSecurity(ticker, view);
  if (!security) throw new Error("未找到对应的美股或 ETF。");
  return {
    source: "live" as const, ...sync, asOf: snapshot.generatedAt, ticker, companyName: security.name, exchange: security.exchange,
    position: view.positionGroups.find((group) => group.symbol === ticker),
    trades: snapshot.trades.filter((trade) => canonicalUnderlying(trade.symbol) === ticker)
      .sort((a, b) => b.tradeTime.localeCompare(a.tradeTime)),
  };
}
