import { ANALYSIS_API_SCHEMA_VERSION } from "../../../../shared/analysis-contract/common.ts";
import { FUNDAMENTAL_METRIC_CATALOG, FUNDAMENTAL_METRIC_CATALOG_VERSION } from "./fundamental-metrics.ts";
import { FUNDAMENTALS_API_SCHEMA_VERSION, FUNDAMENTALS_STALE_AFTER_MS, type FundamentalMetricKey, type PublicFundamentalsResponse } from "../../../../shared/analysis-contract/fundamentals.ts";
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
  gross_margin: "gross_margin", operating_margin: "operating_margin",
};

export async function getSecFundamentals(database: D1Like, query: FundamentalApiQuery): Promise<PublicFundamentalsResponse> {
  const cached = await new D1SecRepository(database).getCache<SecHistorySnapshot>(secFundamentalsKey(query.ticker));
  if (cached) return buildSecFundamentals(cached.payload, query, cached.fetchedAt);
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
  return buildSecFundamentals(historyFromRows(rows.results), query, null);
}

export async function buildSecFundamentals(history: SecHistorySnapshot, query: FundamentalApiQuery, fetchedAt: string | null, now = new Date()): Promise<PublicFundamentalsResponse> {
  const revenue = history.series.find((series) => series.seriesId === "revenue")?.quarters ?? [];
  const dates = [...new Set(revenue.map((point) => point.endDate))].sort().slice(-query.periodCount);
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
      return { periodEnd, valueDecimal: point && Number.isFinite(Number(point.value)) ? point.unit === "ratio" ? String(Number(point.value) * 100) : point.value : null, revision: null,
        ...(point ? { sourceAccession: point.sourceAccession, sourceFiledAt: point.sourceFiledAt,
          ...(point.derivationFormula ? { derivationFormula: point.derivationFormula } : {}) } : {}) };
    });
    return { metricKey, label: definition.label, shortLabel: definition.shortLabel, category: definition.category,
      unitFamily: definition.unitFamily, unit, currency, basis: candidates.some((item) => item.basis === "derived") ? "derived" as const : "reported" as const,
      displaySign: definition.displaySign, defaultMark: definition.defaultMark, allowedTransforms: definition.allowedTransforms,
      available: points.some((point) => point.valueDecimal !== null), points };
  });
  const issueCount = series.reduce((count, item) => count + item.points.filter((point) => point.valueDecimal === null).length, 0);
  const stale = !fetchedAt || !Number.isFinite(Date.parse(fetchedAt)) || now.getTime() - Date.parse(fetchedAt) >= FUNDAMENTALS_STALE_AFTER_MS;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([history.registryVersion, dates, series])));
  return {
    apiSchemaVersion: ANALYSIS_API_SCHEMA_VERSION, schemaVersion: FUNDAMENTALS_API_SCHEMA_VERSION,
    catalogVersion: FUNDAMENTAL_METRIC_CATALOG_VERSION, source: "sec_xbrl", ticker: query.ticker,
    status: dates.length ? "ready" : "pending", fetchedAt, stale,
    dataVersion: dates.length ? [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") : null,
    partial: issueCount > 0 || dates.length < query.periodCount, qualityStatus: dates.length ? issueCount || dates.length < query.periodCount ? "partial" : "complete" : null,
    issueCount, requestedPeriodCount: query.periodCount,
    periods: dates.map((periodEnd) => ({ periodType: "3M", periodEnd, currency: revenue.find((point) => point.endDate === periodEnd)?.currency ?? "" })),
    series, refresh: { recommended: stale, scheduled: false, mode: "backend_scheduled" },
  };
}
