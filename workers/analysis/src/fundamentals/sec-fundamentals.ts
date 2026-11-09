import type {RevenueHistoryQuarter} from "../../../../shared/analysis-contract/revenue-history.ts";
import {historyForIssuer, historyKey} from "../financial-data/history.ts";
import { ANALYSIS_API_SCHEMA_VERSION } from "../../../../shared/analysis-contract/common.ts";
import { FUNDAMENTAL_METRIC_CATALOG, FUNDAMENTAL_METRIC_CATALOG_VERSION } from "./fundamental-metrics.ts";
import { FUNDAMENTALS_API_SCHEMA_VERSION, FUNDAMENTALS_STALE_AFTER_MS, type FundamentalMetricKey, type FundamentalsUnavailableReason, type PublicFundamentalsResponse } from "../../../../shared/analysis-contract/fundamentals.ts";
import { latestFundamentalsQuarter } from "../../../../shared/analysis-runtime/fundamentals-freshness.ts";
import type { FundamentalApiQuery } from "./fundamentals-api.ts";
import type { HistoricalObservation, SecHistorySnapshot } from "../sec/analysis.ts";
import { D1SecRepository, historyFromRows } from "../sec/d1.ts";
import type { D1Like } from "../sec/d1-support.ts";

export const secFundamentalsKey = (ticker: string) => `sec:fundamentals:${ticker}`;

// Do not equate SEC total debt / diluted weighted shares with Yahoo long-term debt / ordinary shares.
const SERIES: Partial<Record<HistoricalObservation["seriesId"], FundamentalMetricKey>> = {
  revenue: "total_revenue", gross_profit: "gross_profit", operating_income: "operating_income",
  net_income: "net_income", diluted_eps: "diluted_eps", operating_cash_flow: "operating_cash_flow",
  capex: "capital_expenditure", free_cash_flow: "free_cash_flow", cash: "cash_and_cash_equivalents",
  gross_margin: "gross_margin", operating_margin: "operating_margin", rpo: "remaining_performance_obligation",
  depreciation: "depreciation_and_amortization", stock_compensation: "stock_based_compensation", total_assets: "total_assets", total_liabilities: "total_liabilities",
  equity: "stockholders_equity", receivables: "accounts_receivable", inventory: "inventory", long_term_debt: "long_term_debt", shares: "ordinary_shares",
  buybacks: "share_repurchases", dividends: "dividends_paid",
  equity_securities_gains: "equity_securities_gains", interest_income: "nonoperating_interest_income", interest_expense: "nonoperating_interest_expense", fx_gains: "foreign_exchange_gains",
};
/** Series that also carry their fiscal-year totals, for shareholder returns read over full years against free cash flow and stock pay. */
const ANNUAL: ReadonlySet<FundamentalMetricKey> = new Set(["share_repurchases", "dividends_paid", "free_cash_flow", "operating_cash_flow", "capital_expenditure", "stock_based_compensation"]);
const ANNUAL_YEARS = 4;
const FLOW_CATEGORIES = new Set(["income_statement", "cash_flow"]);

export async function getSecFundamentals(database: D1Like, query: FundamentalApiQuery): Promise<PublicFundamentalsResponse> {
  const repository = new D1SecRepository(database);
  const cached = await repository.getCache<SecHistorySnapshot>(secFundamentalsKey(query.ticker));
  const issuer = await database.prepare("SELECT cik FROM sec_filings WHERE ticker = ? ORDER BY filing_date DESC LIMIT 1").bind(query.ticker).first<{cik: string}>()
    ?? await database.prepare(`SELECT COALESCE(
      (SELECT cik FROM financial_collection_jobs WHERE ticker=? ORDER BY generation DESC LIMIT 1),
      (SELECT v.cik FROM financial_complete_current c JOIN financial_complete_versions v ON v.version_id=c.version_id WHERE v.ticker=? LIMIT 1),
      (SELECT json_extract(payload,'$.cik') FROM sec_cache WHERE cache_key='admin:financial-issuer:'||? AND json_valid(payload)),
      (SELECT substr(cache_key,length('sec:revenue-history:v1:')+1) FROM sec_cache WHERE cache_key LIKE 'sec:revenue-history:v1:%' AND json_valid(payload) AND json_extract(payload,'$.ticker')=? LIMIT 1)
    ) cik`).bind(query.ticker,query.ticker,query.ticker,query.ticker).first<{cik:string}>();
  const revenueHistory = issuer?.cik ? historyForIssuer((await repository.getCache(historyKey(issuer.cik)))?.payload, issuer.cik, query.ticker) : null;
  if (cached) return buildSecFundamentals(cached.payload, query, cached.fetchedAt, new Date(), revenueHistory?.quarters);
  // Existing companies can display previously ingested SEC facts before the next discovery sweep.
  const rows = await database.prepare(`
    SELECT fact_id AS observationId, series_id AS seriesId, metric_key AS metricKey,
      value_decimal AS value, unit, currency, basis, observation_start AS startDate,
      observation_end AS endDate, source_accession AS sourceAccession,
      source_filed_at AS sourceFiledAt, source_version AS sourceVersion,
      xbrl_concept AS xbrlConcept, derivation_formula AS derivationFormula, dimensions
    FROM sec_facts
    WHERE filing_id IN (SELECT filing_id FROM sec_filings WHERE ticker = ?)
      AND quality_status = 'validated_xbrl' AND source_version != 'legacy_unvalidated'
    ORDER BY observation_end DESC, source_filed_at DESC
  `).bind(query.ticker).all<Parameters<typeof historyFromRows>[0][number]>();
  return buildSecFundamentals(historyFromRows(rows.results), query, null, new Date(), revenueHistory?.quarters);
}

