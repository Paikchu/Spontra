/** A call as the provider returned it. */
export type TranscriptDocument = { title: string; url: string; text: string };

export type TranscriptRef = { fiscalYear: number; quarter: 1 | 2 | 3 | 4; date: string };

export class TranscriptAccessError extends Error {}

/**
 * The provider refused the request for its rate. `daily`: the key's allowance for the day is spent. `burst`: requests
 * came too close together (Alpha Vantage's free key allows one a second); the next one may go a minute later.
 * `detail` is the provider's own words with the key and links removed, for the log.
 */
export class TranscriptQuotaError extends Error {
  readonly scope: "daily" | "burst";
  readonly detail: string;
  constructor(scope: "daily" | "burst", detail: string) {
    super(`Alpha Vantage ${scope === "daily" ? "daily limit" : "request rate"} reached`);
    this.scope = scope; this.detail = detail;
  }
}

/**
 * Which limit an Alpha Vantage notice is about. The burst notice also mentions "daily rate limits" (in its upsell), so
 * a per-second or per-minute rate decides first; a notice naming neither is treated as a burst, which costs a retry a
 * minute later rather than the rest of the day.
 */
function alphaVantageLimit(message: string): "daily" | "burst" | null {
  if (!/rate|limit|frequency|requests? per|(?:api )?call volume/i.test(message)) return null;
  if (/per\s+(?:second|minute)|sparingly|spreading out|frequency/i.test(message)) return "burst";
  return /per\s+day|daily/i.test(message) ? "daily" : "burst";
}

/** One request per fiscal quarter. The API supplies ordered speaker turns, but no call date. */
export class AlphaVantageTranscriptProvider {
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  constructor(apiKey: string, fetcher: typeof fetch = fetch) { this.apiKey = apiKey; this.fetcher = fetcher; }

  async fetch(ticker: string, ref: TranscriptRef): Promise<TranscriptDocument | null> {
    const quarter = `${ref.fiscalYear}Q${ref.quarter}`;
    const citation = new URL("https://www.alphavantage.co/query");
    citation.search = new URLSearchParams({ function: "EARNINGS_CALL_TRANSCRIPT", symbol: ticker, quarter }).toString();
    const url = new URL(citation);
    url.searchParams.set("apikey", this.apiKey);
    let response: Response;
    try {
      const fetcher = this.fetcher; // Workers' global fetch requires an unbound call.
      response = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch {
      // Fetch errors can include the credential-bearing request URL.
      throw new Error("Alpha Vantage transcript request failed");
    }
    if ([401, 402, 403].includes(response.status)) throw new TranscriptAccessError(`Alpha Vantage HTTP ${response.status}`);
    if (response.status === 429) throw new TranscriptQuotaError("burst", "HTTP 429");
    if (!response.ok) throw new Error(`Alpha Vantage HTTP ${response.status}`);
    const data = await response.json() as {
      symbol?: string; quarter?: string; Information?: string; Note?: string; "Error Message"?: string;
      transcript?: Array<{ speaker?: string; title?: string; content?: string }>;
    };
    const message = data.Information ?? data.Note ?? data["Error Message"];
    if (message) {
      // Every notice upsells "premium plans" and names the key, so those words alone do not mean access is denied.
      const reason = message.replaceAll(this.apiKey, '[redacted]').replace(/https?:\/\/\S+/g, '[url]').slice(0, 300);
      const limit = alphaVantageLimit(message);
      if (/premium endpoint|invalid api ?key|apikey is invalid|entitlement/i.test(message)) throw new TranscriptAccessError(`Alpha Vantage transcript access denied: ${reason}`);
      if (limit) throw new TranscriptQuotaError(limit, reason);
      if (/api.?key|premium|subscription/i.test(message)) throw new TranscriptAccessError(`Alpha Vantage transcript access denied: ${reason}`);
      throw new Error(`Alpha Vantage transcript response error: ${reason}`);
    }
    if (data.symbol !== ticker || data.quarter !== quarter) throw new Error("Alpha Vantage transcript company or fiscal quarter mismatch");
    if (!data.transcript?.length) return null;
    const text = data.transcript.map(turn => {
      if (typeof turn.content !== "string" || !turn.content.trim()) throw new Error("Alpha Vantage transcript contains an empty turn");
      const speaker = [turn.speaker, turn.title].filter(Boolean).join(" — ");
      return `${speaker ? `${speaker}: ` : ""}${turn.content.trim()}`;
    }).join("\n\n");
    if (text.length < 2000) return null;
    return { text,
      title: `${ticker} Q${ref.quarter} FY${ref.fiscalYear} earnings call transcript`,
      url: citation.toString() };
  }
}
