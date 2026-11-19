/** One daily OHLC price bar in exchange calendar YYYY-MM-DD, oldest first. */
export type DailyPriceBar = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type MarketSessionState = "regular" | "pre" | "post" | "closed";

/** Live / latest daily candlestick series for the valuation chart, locked to the daily interval. */
export type LiveMarketDaily = {
  schemaVersion: "market-daily.v1";
  ticker: string;
  currency: string | null;
  livePrice: number | null;
  liveDate: string | null;
  previousClose: number | null;
  marketState: MarketSessionState;
  bars: DailyPriceBar[];
};
