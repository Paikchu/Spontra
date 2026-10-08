import type { FindingsResponse } from "../../../../shared/analysis-contract/findings.ts";
import { readFindingsPublication } from "../../../../shared/analysis-runtime/findings.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { ORCL_FINDINGS } from "./authored/ORCL.ts";

export const findingsCacheKey = (ticker: string) => `findings:v1:${ticker}`;

/** Hand-written sets that stand in until the findings workflow publishes for the ticker. */
const AUTHORED: Record<string, unknown> = { ORCL: ORCL_FINDINGS };

/** A stored publication wins over an authored one; both are re-validated and never repaired. */
export async function readFindingsResponse(db: D1Database, rawTicker: string): Promise<FindingsResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) throw new AnalysisRequestError("INVALID_TICKER", "Invalid company ticker.");
  const stored = await new D1SecRepository(db).getCache<unknown>(findingsCacheKey(ticker));
  const findings = (stored ? readFindingsPublication(stored.payload, ticker) : null) ?? readFindingsPublication(AUTHORED[ticker], ticker);
  return { schemaVersion: "findings-response.v1", status: findings ? "ready" : "preparing", findings };
}
