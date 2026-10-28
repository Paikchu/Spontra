import type { ReferenceQuote } from "../../../../shared/analysis-contract/valuation.ts";

/**
 * The market inputs a run freezes once (docs/valuation-assessment-implementation.md §2, docs/valuation-methodology-optimization.md §3):
 * the last completed daily close as the reference price, the ten-year government yield as the risk-free rate, and the
 * company's beta regressed from its own weekly returns against the market index. Read through the same public chart
 * endpoint the SEC reader already uses; never in a read route, and never treated as a live price.
 */
const CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";
const HEADERS = { accept: "application/json", "user-agent": "Mozilla/5.0" };
const DAY = 86_400_000;
/** A close older than this cannot stand in for the current price. */
export const QUOTE_MAX_AGE_DAYS = 7;
/** The index each currency's beta is measured against, and the proxy for its ten-year government yield (quoted in percent). */
const MARKETS: Record<string, { index: string; yield: string; yieldLabel: string }> = {
  USD: { index: "^GSPC", yield: "^TNX", yieldLabel: "CBOE 10-Year Treasury Note Yield" },
};

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
type Close = { date: string; close: number };


async function chart(symbol: string, range: string, interval: "1d" | "1wk", fetcher: typeof fetch, now: Date): Promise<{ currency: string | null; symbol: string | null; timeZone: string; points: Close[]; url: string } | null> {
  const url = new URL(`${CHART}${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", range); url.searchParams.set("interval", interval);
  let body: unknown;
  try {
    const response = await fetcher(url.href, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    body = await response.json();
  } catch { return null; }
  const result = record((record(record(body).chart).result as unknown[] | undefined)?.[0]);
  const meta = record(result.meta);
  const times = Array.isArray(result.timestamp) ? result.timestamp : [];
  const values = record((record(result.indicators).quote as unknown[] | undefined)?.[0]).close;
  if (!Array.isArray(values)) return null;
  const timeZone = typeof meta.exchangeTimezoneName === "string" ? meta.exchangeTimezoneName : "America/New_York";
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }); } catch { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }); }
  const today = formatter.format(now);
  const seen = new Set<string>();
  const points = times.flatMap((t, i) => positive(t) && t * 1000 <= now.getTime() && positive(values[i]) ? [{ date: formatter.format(new Date(t * 1000)), close: values[i] as number }] : [])
    .filter(p => { if (p.date >= today || seen.has(p.date)) return false; seen.add(p.date); return true; }).sort((a, b) => a.date.localeCompare(b.date));
  return { currency: typeof meta.currency === "string" ? meta.currency : null, symbol: typeof meta.symbol === "string" ? meta.symbol : null, timeZone, points, url: url.href };
}

/** The last completed close before today; `usable` says whether the spec lets it enter a comparison. */
export async function fetchReferenceQuote(ticker: string, currency: string, fetcher: typeof fetch = fetch, now = new Date()): Promise<ReferenceQuote | null> {
  const symbol = ticker.replaceAll(".", "-");
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

export type BetaEstimate = { beta: number; observations: number; from: string; to: string; index: string; sourceUrl: string };
/** Beta from two years of weekly log returns against the market index; null with fewer than a year of overlapping weeks. */
export async function fetchBeta(ticker: string, currency: string, fetcher: typeof fetch = fetch, now = new Date()): Promise<BetaEstimate | null> {
  const market = MARKETS[currency];
  if (!market) return null;
  const [stock, index] = await Promise.all([chart(ticker.replaceAll(".", "-"), "2y", "1wk", fetcher, now), chart(market.index, "2y", "1wk", fetcher, now)]);
  if (!stock || !index) return null;
  const byWeek = (points: Close[]) => new Map(points.map(p => [p.date, p.close]));
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
