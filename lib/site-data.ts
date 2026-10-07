import symbolDirectoryData from "@/data/us-securities.json";
import { loadPortfolio } from "./portfolio-client";
import { buildPortfolioViewModel } from "./portfolio-view-model";
import { normalizeTicker, type SymbolDirectoryEntry } from "@/lib/symbol-directory";

export const symbolDirectory = symbolDirectoryData as { generatedAt: string; sourceUpdatedAt: string | null; securities: SymbolDirectoryEntry[] };

export async function currentPortfolioSnapshot() {
  return (await loadPortfolio()).snapshot;
}

/** Resolve broker-only tickers through the API when the public directory has no entry. */
export async function loadSecurity(rawTicker: string): Promise<SymbolDirectoryEntry | null> {
  return findSecurity(rawTicker) ?? findSecurity(rawTicker, buildPortfolioViewModel(await currentPortfolioSnapshot()));
}

export function findSecurity(rawTicker: string, currentViewModel?: ReturnType<typeof buildPortfolioViewModel>): SymbolDirectoryEntry | null {
  const ticker = normalizeTicker(rawTicker);
  const held = currentViewModel?.positionGroups.find((group) => group.symbol === ticker);
  const listed = symbolDirectory.securities.find((security) => security.symbol === ticker);
  if (held) return listed ? { ...listed, name: held.name } : { symbol: ticker, name: held.name, exchange: "IBKR", type: "stock" };
  const historical = currentViewModel?.historicalPositionGroups.find((group) => group.symbol === ticker);
  if (historical) return listed ?? { symbol: ticker, name: ticker, exchange: "IBKR", type: "stock" };
  return listed ?? null;
}
