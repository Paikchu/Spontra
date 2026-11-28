import {
  FUNDAMENTAL_METRIC_CATALOG,
  FUNDAMENTAL_METRIC_CATALOG_VERSION,
  getFundamentalMetricDefinition,
  type FundamentalMetricKey,
  type FundamentalUnitFamily,
} from "./fundamental-metrics.ts";
import {
  YAHOO_FUNDAMENTALS_SCHEMA_VERSION,
  type YahooFundamentalsPayload,
  type YahooFundamentalPeriodType,
} from "./yahoo-fundamentals-schema.ts";

export const FUNDAMENTAL_DERIVATION_VERSION = "fundamental-derivations.v1";
export const FUNDAMENTAL_MIN_QUARTER_COUNT = 2;
export const FUNDAMENTAL_COMPLETE_QUARTER_COUNT = 5;

export const FUNDAMENTAL_CORE_METRICS = Object.freeze([
  "total_revenue",
  "gross_profit",
  "operating_income",
  "net_income",
  "diluted_eps",
  "operating_cash_flow",
  "capital_expenditure",
  "free_cash_flow",
  "cash_and_cash_equivalents",
  "long_term_debt",
  "ordinary_shares",
] as const satisfies readonly FundamentalMetricKey[]);

export type FundamentalDataQuality = "complete" | "partial";

export type NormalizedFundamentalPeriod = {
  periodId: string;
  ticker: string;
  periodType: YahooFundamentalPeriodType;
  periodEnd: string;
  currency: string;
};

export type NormalizedFundamentalObservation = {
  observationId: string;
  periodId: string;
  ticker: string;
  periodType: YahooFundamentalPeriodType;
  periodEnd: string;
  metricKey: FundamentalMetricKey;
  sourceField: string | null;
  valueDecimal: string;
  unitFamily: FundamentalUnitFamily;
  unit: string;
  currency: string;
  basis: "reported" | "derived";
  derivationFormula: string | null;
  derivationVersion: string | null;
};

export type NormalizedFundamentalsSnapshot = {
  source: "yahoo_finance";
  parserVersion: typeof YAHOO_FUNDAMENTALS_SCHEMA_VERSION;
  catalogVersion: typeof FUNDAMENTAL_METRIC_CATALOG_VERSION;
  derivationVersion: typeof FUNDAMENTAL_DERIVATION_VERSION;
  ticker: string;
  qualityStatus: FundamentalDataQuality;
  issueCount: number;
  warnings: string[];
  periods: NormalizedFundamentalPeriod[];
  observations: NormalizedFundamentalObservation[];
};

export class FundamentalDataQualityError extends Error {
  readonly code: "INVALID_SYMBOL" | "INSUFFICIENT_QUARTERS" | "MISSING_LATEST_REVENUE";

  constructor(code: FundamentalDataQualityError["code"], message: string) {
    super(message);
    this.name = "FundamentalDataQualityError";
    this.code = code;
  }
}

