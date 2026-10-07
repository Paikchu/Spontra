import { canonicalUnderlying, type PortfolioSnapshotV1 } from "./portfolio-snapshot.ts";

export type StockHoldingView = {
  symbol: string;
  name: string;
  averageCost: number;
  actualCost: number;
  quantity: number;
  weight: number;
  unrealized: number;
  realized: number;
  price: number;
  value: number;
  cost: number;
};

export type OptionContractView = {
  symbol: string;
  contract: string;
  quantity: number;
  averageCost: number;
  price: number;
  cost: number;
  marketValue: number;
  weight: number;
  unrealized: number;
};

export type PositionGroupView = {
  symbol: string;
  name: string;
  stock?: StockHoldingView;
  options: OptionContractView[];
  value: number;
  cost: number;
  unrealized: number;
  realized: number;
  netPnl: number;
  weight: number;
  grossValue: number;
};

export type HistoricalPositionGroupView = {
  symbol: string;
  name: string;
  firstTradeDate: string;
  lastTradeDate: string;
  stockTrades: number;
  optionTrades: number;
  realized: number;
};

function portfolioTradeDate(trade: PortfolioSnapshotV1["trades"][number]): string {
  return trade.tradeDate ?? trade.tradeTime.slice(0, 10);
}

export function buildPortfolioViewModel(snapshot: PortfolioSnapshotV1, reportDate?: string | null) {
  const snapshotYear = Number((reportDate ?? snapshot.source?.reportDate)?.slice(0, 4) ?? new Date(snapshot.generatedAt).getUTCFullYear());
  const realizedBySymbolAndType = snapshot.trades.reduce<Record<string, { stock: number; options: number }>>((totals, trade) => {
    if (Number(portfolioTradeDate(trade).slice(0, 4)) !== snapshotYear) return totals;
    if (trade.securityType !== "STK" && trade.securityType !== "OPT") return totals;
    const symbol = canonicalUnderlying(trade.symbol);
    totals[symbol] ??= { stock: 0, options: 0 };
    if (trade.securityType === "STK") totals[symbol].stock += trade.realizedPnl;
    else totals[symbol].options += trade.realizedPnl;
    return totals;
  }, {});
  const companyNames = snapshot.trades.reduce<Record<string, string>>((names, trade) => {
    names[canonicalUnderlying(trade.symbol)] ??= trade.contractDescription;
    return names;
  }, {});
  const holdings: StockHoldingView[] = snapshot.positions
    .filter((position) => position.assetClass === "STK")
    .map((position) => {
      const realized = realizedBySymbolAndType[position.symbol]?.stock ?? 0;
      return {
        symbol: position.symbol,
        name: companyNames[position.symbol] ?? position.contractDescription,
        averageCost: position.averagePrice,
        actualCost: position.quantity === 0 ? 0 : (position.costBasis - realized) / position.quantity,
        quantity: position.quantity,
        weight: (position.marketValue / snapshot.account.netLiquidation) * 100,
        unrealized: position.unrealizedPnl,
        realized,
        price: position.marketPrice,
        value: position.marketValue,
        cost: position.costBasis,
      };
    })
    .sort((left, right) => right.value - left.value);
  const optionContracts: OptionContractView[] = snapshot.positions
    .filter((position) => position.assetClass === "OPT")
    .map((position) => ({
      symbol: position.symbol,
      contract: position.contractDescription,
      quantity: position.quantity,
      averageCost: position.averagePrice,
      price: position.marketPrice,
      cost: position.costBasis,
      marketValue: position.marketValue,
      weight: (position.marketValue / snapshot.account.netLiquidation) * 100,
      unrealized: position.unrealizedPnl,
    }));
  const positionGroups: PositionGroupView[] = [...new Set([...holdings.map((holding) => holding.symbol), ...optionContracts.map((option) => option.symbol)])]
    .map((symbol) => {
      const stock = holdings.find((holding) => holding.symbol === symbol);
      const options = optionContracts.filter((option) => option.symbol === symbol);
      const optionValue = options.reduce((sum, option) => sum + option.marketValue, 0);
      const optionCost = options.reduce((sum, option) => sum + option.cost, 0);
      const optionUnrealized = options.reduce((sum, option) => sum + option.unrealized, 0);
      const value = (stock?.value ?? 0) + optionValue;
      const cost = (stock?.cost ?? 0) + optionCost;
      const unrealized = (stock?.unrealized ?? 0) + optionUnrealized;
      const realizedBreakdown = realizedBySymbolAndType[symbol] ?? { stock: 0, options: 0 };
      const realized = realizedBreakdown.stock + realizedBreakdown.options;
      return {
        symbol,
        name: stock?.name ?? companyNames[symbol] ?? symbol,
        stock,
        options,
        value,
        cost,
        unrealized,
        realized,
        netPnl: unrealized + realized,
        weight: (value / snapshot.account.netLiquidation) * 100,
        grossValue: Math.abs(stock?.value ?? 0) + options.reduce((sum, option) => sum + Math.abs(option.marketValue), 0),
      };
    })
    .sort((left, right) => right.grossValue - left.grossValue);
  const currentSymbols = new Set(positionGroups.map((group) => group.symbol));
  const historicalBySymbol = snapshot.trades.reduce<Record<string, HistoricalPositionGroupView>>((groups, trade) => {
    if (trade.securityType !== "STK" && trade.securityType !== "OPT") return groups;
    const symbol = canonicalUnderlying(trade.symbol);
    if (currentSymbols.has(symbol)) return groups;
    const tradeDate = portfolioTradeDate(trade);
    const group = groups[symbol] ?? {
      symbol,
      name: trade.contractDescription,
      firstTradeDate: tradeDate,
      lastTradeDate: tradeDate,
      stockTrades: 0,
      optionTrades: 0,
      realized: 0,
    };
    if (trade.securityType === "STK") {
      group.stockTrades += 1;
      group.name = trade.contractDescription || group.name;
    } else {
      group.optionTrades += 1;
    }
    group.firstTradeDate = tradeDate < group.firstTradeDate ? tradeDate : group.firstTradeDate;
    group.lastTradeDate = tradeDate > group.lastTradeDate ? tradeDate : group.lastTradeDate;
    group.realized += trade.realizedPnl;
    groups[symbol] = group;
    return groups;
  }, {});
  const historicalPositionGroups = Object.values(historicalBySymbol)
    .map((group) => ({ ...group, realized: Math.round(group.realized * 100) / 100 }))
    .sort((left, right) => right.lastTradeDate.localeCompare(left.lastTradeDate) || left.symbol.localeCompare(right.symbol));
  const stockMarketValue = holdings.reduce((sum, holding) => sum + holding.value, 0);
  const optionMarketValue = optionContracts.reduce((sum, option) => sum + option.marketValue, 0);

  return {
    holdings,
    optionContracts,
    positionGroups,
    historicalPositionGroups,
    stockMarketValue,
    optionMarketValue,
    netPositionsValue: stockMarketValue + optionMarketValue,
  };
}
