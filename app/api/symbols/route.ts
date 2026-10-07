import { buildPortfolioViewModel } from "@/lib/portfolio-view-model";
import { currentPortfolioSnapshot, symbolDirectory } from "@/lib/site-data";
import { searchSecurities, type SymbolDirectoryEntry } from "@/lib/symbol-directory";

async function search(request: Request) {
  const portfolioViewModel = buildPortfolioViewModel(await currentPortfolioSnapshot());
  const query = new URL(request.url).searchParams.get("q") ?? "";
  const heldSymbols = new Set(portfolioViewModel.positionGroups.map((group) => group.symbol));
  const directorySymbols = new Set(symbolDirectory.securities.map((security) => security.symbol));
  const searchEntries = [
    ...symbolDirectory.securities,
    ...portfolioViewModel.positionGroups
      .filter((group) => !directorySymbols.has(group.symbol))
      .map((group): SymbolDirectoryEntry => ({ symbol: group.symbol, name: group.name, exchange: "IBKR", type: "stock" })),
  ];
  return Response.json({
    results: searchSecurities(searchEntries, query, heldSymbols, 10),
    directoryUpdatedAt: symbolDirectory.generatedAt,
  });
}

export async function GET(request: Request) {
  try { return await search(request); }
  catch { return Response.json({ error: "持仓数据暂时无法读取，请稍后重试。" }, { status: 503, headers: { "cache-control": "private, no-store" } }); }
}
