import { getD1 } from "@/db";
import { readPortfolioSnapshotWithSource } from "@/lib/portfolio-store";

import { portfolioSnapshot, findSecurity } from "@/lib/site-data";
import { buildPortfolioViewModel } from "@/lib/portfolio-view-model";
import { canonicalUnderlying } from "@/lib/portfolio-snapshot";
import { normalizeTicker } from "@/lib/symbol-directory";

export async function loadStock(rawTicker: string) {
  const ticker = normalizeTicker(rawTicker);
  const { snapshot, source } = await getD1().then(readPortfolioSnapshotWithSource).catch(() => ({ snapshot: portfolioSnapshot, source: "fallback" as const }));
  const view = buildPortfolioViewModel(snapshot);
  const security = findSecurity(ticker, view);
  if (!security) throw new Error("未找到对应的美股或 ETF。");
  return {
    source, asOf: snapshot.generatedAt, ticker, companyName: security.name, exchange: security.exchange,
    position: view.positionGroups.find((group) => group.symbol === ticker),
    trades: snapshot.trades.filter((trade) => canonicalUnderlying(trade.symbol) === ticker)
      .sort((a, b) => b.tradeTime.localeCompare(a.tradeTime)),
  };
}
