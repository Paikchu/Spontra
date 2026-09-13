import { hashString, type HistoricalObservation, type SecCanonicalSeriesId, type SecHistorySnapshot } from "./analysis.ts";

export const COMPANY_FACTS_REGISTRY_VERSION = "sec-canonical-series.v1";

type RegistryEntry = {
  seriesId: SecCanonicalSeriesId;
  concepts: string[];
};

export const SEC_CANONICAL_SERIES_REGISTRY: RegistryEntry[] = [
  { seriesId: "revenue", concepts: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"] },
  { seriesId: "gross_profit", concepts: ["GrossProfit"] },
  { seriesId: "operating_income", concepts: ["OperatingIncomeLoss"] },
  { seriesId: "net_income", concepts: ["NetIncomeLoss", "ProfitLoss"] },
  { seriesId: "diluted_eps", concepts: ["EarningsPerShareDiluted"] },
  { seriesId: "operating_cash_flow", concepts: ["NetCashProvidedByUsedInOperatingActivities"] },
  // PaymentsToAcquireProductiveAssets is what issuers use once capex covers intangibles too;
  // NVDA switched to it in 2020 and its capex series silently stopped there.
  { seriesId: "capex", concepts: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsForAdditionsToPropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"] },
  { seriesId: "cash", concepts: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"] },
  { seriesId: "debt", concepts: ["LongTermDebtAndFinanceLeaseObligations", "LongTermDebt", "DebtAndFinanceLeaseObligations"] },
  { seriesId: "shares", concepts: ["CommonStockSharesOutstanding", "WeightedAverageNumberOfDilutedSharesOutstanding"] },
];

/** A duration fact that covers more than one quarter, kept only long enough to be differenced. */
type CumulativeObservation = HistoricalObservation & { cumulativeDays?: number; conceptPriority?: number };

type RawObservation = {
  start?: unknown;
  end?: unknown;
  val?: unknown;
  accn?: unknown;
  filed?: unknown;
  form?: unknown;
  frame?: unknown;
  fy?: unknown;
  fp?: unknown;
};

export function normalizeCompanyFacts(ticker: string, payload: unknown): SecHistorySnapshot {
  const root = record(payload);
  const taxonomies = record(root?.facts);
  const observations: CumulativeObservation[] = [];
  for (const registry of SEC_CANONICAL_SERIES_REGISTRY) {
    for (const [priority, concept] of registry.concepts.entries()) {
      for (const [taxonomy, taxonomyValue] of Object.entries(taxonomies ?? {})) {
        const conceptRoot = record(record(taxonomyValue)?.[concept]);
        const units = record(conceptRoot?.units);
        for (const [unit, rawUnits] of Object.entries(units ?? {})) {
          if (!Array.isArray(rawUnits)) continue;
          for (const raw of latestRevisions(rawUnits, concept, unit)) {
            const normalized = normalizeObservation(ticker, registry.seriesId, taxonomy, concept, unit, raw, priority);
            if (normalized) observations.push(normalized);
          }
        }
      }
    }
  }
  const deduped = chooseCanonicalConcept(observations);
  const reported = deduped.filter((item) => item.cumulativeDays === undefined).map(withoutCumulativeMarker);
  // Year-end balance sheet instants are also the fourth quarter's closing balance.
  reported.push(...reported.filter((item) => item.periodScope === "annual" && !item.startDate)
    .map((item) => ({ ...item, periodScope: "quarter" as const, observationId: `${item.observationId}:quarter` })));
  const fromCumulative = deriveQuartersFromCumulative(ticker, deduped);
  const base = [...reported, ...fromCumulative];
  const derived = deriveObservations(ticker, base);
  const all = [...base, ...derived];
  return {
    registryVersion: COMPANY_FACTS_REGISTRY_VERSION,
    series: [...new Set(all.map((item) => item.seriesId))].sort().map((seriesId) => ({
      seriesId,
      quarters: all.filter((item) => item.seriesId === seriesId && item.periodScope === "quarter").sort(newestFirst).slice(0, 8),
      annual: all.filter((item) => item.seriesId === seriesId && item.periodScope === "annual").sort(newestFirst).slice(0, 5),
    })),
  };
}

function latestRevisions(values: unknown[], concept: string, unit: string): RawObservation[] {
  const revisions = new Map<string, RawObservation>();
  for (const value of values) {
    const raw = record(value) as RawObservation | null;
    if (!raw || !/^(10-Q|10-K|20-F)(\/A)?$/.test(String(raw.form ?? ""))) continue;
    const key = `${concept}:${unit}:${String(raw.start ?? "instant")}:${String(raw.end ?? "")}`;
    const previous = revisions.get(key);
    if (!previous || revisionKey(raw) > revisionKey(previous)) revisions.set(key, raw);
  }
  return [...revisions.values()];
}

function normalizeObservation(
  ticker: string,
  seriesId: SecCanonicalSeriesId,
  taxonomy: string,
  concept: string,
  unit: string,
  raw: RawObservation,
  conceptPriority: number,
): CumulativeObservation | null {
  const endDate = isoDate(raw.end);
  const startDate = isoDate(raw.start);
  const value = numericText(raw.val);
  const sourceAccession = String(raw.accn ?? "").trim();
  const sourceFiledAt = isoDate(raw.filed);
  if (!endDate || value === null || !sourceAccession || !sourceFiledAt) return null;
  const durationDays = startDate ? daysBetween(startDate, endDate) : null;
  if (durationDays !== null && (durationDays < 60 || durationDays > 380)) return null;
  const annualForm = /^(10-K|20-F)/.test(String(raw.form ?? ""));
  const annual = durationDays !== null ? durationDays >= 250 && annualForm : annualForm;
  // Cash flow statements in a 10-Q are reported year-to-date, so the quarter has to be recovered
  // by differencing successive cumulative facts rather than read off directly.
  const cumulativeDays = durationDays !== null && durationDays > 130 && !annual ? durationDays : undefined;
  const periodScope = annual ? "annual" : "quarter";
  const currency = /^(USD|EUR|GBP|JPY|CNY|CAD|AUD)(?:\/shares)?$/i.exec(unit)?.[1]?.toUpperCase();
  const observationKey = `${ticker}:${seriesId}:${unit}:${startDate ?? "instant"}:${endDate}:${sourceAccession}`;
  return {
    observationId: `xbrl:${hashString(observationKey)}`,
    seriesId,
    metricKey: seriesId,
    value,
    unit,
    currency,
    basis: "gaap",
    periodScope,
    startDate: startDate ?? undefined,
    endDate,
    sourceAccession,
    sourceFiledAt,
    sourceVersion: COMPANY_FACTS_REGISTRY_VERSION,
    qualityStatus: "validated_xbrl",
    xbrlConcept: `${taxonomy}:${concept}`,
    conceptPriority,
    ...(cumulativeDays === undefined ? {} : { cumulativeDays }),
  };
}

function chooseCanonicalConcept(observations: CumulativeObservation[]): CumulativeObservation[] {
  const selected = new Map<string, CumulativeObservation>();
  for (const observation of observations) {
    const key = `${observation.seriesId}:${observation.periodScope}:${observation.startDate ?? "instant"}:${observation.endDate}:${observation.unit}`;
    const previous = selected.get(key);
    const priority = observation.conceptPriority ?? 99;
    const previousPriority = previous?.conceptPriority ?? 99;
    if (!previous || priority < previousPriority || (priority === previousPriority && observation.sourceFiledAt > previous.sourceFiledAt)) selected.set(key, observation);
  }
  return [...selected.values()].map((observation) => {
    const { conceptPriority, ...withoutPriority } = observation;
    void conceptPriority;
    return withoutPriority;
  });
}

function withoutCumulativeMarker(observation: CumulativeObservation): HistoricalObservation {
  const { cumulativeDays, ...rest } = observation;
  void cumulativeDays;
  return rest;
}

/**
 * Recovers single-quarter values from year-to-date facts by subtracting the preceding cumulative
 * fact in the same fiscal year. Skipped where the issuer already tagged the quarter directly.
 */
function deriveQuartersFromCumulative(ticker: string, observations: CumulativeObservation[]): HistoricalObservation[] {
  const reportedQuarters = new Set(observations
    .filter((item) => item.cumulativeDays === undefined && item.periodScope === "quarter")
    .map((item) => `${item.seriesId}:${item.endDate}:${item.unit}`));
  const groups = new Map<string, CumulativeObservation[]>();
  for (const observation of observations) {
    if (!observation.startDate || observation.seriesId === "diluted_eps" || observation.seriesId === "shares") continue;
    const key = `${observation.seriesId}:${observation.unit}:${observation.currency ?? ""}:${observation.xbrlConcept}:${observation.startDate}`;
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  const derived: HistoricalObservation[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => left.endDate.localeCompare(right.endDate));
    for (const [index, current] of ordered.entries()) {
      const previous = ordered[index - 1];
      if ((current.cumulativeDays === undefined && current.periodScope !== "annual") || !previous) continue;
      if (reportedQuarters.has(`${current.seriesId}:${current.endDate}:${current.unit}`)) continue;
      // Only a one-quarter gap yields a quarter. If an intermediate cumulative fact is missing the
      // difference spans several quarters, which must not be published as a single-quarter value.
      const gap = daysBetween(previous.endDate, current.endDate);
      if (gap < 60 || gap > 130) continue;
      const value = numericDifference(current.value, previous.value);
      if (value === null) continue;
      const formula = `${current.seriesId}[${current.startDate}..${current.endDate}] - ${current.seriesId}[${previous.startDate}..${previous.endDate}]`;
      derived.push({
        ...derivedObservation(ticker, current.seriesId, "quarter", current.endDate, current, value, current.unit, formula),
        startDate: dayAfter(previous.endDate),
      });
    }
  }
  return derived;
}

function numericDifference(current: string, previous: string): string | null {
  const left = Number(current);
  const right = Number(previous);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return String(left - right);
}

function dayAfter(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function deriveObservations(ticker: string, observations: HistoricalObservation[]): HistoricalObservation[] {
  const derived: HistoricalObservation[] = [];
  for (const scope of ["quarter", "annual"] as const) {
    const dates = [...new Set(observations.filter((item) => item.periodScope === scope).map((item) => item.endDate))];
    for (const endDate of dates) {
      deriveRatio(ticker, observations, derived, scope, endDate, "gross_margin", "gross_profit", "revenue");
      deriveRatio(ticker, observations, derived, scope, endDate, "operating_margin", "operating_income", "revenue");
      deriveDifference(ticker, observations, derived, scope, endDate, "free_cash_flow", "operating_cash_flow", "capex");
    }
  }
  return derived;
}

function deriveRatio(
  ticker: string,
  observations: HistoricalObservation[],
  output: HistoricalObservation[],
  scope: "quarter" | "annual",
  endDate: string,
  seriesId: "gross_margin" | "operating_margin",
  numeratorId: SecCanonicalSeriesId,
  denominatorId: SecCanonicalSeriesId,
) {
  const [numerator, denominator] = compatiblePair(observations, scope, endDate, numeratorId, denominatorId);
  const numeratorValue = numerator ? Number(numerator.value) : NaN;
  const denominatorValue = denominator ? Number(denominator.value) : NaN;
  if (!numerator || !denominator || !Number.isFinite(numeratorValue) || !Number.isFinite(denominatorValue) || denominatorValue === 0) return;
  output.push(derivedObservation(ticker, seriesId, scope, endDate, numerator, String(numeratorValue / denominatorValue), "ratio", `${numeratorId}/${denominatorId}`));
}

function deriveDifference(
  ticker: string,
  observations: HistoricalObservation[],
  output: HistoricalObservation[],
  scope: "quarter" | "annual",
  endDate: string,
  seriesId: "free_cash_flow",
  minuendId: SecCanonicalSeriesId,
  subtrahendId: SecCanonicalSeriesId,
) {
  const [minuend, subtrahend] = compatiblePair(observations, scope, endDate, minuendId, subtrahendId);
  const left = minuend ? Number(minuend.value) : NaN;
  const right = subtrahend ? Number(subtrahend.value) : NaN;
  if (!minuend || !subtrahend || !Number.isFinite(left) || !Number.isFinite(right)) return;
  output.push(derivedObservation(ticker, seriesId, scope, endDate, minuend, String(left - right), minuend.unit, `${minuendId}-${subtrahendId}`));
}

function compatiblePair(
  observations: HistoricalObservation[],
  scope: "quarter" | "annual",
  endDate: string,
  leftId: SecCanonicalSeriesId,
  rightId: SecCanonicalSeriesId,
): [HistoricalObservation | undefined, HistoricalObservation | undefined] {
  const left = observations.find((item) => item.seriesId === leftId && item.periodScope === scope && item.endDate === endDate);
  const right = observations.find((item) => item.seriesId === rightId && item.periodScope === scope && item.endDate === endDate && item.startDate === left?.startDate);
  if (!left || !right || left.unit !== right.unit || (left.currency ?? "") !== (right.currency ?? "") || left.basis !== right.basis) return [undefined, undefined];
  return [left, right];
}

function derivedObservation(
  ticker: string,
  seriesId: SecCanonicalSeriesId,
  periodScope: "quarter" | "annual",
  endDate: string,
  source: HistoricalObservation,
  value: string,
  unit: string,
  formula: string,
): HistoricalObservation {
  return {
    observationId: `derived:${hashString(`${ticker}:${seriesId}:${periodScope}:${endDate}:${formula}`)}`,
    seriesId,
    metricKey: seriesId,
    value,
    unit,
    currency: unit === "ratio" ? undefined : source.currency,
    basis: "derived",
    periodScope,
    startDate: source.startDate,
    endDate,
    sourceAccession: source.sourceAccession,
    sourceFiledAt: source.sourceFiledAt,
    sourceVersion: COMPANY_FACTS_REGISTRY_VERSION,
    qualityStatus: "validated_xbrl",
    derivationFormula: formula,
  };
}

function revisionKey(raw: RawObservation): string {
  return `${String(raw.filed ?? "")}:${String(raw.accn ?? "")}`;
}

function numericText(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) ? String(value) : null;
}

function isoDate(value: unknown): string | null {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function daysBetween(start: string, end: string): number {
  return Math.round((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86_400_000) + 1;
}

function newestFirst(left: HistoricalObservation, right: HistoricalObservation): number {
  return right.endDate.localeCompare(left.endDate) || right.sourceFiledAt.localeCompare(left.sourceFiledAt);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}
