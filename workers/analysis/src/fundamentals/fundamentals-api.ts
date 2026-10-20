import { isFundamentalMetricKey, type FundamentalMetricKey } from "./fundamental-metrics.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { FUNDAMENTALS_API_SCHEMA_VERSION, FUNDAMENTALS_DEFAULT_PERIOD_COUNT, FUNDAMENTALS_MAX_PERIOD_COUNT, FUNDAMENTALS_MIN_PERIOD_COUNT, FUNDAMENTALS_STALE_AFTER_MS } from "../../../../shared/analysis-contract/fundamentals.ts";
import { normalizeFundamentalTicker } from "./yahoo-fundamentals-schema.ts";

/**
 * The fundamentals read query. It touches a repository, so it belongs to the analysis backend; the
 * wire types it used to declare now live in `lib/analysis-contract/fundamentals.ts` and are
 * re-exported here so existing importers keep resolving.
 */
export {
  FUNDAMENTALS_API_SCHEMA_VERSION,
  FUNDAMENTALS_DEFAULT_PERIOD_COUNT,
  FUNDAMENTALS_MAX_PERIOD_COUNT,
  FUNDAMENTALS_MIN_PERIOD_COUNT,
  FUNDAMENTALS_STALE_AFTER_MS,
};

export type FundamentalApiQuery = {
  ticker: string;
  metricKeys: FundamentalMetricKey[] | null;
  periodCount: number;
};

export function parseFundamentalApiQuery(
  rawTicker: string,
  searchParams: URLSearchParams,
): FundamentalApiQuery {
  const ticker = normalizeFundamentalTicker(rawTicker);
  if (!ticker) {
    throw new AnalysisRequestError("INVALID_TICKER", "Ticker is invalid.");
  }

  const rawMetricQueries = searchParams.getAll("metrics");
  if (rawMetricQueries.length > 1) {
    throw new AnalysisRequestError("INVALID_METRICS", "Metrics must be supplied once.");
  }
  const metricKeys = rawMetricQueries.length === 0 ? null : parseMetricKeys(rawMetricQueries[0]!);

  const rawPeriodCounts = searchParams.getAll("periodCount");
  if (rawPeriodCounts.length > 1) {
    throw new AnalysisRequestError("INVALID_PERIOD_COUNT", "Period count must be supplied once.");
  }
  const periodCount = rawPeriodCounts.length === 0
    ? FUNDAMENTALS_DEFAULT_PERIOD_COUNT
    : parsePeriodCount(rawPeriodCounts[0]!);

  return { ticker, metricKeys, periodCount };
}





function parseMetricKeys(rawValue: string): FundamentalMetricKey[] {
  const values = rawValue.split(",").map((value) => value.trim());
  if (values.length === 0 || values.some((value) => !value || !isFundamentalMetricKey(value))) {
    throw new AnalysisRequestError("INVALID_METRICS", "Metrics contain an unknown metric key.");
  }
  return [...new Set(values as FundamentalMetricKey[])];
}

function parsePeriodCount(rawValue: string): number {
  if (!/^\d{1,2}$/.test(rawValue)) {
    throw new AnalysisRequestError("INVALID_PERIOD_COUNT", "Period count is invalid.");
  }
  const value = Number(rawValue);
  if (value < FUNDAMENTALS_MIN_PERIOD_COUNT || value > FUNDAMENTALS_MAX_PERIOD_COUNT) {
    throw new AnalysisRequestError(
      "INVALID_PERIOD_COUNT",
      `Period count must be between ${FUNDAMENTALS_MIN_PERIOD_COUNT} and ${FUNDAMENTALS_MAX_PERIOD_COUNT}.`,
    );
  }
  return value;
}
