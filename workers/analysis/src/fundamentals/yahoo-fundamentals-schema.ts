import {
  FUNDAMENTAL_METRIC_CATALOG_VERSION,
  getMetricKeyForYahooField,
  isYahooQuarterlyFundamentalField,
  type FundamentalMetricKey,
  type YahooQuarterlyFundamentalField,
} from "./fundamental-metrics.ts";

export const YAHOO_FUNDAMENTALS_SCHEMA_VERSION = "yahoo-fundamentals-timeseries.v1";

export type YahooFundamentalPeriodType = "3M" | "FY";

export type YahooFundamentalObservation = {
  ticker: string;
  metricKey: FundamentalMetricKey;
  sourceField: YahooQuarterlyFundamentalField;
  periodType: YahooFundamentalPeriodType;
  periodEnd: string;
  valueDecimal: string;
  currencyCode: string;
};

export type YahooFundamentalsParseIssue = {
  code: "unknown_field" | "invalid_symbol" | "invalid_series" | "invalid_observation" | "duplicate_observation";
  sourceField?: string;
  index?: number;
  message: string;
};

export type YahooFundamentalsPayload = {
  source: "yahoo_finance";
  schemaVersion: typeof YAHOO_FUNDAMENTALS_SCHEMA_VERSION;
  catalogVersion: typeof FUNDAMENTAL_METRIC_CATALOG_VERSION;
  ticker: string;
  receivedFields: YahooQuarterlyFundamentalField[];
  observations: YahooFundamentalObservation[];
  issues: YahooFundamentalsParseIssue[];
};

export class YahooFundamentalsPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YahooFundamentalsPayloadError";
  }
}

export function parseYahooFundamentalsPayload(payload: unknown, expectedTicker?: string): YahooFundamentalsPayload {
  const requestedTicker = expectedTicker === undefined ? "" : normalizeFundamentalTicker(expectedTicker);
  if (expectedTicker !== undefined && !requestedTicker) {
    throw new YahooFundamentalsPayloadError("Expected ticker is invalid.");
  }

  const root = asRecord(payload);
  const timeseries = asRecord(root?.timeseries);
  if (!timeseries || !Array.isArray(timeseries.result)) {
    throw new YahooFundamentalsPayloadError("Yahoo fundamentals payload shape is invalid.");
  }
  if (timeseries.error !== null && timeseries.error !== undefined) {
    throw new YahooFundamentalsPayloadError("Yahoo fundamentals payload contains an upstream error.");
  }

  const observations: YahooFundamentalObservation[] = [];
  const issues: YahooFundamentalsParseIssue[] = [];
  const receivedFields = new Set<YahooQuarterlyFundamentalField>();
  const observationKeys = new Set<string>();
  let resolvedTicker = "";

  for (const resultValue of timeseries.result) {
    const result = asRecord(resultValue);
    const meta = asRecord(result?.meta);
    const sourceField = firstString(meta?.type);
    const yahooSymbol = normalizeFundamentalTicker(firstString(meta?.symbol));

    if (!sourceField || !isYahooQuarterlyFundamentalField(sourceField)) {
      issues.push({
        code: "unknown_field",
        sourceField: sourceField || undefined,
        message: "Yahoo returned an unregistered fundamentals field.",
      });
      continue;
    }
    receivedFields.add(sourceField);

    if (!yahooSymbol || (requestedTicker && toYahooFundamentalSymbol(requestedTicker) !== yahooSymbol)) {
      issues.push({
        code: "invalid_symbol",
        sourceField,
        message: "Yahoo result symbol does not match the requested ticker.",
      });
      continue;
    }
    resolvedTicker ||= yahooSymbol;

    const series = result?.[sourceField];
    if (!Array.isArray(series)) {
      issues.push({
        code: "invalid_series",
        sourceField,
        message: "Yahoo fundamentals field is not an observation array.",
      });
      continue;
    }

    for (let index = 0; index < series.length; index += 1) {
      const parsed = parseObservation(series[index]);
      if (!parsed) {
        issues.push({
          code: "invalid_observation",
          sourceField,
          index,
          message: "Yahoo fundamentals observation is missing a valid period or numeric value.",
        });
        continue;
      }

      const metricKey = getMetricKeyForYahooField(sourceField);
      const observationKey = `${parsed.periodType}:${parsed.periodEnd}:${metricKey}`;
      if (observationKeys.has(observationKey)) {
        issues.push({
          code: "duplicate_observation",
          sourceField,
          index,
          message: "Yahoo returned a duplicate metric observation for the same period.",
        });
        continue;
      }
      observationKeys.add(observationKey);
      observations.push({
        ticker: requestedTicker || yahooSymbol,
        metricKey,
        sourceField,
        periodType: parsed.periodType,
        periodEnd: parsed.periodEnd,
        valueDecimal: String(parsed.raw),
        currencyCode: parsed.currencyCode,
      });
    }
  }

  if (!resolvedTicker) {
    throw new YahooFundamentalsPayloadError("Yahoo fundamentals payload has no usable ticker.");
  }

  observations.sort((left, right) =>
    left.periodEnd.localeCompare(right.periodEnd) || left.metricKey.localeCompare(right.metricKey));

  return {
    source: "yahoo_finance",
    schemaVersion: YAHOO_FUNDAMENTALS_SCHEMA_VERSION,
    catalogVersion: FUNDAMENTAL_METRIC_CATALOG_VERSION,
    ticker: requestedTicker || resolvedTicker,
    receivedFields: [...receivedFields].sort(),
    observations,
    issues,
  };
}

function parseObservation(value: unknown): {
  periodType: YahooFundamentalPeriodType;
  periodEnd: string;
  raw: number;
  currencyCode: string;
} | null {
  const observation = asRecord(value);
  const reportedValue = asRecord(observation?.reportedValue);
  const periodEnd = typeof observation?.asOfDate === "string" ? observation.asOfDate : "";
  const periodType = observation?.periodType;
  const raw = reportedValue?.raw;
  if (
    !isIsoDate(periodEnd)
    || (periodType !== "3M" && periodType !== "FY")
    || typeof raw !== "number"
    || !Number.isFinite(raw)
  ) return null;

  return {
    periodType,
    periodEnd,
    raw,
    currencyCode: typeof observation?.currencyCode === "string" ? observation.currencyCode.trim().toUpperCase() : "",
  };
}

export function normalizeFundamentalTicker(value: string): string {
  const ticker = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker) ? ticker : "";
}

export function toYahooFundamentalSymbol(value: string): string {
  return value.replaceAll(".", "-");
}

function firstString(value: unknown): string {
  return Array.isArray(value) && typeof value[0] === "string" ? value[0].trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
