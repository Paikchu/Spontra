import type { OperatingMetricsResponse } from "../../../../shared/analysis-contract/operating-metrics.ts";
import { readOperatingMetrics } from "../../../../shared/analysis-runtime/operating-metrics.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { D1SecRepository } from "../sec/d1.ts";
import CRWV from "./authored/CRWV.json" with { type: "json" };
import ORCL from "./authored/ORCL.json" with { type: "json" };

export const operatingMetricsCacheKey = (ticker: string) => `operating-metrics:v1:${ticker}`;

/** Hand-written sets that stand in until the extractor publishes for the ticker. */
const AUTHORED: Record<string, unknown> = { CRWV, ORCL };

/** A stored publication wins over an authored one; both are re-validated and never repaired. */
export async function readOperatingMetricsResponse(db: D1Database, rawTicker: string): Promise<OperatingMetricsResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) throw new AnalysisRequestError("INVALID_TICKER", "Invalid company ticker.");
  const stored = await new D1SecRepository(db).getCache<unknown>(operatingMetricsCacheKey(ticker));
  const metrics = (stored ? readOperatingMetrics(stored.payload, ticker) : null) ?? readOperatingMetrics(AUTHORED[ticker], ticker);
  return { schemaVersion: "operating-metrics-response.v1", status: metrics ? "ready" : "preparing", metrics };
}
