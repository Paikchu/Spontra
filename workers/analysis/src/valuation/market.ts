import type { ReferenceQuote } from "../../../../shared/analysis-contract/valuation.ts";
import { readYahooChart, yahooChartUrl, yahooSymbol, type ChartClose } from "../market/yahoo.ts";

/**
 * The market inputs a run freezes once:
 * the last completed daily close as the reference price, the ten-year government yield as the risk-free rate, and the
 * company's beta regressed from its own weekly returns against the market index. Read through the shared Yahoo chart client
 * (market/yahoo.ts), as the filing reports are; never in a read route, and never treated as a live price.
 */
const DAY = 86_400_000;
/** A close older than this cannot stand in for the current price. */
export const QUOTE_MAX_AGE_DAYS = 7;
/** The index each currency's beta is measured against, and the proxy for its ten-year government yield (quoted in percent). */
const MARKETS: Record<string, { index: string; yield: string; yieldLabel: string }> = {
  USD: { index: "^GSPC", yield: "^TNX", yieldLabel: "CBOE 10-Year Treasury Note Yield" },
};

const chart = (symbol: string, range: string, interval: "1d" | "1wk", fetcher: typeof fetch, now: Date) => readYahooChart(yahooChartUrl(symbol, { range, interval }), fetcher, now);

/** The latest completed daily close; `usable` says whether the spec lets it enter a comparison. */
export async function fetchReferenceQuote(ticker: string, currency: string, fetcher: typeof fetch = fetch, now = new Date()): Promise<ReferenceQuote | null> {
  const symbol = yahooSymbol(ticker);
  const read = await chart(symbol, "1mo", "1d", fetcher, now);
  const latest = read?.points.at(-1);
  if (!read || !latest) return null;
  const limitations: string[] = [];
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: read.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  if (read.symbol !== symbol) limitations.push("The chart answered for another symbol.");
  if (read.currency !== currency) limitations.push(`The quote is in ${read.currency ?? "an unknown currency"}; the statements are in ${currency}.`);
  if ((Date.parse(today) - Date.parse(latest.date)) / DAY > QUOTE_MAX_AGE_DAYS) limitations.push(`The last close is more than ${QUOTE_MAX_AGE_DAYS} days old.`);
  return { price: latest.close, currency: read.currency ?? currency, priceDate: latest.date, source: "Yahoo Finance", sourceUrl: read.url, fetchedAt: now.toISOString(), usable: limitations.length === 0, limitations };
}

export type RiskFreeRate = { value: number; date: string; label: string; sourceUrl: string };
/** The ten-year government yield for the valuation currency as a decimal, or null where no proxy is known. */
export async function fetchRiskFreeRate(currency: string, fetcher: typeof fetch = fetch, now = new Date()): Promise<RiskFreeRate | null> {
  const market = MARKETS[currency];
  if (!market) return null;
  const read = await chart(market.yield, "1mo", "1d", fetcher, now);
  const latest = read?.points.at(-1);
  if (!read || !latest || !(latest.close > 0) || latest.close > 30) return null;
  return { value: latest.close / 100, date: latest.date, label: market.yieldLabel, sourceUrl: read.url };
}

/** Two years of weekly closes for the company's own trailing-multiple history; null when the chart does not answer. */
export async function fetchWeeklyCloses(ticker: string, fetcher: typeof fetch = fetch, now = new Date()): Promise<ChartClose[] | null> {
  const read = await chart(yahooSymbol(ticker), "2y", "1wk", fetcher, now);
  return read?.points.length ? read.points : null;
}

/** The ranking peers' last closes, each a reference quote in the valuation currency or null; read in parallel, never in a read route. */
export async function fetchPeerQuotes(tickers: string[], currency: string, fetcher: typeof fetch = fetch, now = new Date()): Promise<Record<string, ReferenceQuote | null>> {
  const quotes = await Promise.all(tickers.map(t => fetchReferenceQuote(t, currency, fetcher, now).catch(() => null)));
  return Object.fromEntries(tickers.map((t, i) => [t, quotes[i] ?? null]));
}

export type BetaEstimate = { beta: number; observations: number; from: string; to: string; index: string; sourceUrl: string };
/** Beta from two years of weekly log returns against the market index; null with fewer than a year of overlapping weeks. */
export async function fetchBeta(ticker: string, currency: string, fetcher: typeof fetch = fetch, now = new Date()): Promise<BetaEstimate | null> {
  const market = MARKETS[currency];
  if (!market) return null;
  const [stock, index] = await Promise.all([chart(yahooSymbol(ticker), "2y", "1wk", fetcher, now), chart(market.index, "2y", "1wk", fetcher, now)]);
  if (!stock || !index) return null;
  const byWeek = (points: ChartClose[]) => new Map(points.map(p => [p.date, p.close]));
  const s = byWeek(stock.points), m = byWeek(index.points);
  const dates = [...s.keys()].filter(d => m.has(d)).sort();
  const rs: number[] = [], rm: number[] = [];
  for (let i = 1; i < dates.length; i++) { rs.push(Math.log(s.get(dates[i]!)! / s.get(dates[i - 1]!)!)); rm.push(Math.log(m.get(dates[i]!)! / m.get(dates[i - 1]!)!)); }
  if (rs.length < 52) return null;
  const mean = (list: number[]) => list.reduce((a, b) => a + b, 0) / list.length;
  const ms = mean(rs), mm = mean(rm);
  let cov = 0, variance = 0;
  for (let i = 0; i < rs.length; i++) { cov += (rs[i]! - ms) * (rm[i]! - mm); variance += (rm[i]! - mm) ** 2; }
  if (variance <= 0) return null;
  return { beta: cov / variance, observations: rs.length, from: dates[0]!, to: dates[dates.length - 1]!, index: market.index, sourceUrl: stock.url };
}
