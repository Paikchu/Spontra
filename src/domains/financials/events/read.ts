import type { EventsResponse } from "../events-contract.ts";
import { readEventsPublication } from "../events-runtime.ts";
import { AnalysisRequestError } from "../../../api/public/contract-support/errors.ts";
import { D1SecRepository } from "../../filing-analysis/sec/d1.ts";
import { TICKER_PATTERN } from "../runtime/policy.ts";

export const eventsCacheKey = (ticker: string) => `events:v1:${ticker}`;
export const insiderCacheKey = (ticker: string, accession: string) => `insider:v1:${ticker}:${accession}`;
export const exhibitsCacheKey = (ticker: string, accession: string) => `exhibits:v1:${ticker}:${accession}`;

/**
 * The stored publication, re-validated; nothing stored (or an invalid record) reads as preparing. `hidden` is the reports
 * feature switched off for readers: the filings are still listed, as filings, without the summaries the model wrote.
 */
export async function readEventsResponse(db: D1Database, rawTicker: string, options: { hidden?: boolean } = {}): Promise<EventsResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!TICKER_PATTERN.test(ticker)) throw new AnalysisRequestError("INVALID_TICKER", "Invalid company ticker.");
  const stored = await new D1SecRepository(db).getCache<unknown>(eventsCacheKey(ticker));
  const read = stored ? readEventsPublication(stored.payload, ticker) : null;
  const events = read && options.hidden ? { ...read, events: read.events.map(e => ({ ...e, summary: null })) } : read;
  return { schemaVersion: "events-response.v1", status: events ? "ready" : "preparing", events };
}