export function normalizeYahooFundamentals(payload: YahooFundamentalsPayload): NormalizedFundamentalsSnapshot {
  if (payload.issues.some((issue) => issue.code === "invalid_symbol")) {
    throw new FundamentalDataQualityError("INVALID_SYMBOL", "Yahoo payload contains observations for another ticker.");
  }

  const warnings: string[] = [];
  const periods = new Map<string, NormalizedFundamentalPeriod>();
  const observations = new Map<string, NormalizedFundamentalObservation>();

  for (const source of payload.observations) {
    const definition = getFundamentalMetricDefinition(source.metricKey);
    if (definition.basis !== "reported") continue;

    const currencyRequired = definition.unitFamily === "currency" || definition.unitFamily === "per_share";
    const currency = currencyRequired ? source.currencyCode : "";
    if (currencyRequired && !currency) {
      warnings.push(`${source.metricKey}:${source.periodEnd}:missing_currency`);
      continue;
    }

    const periodId = buildFundamentalPeriodId(payload.ticker, source.periodType, source.periodEnd);
    const period = periods.get(periodId);
    if (!period) {
      periods.set(periodId, {
        periodId,
        ticker: payload.ticker,
        periodType: source.periodType,
        periodEnd: source.periodEnd,
        currency,
      });
    } else if (!period.currency && currency) {
      period.currency = currency;
    } else if (currency && period.currency && currency !== period.currency) {
      warnings.push(`${source.periodEnd}:mixed_currency`);
    }

    const observation = buildObservation({
      ticker: payload.ticker,
      periodId,
      periodType: source.periodType,
      periodEnd: source.periodEnd,
      metricKey: source.metricKey,
      sourceField: source.sourceField,
      valueDecimal: source.valueDecimal,
      unitFamily: definition.unitFamily,
      currency,
      basis: "reported",
      derivationFormula: null,
      derivationVersion: null,
    });
    observations.set(observation.observationId, observation);
  }

  for (const [metricKey, definition] of Object.entries(FUNDAMENTAL_METRIC_CATALOG)) {
    if (definition.basis !== "derived") continue;
    for (const period of periods.values()) {
      const numerator = observations.get(buildFundamentalObservationId(period.periodId, definition.derivation.numerator));
      const denominator = observations.get(buildFundamentalObservationId(period.periodId, definition.derivation.denominator));
      if (!numerator || !denominator) continue;
      const numeratorValue = Number(numerator.valueDecimal);
      const denominatorValue = Number(denominator.valueDecimal);
      if (!Number.isFinite(numeratorValue) || !Number.isFinite(denominatorValue) || denominatorValue === 0) {
        warnings.push(`${metricKey}:${period.periodEnd}:invalid_derivation_input`);
        continue;
      }
      const valueDecimal = canonicalDecimal((numeratorValue / denominatorValue) * definition.derivation.scale);
      const observation = buildObservation({
        ticker: payload.ticker,
        periodId: period.periodId,
        periodType: period.periodType,
        periodEnd: period.periodEnd,
        metricKey: metricKey as FundamentalMetricKey,
        sourceField: null,
        valueDecimal,
        unitFamily: definition.unitFamily,
        currency: "",
        basis: "derived",
        derivationFormula: `${definition.derivation.numerator} / ${definition.derivation.denominator} * ${definition.derivation.scale}`,
        derivationVersion: FUNDAMENTAL_DERIVATION_VERSION,
      });
      observations.set(observation.observationId, observation);
    }
  }

  const quarterPeriods = [...periods.values()]
    .filter((period) => period.periodType === "3M")
    .sort((left, right) => left.periodEnd.localeCompare(right.periodEnd));
  const revenueQuarterPeriodIds = new Set(
    [...observations.values()]
      .filter((observation) => observation.periodType === "3M" && observation.metricKey === "total_revenue")
      .map((observation) => observation.periodId),
  );
  if (revenueQuarterPeriodIds.size === 0) {
    throw new FundamentalDataQualityError(
      "MISSING_LATEST_REVENUE",
      "Yahoo payload does not contain quarterly total revenue.",
    );
  }

  const publishableQuarterPeriods = quarterPeriods.filter((period) => revenueQuarterPeriodIds.has(period.periodId));
  if (publishableQuarterPeriods.length < FUNDAMENTAL_MIN_QUARTER_COUNT) {
    throw new FundamentalDataQualityError(
      "INSUFFICIENT_QUARTERS",
      `Yahoo payload contains fewer than ${FUNDAMENTAL_MIN_QUARTER_COUNT} usable quarters.`,
    );
  }

  const excludedQuarterPeriodIds = new Set(
    quarterPeriods
      .filter((period) => !revenueQuarterPeriodIds.has(period.periodId))
      .map((period) => period.periodId),
  );
  for (const period of quarterPeriods) {
    if (excludedQuarterPeriodIds.has(period.periodId)) {
      warnings.push(`${period.periodEnd}:incomplete_quarter_excluded`);
    }
  }

  const publishedPeriods = [...periods.values()].filter((period) =>
    period.periodType !== "3M" || revenueQuarterPeriodIds.has(period.periodId));
  const publishedObservations = [...observations.values()].filter((observation) =>
    observation.periodType !== "3M" || revenueQuarterPeriodIds.has(observation.periodId));
  const latestQuarter = publishableQuarterPeriods.at(-1)!;
  const latestMetricKeys = new Set(
    publishedObservations
      .filter((observation) => observation.periodId === latestQuarter.periodId)
      .map((observation) => observation.metricKey),
  );

  const issueCount = payload.issues.length + warnings.length;
  const isComplete = publishableQuarterPeriods.length >= FUNDAMENTAL_COMPLETE_QUARTER_COUNT
    && issueCount === 0
    && FUNDAMENTAL_CORE_METRICS.every((metricKey) => latestMetricKeys.has(metricKey));

  return {
    source: "yahoo_finance",
    parserVersion: YAHOO_FUNDAMENTALS_SCHEMA_VERSION,
    catalogVersion: FUNDAMENTAL_METRIC_CATALOG_VERSION,
    derivationVersion: FUNDAMENTAL_DERIVATION_VERSION,
    ticker: payload.ticker,
    qualityStatus: isComplete ? "complete" : "partial",
    issueCount,
    warnings,
    periods: publishedPeriods.sort((left, right) =>
      left.periodEnd.localeCompare(right.periodEnd) || left.periodType.localeCompare(right.periodType)),
    observations: publishedObservations.sort((left, right) =>
      left.periodEnd.localeCompare(right.periodEnd) || left.metricKey.localeCompare(right.metricKey)),
  };
}

export function buildFundamentalPeriodId(
  ticker: string,
  periodType: YahooFundamentalPeriodType,
  periodEnd: string,
): string {
  return `yahoo:${ticker}:${periodType}:${periodEnd}`;
}

export function buildFundamentalObservationId(periodId: string, metricKey: string): string {
  return `${periodId}:${metricKey}`;
}

function buildObservation(input: Omit<NormalizedFundamentalObservation, "observationId" | "unit">): NormalizedFundamentalObservation {
  return {
    ...input,
    observationId: buildFundamentalObservationId(input.periodId, input.metricKey),
    unit: unitFor(input.unitFamily, input.currency),
  };
}

function unitFor(unitFamily: FundamentalUnitFamily, currency: string): string {
  if (unitFamily === "currency") return currency;
  if (unitFamily === "per_share") return `${currency}/share`;
  if (unitFamily === "shares") return "shares";
  // A multiple is a bare ratio, so it carries no currency of its own even when
  // both sides of the ratio are priced in one.
  if (unitFamily === "multiple") return "x";
  return "%";
}

function canonicalDecimal(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Fundamental derived value is not finite.");
  return value.toFixed(8).replace(/\.?0+$/, "");
}
