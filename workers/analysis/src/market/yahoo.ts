/**
 * Yahoo Finance, the one market-data source: completed closes from the public chart endpoint (filing reports and
 * valuation) and quarterly fundamentals from the timeseries endpoint. Every request sends the same headers.
 */
const YAHOO_CHART_ENDPOINT = "https://query1.finance.yahoo.com/v8/finance/chart";
export const YAHOO_FUNDAMENTALS_ENDPOINT = "https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries";
export const YAHOO_HEADERS = { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; Spontra/1.0)" } as const;

/** Yahoo writes a share class with a dash (BRK-B) where filings use a dot (BRK.B). */
export function yahooSymbol(ticker: string): string {
  return ticker.replaceAll(".", "-");
}

export type ChartClose = { date: string; close: number };
export type YahooChart = { symbol: string | null; currency: string | null; instrumentType: string | null; timeZone: string; points: ChartClose[]; url: string };

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const text = (v: unknown): string | null => typeof v === "string" ? v : null;

/** The chart address for a symbol; `params` is either a `range` or a `period1`/`period2` window, plus the `interval`. */
export function yahooChartUrl(symbol: string, params: Record<string, string>): URL {
  const url = new URL(`${YAHOO_CHART_ENDPOINT}/${encodeURIComponent(symbol)}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

/**
 * Completed closes in the exchange's own calendar, oldest first: today's unfinished session, future stamps and repeated
 * dates are dropped. Null when the chart does not answer or carries no closes.
 */
export async function readYahooChart(url: URL, fetcher: typeof fetch, now: Date): Promise<YahooChart | null> {
  let body: unknown;
  try {
    const response = await fetcher(url.href, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    body = await response.json();
  } catch { return null; }
  const result = record((record(record(body).chart).result as unknown[] | undefined)?.[0]);
  const meta = record(result.meta);
  const times = Array.isArray(result.timestamp) ? result.timestamp : [];
  const values = record((record(result.indicators).quote as unknown[] | undefined)?.[0]).close;
  if (!Array.isArray(values)) return null;
  const timeZone = text(meta.exchangeTimezoneName) ?? "America/New_York";
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }); } catch { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }); }
  const today = formatter.format(now);
  const regularEnd = record(record(meta.currentTradingPeriod).regular).end;
  const currentDailySessionClosed = url.searchParams.get("interval") === "1d" && positive(regularEnd)
    && regularEnd * 1000 <= now.getTime() && formatter.format(new Date(regularEnd * 1000)) === today;
  const seen = new Set<string>();
  const points = times.flatMap((t, i) => positive(t) && t * 1000 <= now.getTime() && positive(values[i]) ? [{ date: formatter.format(new Date(t * 1000)), close: values[i] as number }] : [])
    .filter(p => { if (p.date > today || (p.date === today && !currentDailySessionClosed) || seen.has(p.date)) return false; seen.add(p.date); return true; }).sort((a, b) => a.date.localeCompare(b.date));
  return { symbol: text(meta.symbol), currency: text(meta.currency), instrumentType: text(meta.instrumentType), timeZone, points, url: url.href };
}
