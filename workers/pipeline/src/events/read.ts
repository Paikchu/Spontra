import type { EventsResponse } from "../../../../shared/analysis-contract/events.ts";
import { readEventsPublication } from "../../../../shared/analysis-runtime/events.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { D1SecRepository } from "../sec/d1.ts";

export const eventsCacheKey = (ticker: string) => `events:v1:${ticker}`;
export const insiderCacheKey = (ticker: string, accession: string) => `insider:v1:${ticker}:${accession}`;
export const exhibitsCacheKey = (ticker: string, accession: string) => `exhibits:v1:${ticker}:${accession}`;

/** The stored publication, re-validated; nothing stored (or an invalid record) reads as preparing. */
export async function readEventsResponse(db: D1Database, rawTicker: string): Promise<EventsResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) throw new AnalysisRequestError("INVALID_TICKER", "Invalid company ticker.");
  const stored = await new D1SecRepository(db).getCache<unknown>(eventsCacheKey(ticker));
  const events = stored ? readEventsPublication(stored.payload, ticker) : null;
  return { schemaVersion: "events-response.v1", status: events ? "ready" : "preparing", events };
}
