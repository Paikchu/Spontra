import type { FiscalPeriodFields } from "../../../../shared/analysis-contract/period.ts";
import type { PublicBusinessFlow } from "../../../../shared/analysis-contract/business-flow.ts";
import type { SecFiscalPeriod } from "../../../../shared/analysis-contract/report.ts";
import type { RevenueHistory } from "../../../../shared/analysis-contract/revenue-history.ts";
import { fiscalIdentity, quarterNumber, yearEndMonth, type IssuerCalendar, type XbrlFocus } from "../../../../shared/analysis-runtime/fiscal-label.ts";
import { issuerNames } from "../../../../shared/analysis-runtime/business-tree.ts";
import { companyName } from "../catalog/security-directory.ts";
import { DISCOVERY_STATE_PREFIX, type DiscoveryState } from "../pipeline/discovery.ts";
import { fiscalPeriodsInSequence } from "../sec/fiscal-sequence.ts";

/** `focus`: ticker|periodEnd → DEI focus after the fiscal-year sequence correction. `issuers`: ticker → fiscal calendar. */
export type FiscalFocusMap = { focus: Map<string, XbrlFocus>; issuers: Map<string, IssuerCalendar> };

function parsePeriod(payload: string): SecFiscalPeriod | null {
  try {
    const value = JSON.parse(payload) as Partial<SecFiscalPeriod> | null;
    if (!value || typeof value.fiscalYear !== "number" || typeof value.fiscalPeriod !== "string" || typeof value.periodEnd !== "string") return null;
    return value as SecFiscalPeriod;
  } catch {
    return null;
  }
}

/** Cached rows under a `…:` key prefix: one issuer's (its key, or its keys continuing with `:`) or every issuer's. */
async function cachedRows(db: D1Database, prefix: string, ticker: string | undefined, nested: boolean) {
  const from = ticker ? `${prefix}${ticker}${nested ? ":" : ""}` : prefix, to = ticker ? `${prefix}${ticker}${nested ? ";" : "\u0000"}` : `${prefix.slice(0, -1)};`;
  const rows = await db.prepare(`SELECT cache_key, payload FROM sec_cache WHERE cache_key >= ? AND cache_key < ?`).bind(from, to)
    .all<{ cache_key: string; payload: string }>()
    .catch(() => ({ results: [] as Array<{ cache_key: string; payload: string }> }));
  return rows.results ?? [];
}

function parseState(payload: string): DiscoveryState | null {
  try {
    const value = JSON.parse(payload) as DiscoveryState | null;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * DEI fiscal focus already stored on `sec:fiscal-period:v1:*`, and each issuer's fiscal calendar: the year end its
 * submissions state (stored by discovery), else the period end of its latest annual report's focus. Read-only: no
 * filing fetch and no model call. Pass a ticker to read one issuer; omit it to read every cached one (the homepage digest).
 */
export async function readFiscalFocus(db: D1Database, ticker?: string): Promise<FiscalFocusMap> {
  const canonical = ticker?.trim().toUpperCase();
  const [periods, states] = await Promise.all([
    cachedRows(db, "sec:fiscal-period:v1:", canonical, true),
    cachedRows(db, DISCOVERY_STATE_PREFIX, canonical, false),
  ]);
  const byTicker = new Map<string, SecFiscalPeriod[]>();
  for (const row of periods) {
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
  const focus = new Map<string, XbrlFocus>(), annual = new Map<string, string>();
  for (const [key, periods] of byTicker) {
    for (const period of fiscalPeriodsInSequence(periods)) {
      const quarter = quarterNumber(period.fiscalPeriod);
      if (!quarter) continue;
      focus.set(`${key}|${period.periodEnd}`, { fiscalYear: period.fiscalYear, fiscalQuarter: quarter });
      if (period.fiscalPeriod === "FY" && period.periodEnd > (annual.get(key) ?? "")) annual.set(key, period.periodEnd);
    }
  }
  const issuers = new Map<string, IssuerCalendar>();
  const stated = new Map(states.flatMap(row => { const state = parseState(row.payload); return state ? [[row.cache_key.slice(DISCOVERY_STATE_PREFIX.length).toUpperCase(), state] as const] : []; }));
  for (const key of new Set([...stated.keys(), ...annual.keys()])) {
    const state = stated.get(key);
    issuers.set(key, { fiscalYearEndMonth: yearEndMonth(state?.fiscalYearEnd) ?? yearEndMonth(annual.get(key)), name: shortName(key, state?.name), annualForm: state?.annualForm ?? null });
  }
  return { focus, issuers };
}

/** The name readers know the issuer by: its listing's name without legal form, else the name its filings carry. */
function shortName(ticker: string, filed: string | null | undefined): string | null {
  const listed = companyName(ticker) ?? filed?.trim();
  return listed ? issuerNames(listed).at(-1) ?? listed : null;
}

export function fiscalFields(ticker: string, periodEnd: string, map: FiscalFocusMap | null): FiscalPeriodFields {
  const key = ticker.trim().toUpperCase();
  return fiscalIdentity({ fiscalYearEndMonth: map?.issuers.get(key)?.fiscalYearEndMonth ?? null, periodEnd, xbrl: map?.focus.get(`${key}|${periodEnd}`) ?? null });
}

export function stampFlow(flow: PublicBusinessFlow, map: FiscalFocusMap | null): PublicBusinessFlow {
  return { ...flow, quarters: flow.quarters.map(quarter => ({ ...quarter, ...fiscalFields(flow.ticker, quarter.periodEnd, map) })) };
}

export function stampHistory(history: RevenueHistory, map: FiscalFocusMap | null): RevenueHistory {
  return { ...history, quarters: history.quarters.map(quarter => ({ ...quarter, ...fiscalFields(history.ticker, quarter.periodEnd, map) })) };
}
