import type { FiscalPeriodFields } from "../../../../shared/analysis-contract/period.ts";
import type { PublicBusinessFlow } from "../../../../shared/analysis-contract/business-flow.ts";
import type { SecFiscalPeriod } from "../../../../shared/analysis-contract/report.ts";
import type { RevenueHistory } from "../../../../shared/analysis-contract/revenue-history.ts";
import { fiscalIdentity, type XbrlFocus } from "../../../../shared/analysis-runtime/fiscal-label.ts";
import { fiscalPeriodsInSequence, quarterOf } from "../sec/fiscal-sequence.ts";

/** ticker|periodEnd → DEI focus after the fiscal-year sequence correction. */
export type FiscalFocusMap = Map<string, XbrlFocus>;

function parsePeriod(payload: string): SecFiscalPeriod | null {
  try {
    const value = JSON.parse(payload) as Partial<SecFiscalPeriod> | null;
    if (!value || typeof value.fiscalYear !== "number" || typeof value.fiscalPeriod !== "string" || typeof value.periodEnd !== "string") return null;
    return value as SecFiscalPeriod;
  } catch {
    return null;
  }
}

/**
 * DEI fiscal focus already stored on `sec:fiscal-period:v1:*`. Read-only: no filing fetch and no model call.
 * Pass a ticker to read one issuer; omit it to read every cached focus (the homepage digest).
 */
export async function readFiscalFocus(db: D1Database, ticker?: string): Promise<FiscalFocusMap> {
  const canonical = ticker?.trim().toUpperCase();
  const prefix = canonical ? `sec:fiscal-period:v1:${canonical}:` : "sec:fiscal-period:v1:";
  const upper = canonical ? `sec:fiscal-period:v1:${canonical};` : "sec:fiscal-period:v1;";
  const rows = await db.prepare(`SELECT cache_key, payload FROM sec_cache WHERE cache_key >= ? AND cache_key < ?`).bind(prefix, upper)
    .all<{ cache_key: string; payload: string }>()
    .catch(() => ({ results: [] as Array<{ cache_key: string; payload: string }> }));
  const byTicker = new Map<string, SecFiscalPeriod[]>();
  for (const row of rows.results ?? []) {
    const period = parsePeriod(row.payload);
    if (!period) continue;
    const rest = row.cache_key.slice("sec:fiscal-period:v1:".length);
    const split = rest.lastIndexOf(":");
    const key = (split > 0 ? rest.slice(0, split) : rest).toUpperCase();
    if (!key) continue;
    const list = byTicker.get(key) ?? [];
    list.push(period);
    byTicker.set(key, list);
  }
  const out: FiscalFocusMap = new Map();
  for (const [key, periods] of byTicker) {
    for (const period of fiscalPeriodsInSequence(periods)) {
      const quarter = quarterOf(period.fiscalPeriod);
      if (!quarter) continue;
      out.set(`${key}|${period.periodEnd}`, { fiscalYear: period.fiscalYear, fiscalQuarter: quarter });
    }
  }
  return out;
}

export function fiscalFields(ticker: string, periodEnd: string, map: FiscalFocusMap | null): FiscalPeriodFields {
  return fiscalIdentity({ ticker, periodEnd, xbrl: map?.get(`${ticker.trim().toUpperCase()}|${periodEnd}`) ?? null });
}

export function stampFlow(flow: PublicBusinessFlow, map: FiscalFocusMap | null): PublicBusinessFlow {
  return { ...flow, quarters: flow.quarters.map(quarter => ({ ...quarter, ...fiscalFields(flow.ticker, quarter.periodEnd, map) })) };
}

export function stampHistory(history: RevenueHistory, map: FiscalFocusMap | null): RevenueHistory {
  return { ...history, quarters: history.quarters.map(quarter => ({ ...quarter, ...fiscalFields(history.ticker, quarter.periodEnd, map) })) };
}
