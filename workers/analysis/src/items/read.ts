import type { ItemAnalysis, ItemAnalysisResponse, ItemKind } from "../../../../shared/analysis-contract/item-analysis.ts";
import type { TurnRecord } from "../agent-loop.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { D1SecRepository } from "../sec/d1.ts";

export const itemsIndexKey = (ticker: string) => `items:v1:${ticker}`;
export const itemAnalysisKey = (ticker: string, id: string) => `item-analysis:v1:${ticker}:${id}`;

/** What the last run covered: every due row, and whether it has an analysis. Its fingerprint is what the task compares. */
export type ItemsIndex = { version: string; fingerprint: string; generatedAt: string; items: Array<{ id: string; kind: ItemKind; written: boolean }> };
/** As stored: the analysis with every turn of the loop that wrote it, for the operator; readers never get the trace. */
export type StoredItem = ItemAnalysis & { trace: TurnRecord[] };

/**
 * One row's analysis as the map reads it: a lookup, re-checked for shape; the trace is left behind. `hidden` is the
 * AI analysis switched off for readers, under which the row keeps the filing digest.
 */
export async function readItemAnalysisResponse(db: D1Database, rawTicker: string, id: string, options: { hidden?: boolean } = {}): Promise<ItemAnalysisResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) throw new AnalysisRequestError("INVALID_TICKER", "Invalid company ticker.");
  if (!/^\d{10}-\d{2}-\d{6}$/.test(id)) throw new AnalysisRequestError("ROUTE_NOT_FOUND", "Invalid filing id.");
  const stored = options.hidden ? null : await new D1SecRepository(db).getCache<StoredItem>(itemAnalysisKey(ticker, id));
  const value = stored?.payload;
  if (!value || value.schemaVersion !== "item-analysis.v1" || value.ticker !== ticker || value.finding?.lens?.type !== "document") return { schemaVersion: "item-analysis-response.v1", status: "unavailable", analysis: null };
  const { trace: _trace, ...analysis } = value;
  void _trace;
  return { schemaVersion: "item-analysis-response.v1", status: "ready", analysis };
}
