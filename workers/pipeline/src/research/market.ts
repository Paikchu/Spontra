export type MarketObservation = {
  ticker: string; price: number; previousClose: number; changePercent: number;
  sourceAt: string; fetchedAt: string; sourceUrl: string;
  session: "regular" | "outside_regular"; stale: boolean;
};

/** Fixed-host providers only. Timeouts cover both headers and response bodies. */
export async function readProviderJson(url: string, fetcher: typeof fetch, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`provider_http_${response.status}`); }
  if (!response.body) throw new Error("provider_empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("provider_body_limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
export async function fetchMarketObservation(ticker: string, now: string, fetcher: typeof fetch = fetch): Promise<MarketObservation> {
  if (!/^[A-Z0-9.^=-]{1,20}$/.test(ticker)) throw new Error("invalid_ticker");
  const sourceUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`;
  const body = record(await readProviderJson(sourceUrl, fetcher, { "user-agent": "Spontra research monitor" }));
  const results = record(body.chart).result;
  const meta = record(record(Array.isArray(results) ? results[0] : null).meta);
  const price = meta.regularMarketPrice, previousClose = meta.chartPreviousClose, timestamp = meta.regularMarketTime;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || typeof previousClose !== "number" || !Number.isFinite(previousClose) || previousClose <= 0 || typeof timestamp !== "number" || !Number.isFinite(timestamp)) throw new Error("invalid_market_observation");
  const regular = record(record(meta.currentTradingPeriod).regular);
  const seconds = Date.parse(now) / 1000;
  const inSession = typeof regular.start === "number" && typeof regular.end === "number" && seconds >= regular.start && seconds <= regular.end;
  const age = seconds - timestamp;
  return { ticker, price, previousClose, changePercent: (price / previousClose - 1) * 100,
    sourceAt: new Date(timestamp * 1000).toISOString(), fetchedAt: now, sourceUrl,
    session: inSession ? "regular" : "outside_regular", stale: age < -60 || age > 15 * 60 };
}

/** Signals are observations, never explanations for a price move. */
export function priceSignal(current: MarketObservation, previous: MarketObservation | null): { bucket: string; reason: string } | null {
  if (current.stale || current.session !== "regular") return null;
  if (previous && current.sourceAt <= previous.sourceAt) return null;
  const day = current.sourceAt.slice(0, 10);
  const magnitude = Math.abs(current.changePercent);
  if (magnitude >= 3) return { bucket: `${day}-day-${current.changePercent < 0 ? "down" : "up"}-${Math.floor(magnitude / 3)}`, reason: "日内相对前收盘价变动达到阈值" };
  const elapsed = previous ? Date.parse(current.sourceAt) - Date.parse(previous.sourceAt) : Infinity;
  if (previous && !previous.stale && elapsed > 0 && elapsed <= 10 * 60_000 && Math.abs((current.price / previous.price - 1) * 100) >= 1.5) {
    return { bucket: `${day}-fast-${Math.floor(Date.parse(current.sourceAt) / (30 * 60_000))}`, reason: "十分钟内观察到快速价格变动" };
  }
  return null;
}
