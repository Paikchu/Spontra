import type { NarrativeResponse } from "../../../../shared/analysis-contract/business-narrative.ts";
import { readCompanyNarrative } from "../../../../shared/analysis-runtime/business-narrative.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { D1SecRepository } from "../sec/d1.ts";
import CRWV from "./authored/CRWV.json" with { type: "json" };
import ORCL from "./authored/ORCL.json" with { type: "json" };

export const narrativeCacheKey = (ticker: string) => `narrative:v1:${ticker}`;

/** Hand-written narratives that stand in until a workflow publishes for the ticker. */
const AUTHORED: Record<string, unknown> = { CRWV, ORCL };

/** A stored narrative wins over an authored one; both are re-validated and never repaired. */
export async function readNarrativeResponse(db: D1Database, rawTicker: string): Promise<NarrativeResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) throw new AnalysisRequestError("INVALID_TICKER", "Invalid company ticker.");
  const stored = await new D1SecRepository(db).getCache<unknown>(narrativeCacheKey(ticker));
  const narrative = (stored ? readCompanyNarrative(stored.payload, ticker) : null) ?? readCompanyNarrative(AUTHORED[ticker], ticker);
  return { schemaVersion: "business-narrative-response.v1", status: narrative ? "ready" : "preparing", narrative };
}