async function buildSecFundamentals(history: SecHistorySnapshot, query: FundamentalApiQuery, fetchedAt: string | null, now = new Date(), releaseQuarters: RevenueHistoryQuarter[] = []): Promise<PublicFundamentalsResponse> {
  history = withReleaseEps(history, releaseQuarters);
  const revenue = history.series.find((series) => series.seriesId === "revenue")?.quarters ?? [];
  // Revenue may be absent even when a quarter's other statements were disclosed. Keep the
  // period visible with null revenue instead of hiding every metric from that period.
  const quarterIndex = (date: string) => {
    const parsed = new Date(`${date}T00:00:00Z`);
    return parsed.getUTCFullYear() * 4 + Math.floor(parsed.getUTCMonth() / 3);
  };
  const reportedDates = [...new Set(history.series.filter((series) => SERIES[series.seriesId]).flatMap((series) => series.quarters)
    .filter((point) => point.qualityStatus === "validated_xbrl" && Number.isFinite(Date.parse(point.endDate)))
    .map((point) => point.endDate))].sort();
  const latestDate = reportedDates.at(-1);
  // Reserve each consecutive calendar quarter. Keep actual SEC period ends (including
  // 52/53-week filers); only absent quarters get a synthetic calendar-quarter end.
  const dates = latestDate ? Array.from({ length: query.periodCount }, (_, index) => {
    const quarter = quarterIndex(latestDate) - query.periodCount + 1 + index;
    return reportedDates.findLast(date => quarterIndex(date) === quarter)
      ?? new Date(Date.UTC(Math.floor(quarter / 4), (quarter % 4 + 1) * 3, 0)).toISOString().slice(0, 10);
  }) : [];
  const keys = query.metricKeys ?? Object.values(SERIES);
  const series = keys.map((metricKey) => {
    const definition = FUNDAMENTAL_METRIC_CATALOG[metricKey];
    const source = history.series.find((item) => SERIES[item.seriesId] === metricKey);
    const candidates = [...(source?.quarters ?? [])].filter((item) => {
      if (!dates.includes(item.endDate) || item.qualityStatus !== "validated_xbrl") return false;
      if (definition.unitFamily === "currency") return Boolean(item.currency) && item.unit === item.currency;
      if (definition.unitFamily === "per_share") return Boolean(item.currency) && item.unit === `${item.currency}/shares`;
      return item.unit === "ratio" || item.unit === "%";
    }).sort((a, b) => b.sourceFiledAt.localeCompare(a.sourceFiledAt));
    const latest = [...candidates].sort((a, b) => b.endDate.localeCompare(a.endDate))[0];
    const currency = latest?.currency ?? "";
    const unit = definition.unitFamily === "percent" ? "%" : latest?.unit ?? "";
    const points = dates.map((periodEnd) => {
      // A single series must never silently mix currencies or units.
      const point = candidates.find((item) => item.endDate === periodEnd && (item.currency ?? "") === currency && item.unit === latest?.unit);
      const valueDecimal = point && point.value != null && String(point.value).trim() !== "" && Number.isFinite(Number(point.value))
        ? point.unit === "ratio" ? String(Number(point.value) * 100) : point.value : null;
      return { periodEnd, valueDecimal, revision: null, missing: valueDecimal === null,
        ...(point ? { sourceAccession: point.sourceAccession, sourceFiledAt: point.sourceFiledAt,
          ...(point.derivationFormula ? { derivationFormula: point.derivationFormula } : {}) } : {}) };
    });
    // Fiscal years as filed in the 10-K / 20-F: one twelve-month value per year end, in the series' own currency and unit.
    const annual = ANNUAL.has(metricKey) && latest ? [...new Map((source?.annual ?? [])
      .filter((item) => item.qualityStatus === "validated_xbrl" && item.startDate && item.unit === latest.unit && (item.currency ?? "") === currency && Number.isFinite(Number(item.value)))
      .sort((a, b) => b.endDate.localeCompare(a.endDate) || b.sourceFiledAt.localeCompare(a.sourceFiledAt))
      .map((item) => [item.endDate, item] as const)).values()].slice(0, ANNUAL_YEARS).reverse()
      .map((item) => ({ periodStart: item.startDate!, periodEnd: item.endDate, valueDecimal: item.value, sourceAccession: item.sourceAccession })) : null;
    return { metricKey, label: definition.label, shortLabel: definition.shortLabel, category: definition.category,
      unitFamily: definition.unitFamily, unit, currency, basis: candidates.some((item) => item.basis === "derived") ? "derived" as const : "reported" as const,
      displaySign: definition.displaySign, defaultMark: definition.defaultMark, allowedTransforms: definition.allowedTransforms,
      available: points.some((point) => point.valueDecimal !== null), points, ...(annual?.length ? { annual } : {}) };
  });
  // Periods with no income-statement or cash-flow value anywhere (only year-end balances copied from annual reports): no
  // metric to show, and the reason is the filer's, not a refresh still to come.
  const empty = dates.length > 0 && latestFundamentalsQuarter(series) == null;
  const unavailableReason: FundamentalsUnavailableReason | null = !empty ? null
    : history.series.some((item) => FLOW_CATEGORIES.has(FUNDAMENTAL_METRIC_CATALOG[SERIES[item.seriesId]!]?.category ?? "") && item.annual.some((point) => point.qualityStatus === "validated_xbrl"))
      ? "annual_only" : "no_quarterly_values";
  const issueCount = series.reduce((count, item) => count + item.points.filter((point) => point.valueDecimal === null).length, 0);
  const stale = !fetchedAt || !Number.isFinite(Date.parse(fetchedAt)) || now.getTime() - Date.parse(fetchedAt) >= FUNDAMENTALS_STALE_AFTER_MS;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([history.registryVersion, dates, series])));
  return {
    apiSchemaVersion: ANALYSIS_API_SCHEMA_VERSION, schemaVersion: FUNDAMENTALS_API_SCHEMA_VERSION,
    catalogVersion: FUNDAMENTAL_METRIC_CATALOG_VERSION, source: "sec_xbrl", ticker: query.ticker,
    status: unavailableReason ? "unavailable" : dates.length ? "ready" : "pending", ...(unavailableReason ? { unavailableReason } : {}), fetchedAt, stale,
    dataVersion: dates.length ? [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") : null,
    partial: issueCount > 0 || dates.length < query.periodCount, qualityStatus: dates.length ? issueCount || dates.length < query.periodCount ? "partial" : "complete" : null,
    issueCount, requestedPeriodCount: query.periodCount,
    periods: dates.map((periodEnd) => ({ periodType: "3M", periodEnd, currency: revenue.find((point) => point.endDate === periodEnd)?.currency
      ?? history.series.flatMap((item) => item.quarters).find((point) => point.endDate === periodEnd && point.currency)?.currency ?? "" })),
    series, refresh: { recommended: stale, scheduled: false, mode: "backend_scheduled" },
  };
}

