import { YAHOO_QUARTERLY_FUNDAMENTAL_FIELDS } from "./fundamental-metrics.ts";
import {
  YahooFundamentalsPayloadError,
  normalizeFundamentalTicker,
  parseYahooFundamentalsPayload,
  toYahooFundamentalSymbol,
  type YahooFundamentalsPayload,
} from "./yahoo-fundamentals-schema.ts";

export const YAHOO_FUNDAMENTALS_ENDPOINT =
  "https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries";

export type YahooFundamentalsRequest = {
  ticker: string;
  url: URL;
  requestHash: string;
};

export type YahooFundamentalsFetchResult = {
  request: YahooFundamentalsRequest;
  parsed: YahooFundamentalsPayload;
  payloadHash: string;
  fetchedAt: string;
  attempts: number;
};

export type YahooFundamentalsFetchOptions = {
  fetcher?: typeof fetch;
  clock?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
};

export class YahooFundamentalsRequestError extends Error {
  readonly code: "INVALID_TICKER" | "HTTP_ERROR" | "NETWORK_ERROR" | "INVALID_JSON" | "INVALID_PAYLOAD";
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(input: {
    code: YahooFundamentalsRequestError["code"];
    message: string;
    status?: number;
    retryable: boolean;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "YahooFundamentalsRequestError";
    this.code = input.code;
    this.status = input.status ?? null;
    this.retryable = input.retryable;
  }
}

export async function buildYahooFundamentalsRequest(
  rawTicker: string,
  now = new Date(),
): Promise<YahooFundamentalsRequest> {
  const ticker = normalizeFundamentalTicker(rawTicker);
  if (!ticker) {
    throw new YahooFundamentalsRequestError({
      code: "INVALID_TICKER",
      message: "Ticker is invalid for Yahoo fundamentals.",
      retryable: false,
    });
  }

  const yahooSymbol = toYahooFundamentalSymbol(ticker);
  const url = new URL(`${YAHOO_FUNDAMENTALS_ENDPOINT}/${encodeURIComponent(yahooSymbol)}`);
  url.searchParams.set("symbol", yahooSymbol);
  url.searchParams.set("type", YAHOO_QUARTERLY_FUNDAMENTAL_FIELDS.join(","));
  url.searchParams.set("period1", String(Math.floor(Date.UTC(now.getUTCFullYear() - 10, 0, 1) / 1_000)));
  url.searchParams.set("period2", String(Math.floor(now.getTime() / 1_000) + 86_400));

  return {
    ticker,
    url,
    requestHash: await sha256Hex(`GET ${url.toString()}`),
  };
}

export async function fetchYahooFundamentals(
  request: YahooFundamentalsRequest,
  options: YahooFundamentalsFetchOptions = {},
): Promise<YahooFundamentalsFetchResult> {
  const fetcher = options.fetcher ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  const timeoutMs = clampInteger(options.timeoutMs ?? 5_000, 250, 15_000);
  const maxAttempts = clampInteger(options.maxAttempts ?? 3, 1, 4);
  const retryBaseDelayMs = clampInteger(options.retryBaseDelayMs ?? 250, 0, 5_000);

  let lastError: YahooFundamentalsRequestError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetcher(request.url, {
        cache: "no-store",
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0 (compatible; MAX-Fundamentals/1.0)",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new YahooFundamentalsRequestError({
          code: "HTTP_ERROR",
          message: `Yahoo fundamentals request failed with HTTP ${response.status}.`,
          status: response.status,
          retryable: isRetryableStatus(response.status),
        });
      }

      const body = await response.text();
      let rawPayload: unknown;
      try {
        rawPayload = JSON.parse(body) as unknown;
      } catch (error) {
        throw new YahooFundamentalsRequestError({
          code: "INVALID_JSON",
          message: "Yahoo fundamentals response is not valid JSON.",
          retryable: true,
          cause: error,
        });
      }

      let parsed: YahooFundamentalsPayload;
      try {
        parsed = parseYahooFundamentalsPayload(rawPayload, request.ticker);
      } catch (error) {
        if (!(error instanceof YahooFundamentalsPayloadError)) throw error;
        throw new YahooFundamentalsRequestError({
          code: "INVALID_PAYLOAD",
          message: error.message,
          retryable: false,
          cause: error,
        });
      }

      return {
        request,
        parsed,
        payloadHash: await sha256Hex(body),
        fetchedAt: clock().toISOString(),
        attempts: attempt,
      };
    } catch (error) {
      lastError = normalizeRequestError(error);
      if (!lastError.retryable || attempt === maxAttempts) throw lastError;
      const exponentialDelay = retryBaseDelayMs * (2 ** (attempt - 1));
      const jitter = 0.8 + (Math.min(1, Math.max(0, random())) * 0.4);
      await sleep(Math.round(exponentialDelay * jitter));
    }
  }

  throw lastError ?? new YahooFundamentalsRequestError({
    code: "NETWORK_ERROR",
    message: "Yahoo fundamentals request failed.",
    retryable: true,
  });
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeRequestError(error: unknown): YahooFundamentalsRequestError {
  if (error instanceof YahooFundamentalsRequestError) return error;
  return new YahooFundamentalsRequestError({
    code: "NETWORK_ERROR",
    message: error instanceof DOMException && error.name === "TimeoutError"
      ? "Yahoo fundamentals request timed out."
      : "Yahoo fundamentals network request failed.",
    retryable: true,
    cause: error,
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