/** A release's printed quarterly EPS fills holes only; EPS is never an additive FY-minus-nine-month measure. */
function withReleaseEps(history: SecHistorySnapshot, quarters: RevenueHistoryQuarter[]): SecHistorySnapshot {
  const existing = history.series.find(s => s.seriesId === "diluted_eps");
  const additions: HistoricalObservation[] = quarters.flatMap(q => {
    const eps = q.dilutedEps;
    if (!eps || existing?.quarters.some(p => p.endDate === q.periodEnd && p.value != null && String(p.value).trim() !== "" && Number.isFinite(Number(p.value)))) return [];
    return [{ observationId: `release-eps:${eps.source.accession}:${q.periodEnd}`, seriesId: "diluted_eps", metricKey: "diluted_eps", value: eps.value, unit: `${q.currency}/shares`, currency: q.currency,
      basis: "gaap", periodScope: "quarter", startDate: q.periodStart, endDate: q.periodEnd, sourceAccession: eps.source.accession, sourceFiledAt: eps.source.filedAt, sourceVersion: "release-history.v1", qualityStatus: "validated_xbrl", xbrlConcept: "release:EarningsPerShareDiluted" }];
  });
  if (!additions.length) return history;
  const ends = new Set(additions.map(p => p.endDate));
  return { ...history, series: [...history.series.filter(s => s.seriesId !== "diluted_eps"), { seriesId: "diluted_eps", annual: existing?.annual ?? [], quarters: [...(existing?.quarters ?? []).filter(p => !ends.has(p.endDate)), ...additions] }] };
}
