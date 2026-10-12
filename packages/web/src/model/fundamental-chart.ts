import {
  FUNDAMENTAL_CHART_MAX_AXES,
  FUNDAMENTAL_CHART_MAX_SERIES,
} from "../../../../shared/analysis-contract/fundamentals.ts";
import type {
  FundamentalChartMark,
  FundamentalMetricKey,
  FundamentalTransform,
  FundamentalUnitFamily,
} from "./fundamental-metrics.ts";
import type {
  PublicFundamentalPeriod,
  PublicFundamentalSeries,
} from "../../../../shared/analysis-contract/fundamentals.ts";
// Defined in the contract so the Pipeline enforces the same ceilings; re-exported so every
// existing consumer keeps its import path.
export { FUNDAMENTAL_CHART_MAX_AXES, FUNDAMENTAL_CHART_MAX_SERIES };
export const FUNDAMENTAL_CHART_WIDTH = 760;
export const FUNDAMENTAL_CHART_HEIGHT = 280;

/**
 * Marker for a meaningless growth rate, and its spoken form. Growth is undefined
 * when the base is zero or negative; the convention is NM (not meaningful), not the same dash
 * used for "no data this period".
 */
export const FUNDAMENTAL_NOT_MEANINGFUL_LABEL = "NM";
export const FUNDAMENTAL_NOT_MEANINGFUL_HINT = "Not meaningful";

export type FundamentalChartAxisSide = "left" | "right";

export type FundamentalChartSeriesSpec = {
  metricKey: FundamentalMetricKey;
  transform?: FundamentalTransform;
  mark?: FundamentalChartMark;
  axis?: FundamentalChartAxisSide;
};

/**
 * Why a point is empty. "missing" means no data for the period; "not_meaningful" means the data
 * is complete but the base is zero or negative, so growth is undefined (a swing to profit, a
 * widening loss). Both arrive as value: null; only this field tells them apart, and the page uses
 * it to show "—" or "NM".
 */
export type FundamentalChartUnavailableReason = "missing" | "not_meaningful";

export type FundamentalChartPoint = {
  periodEnd: string;
  value: number | null;
  // Null when value is a number; always set when value is null.
  unavailableReason: FundamentalChartUnavailableReason | null;
  sourceValueDecimal: string | null;
};

export type PreparedFundamentalSeries = {
  id: string;
  metricKey: FundamentalMetricKey;
  label: string;
  shortLabel: string;
  transform: FundamentalTransform;
  mark: FundamentalChartMark;
  axis: FundamentalChartAxisSide;
  axisKey: string;
  unitFamily: FundamentalUnitFamily;
  unit: string;
  currency: string;
  points: FundamentalChartPoint[];
};

export type FundamentalChartAxis = {
  side: FundamentalChartAxisSide;
  key: string;
  unitFamily: FundamentalUnitFamily;
  unit: string;
  currency: string;
  domain: readonly [number, number];
  ticks: number[];
  includeZero: boolean;
};

export type FundamentalChartModel = {
  periods: PublicFundamentalPeriod[];
  series: PreparedFundamentalSeries[];
  axes: FundamentalChartAxis[];
};

export type FundamentalChartLayout = {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  plotWidth: number;
  plotHeight: number;
  periodStep: number;
  periodCenters: number[];
};

export type FundamentalChartBar = {
  seriesId: string;
  seriesIndex: number;
  periodIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
  zeroY: number;
};

export type FundamentalChartLinePoint = {
  seriesId: string;
  seriesIndex: number;
  periodIndex: number;
  x: number;
  y: number;
  value: number;
};

export type FundamentalChartLine = {
  seriesId: string;
  seriesIndex: number;
  segments: FundamentalChartLinePoint[][];
};

export type FundamentalChartGeometry = {
  layout: FundamentalChartLayout;
  bars: FundamentalChartBar[];
  lines: FundamentalChartLine[];
};

export type FundamentalChartTooltipRow = {
  seriesId: string;
  label: string;
  value: number | null;
  unavailableReason: FundamentalChartUnavailableReason | null;
  formattedValue: string;
};

export type FundamentalChartTooltip = {
  periodEnd: string;
  periodLabel: string;
  rows: FundamentalChartTooltipRow[];
  accessibleLabel: string;
};

export type FundamentalSeriesVisual = {
  color: string;
  dashArray: string | undefined;
  pointShape: "circle" | "square" | "diamond" | "triangle";
  barPattern: "solid" | "diagonal" | "dots" | "cross";
};

const SERIES_VISUALS: readonly FundamentalSeriesVisual[] = [
  { color: "#004961", dashArray: undefined, pointShape: "circle", barPattern: "solid" },
  { color: "#0088b0", dashArray: "8 5", pointShape: "square", barPattern: "diagonal" },
  { color: "#aa0b56", dashArray: "2 4", pointShape: "diamond", barPattern: "dots" },
  { color: "#8a6a2e", dashArray: "12 4 2 4", pointShape: "triangle", barPattern: "cross" },
] as const;

export class FundamentalChartSpecError extends Error {
  readonly code:
    | "EMPTY_SERIES"
    | "TOO_MANY_SERIES"
    | "UNKNOWN_METRIC"
    | "DUPLICATE_SERIES"
    | "UNAVAILABLE_TRANSFORM"
    | "TOO_MANY_AXES"
    | "AXIS_CONFLICT";

  constructor(code: FundamentalChartSpecError["code"], message: string) {
    super(message);
    this.name = "FundamentalChartSpecError";
    this.code = code;
  }
}

export function buildFundamentalChartModel(
  periods: readonly PublicFundamentalPeriod[],
  availableSeries: readonly PublicFundamentalSeries[],
  specs: readonly FundamentalChartSeriesSpec[],
): FundamentalChartModel {
  if (specs.length === 0) {
    throw new FundamentalChartSpecError("EMPTY_SERIES", "Select at least one metric.");
  }
  if (specs.length > FUNDAMENTAL_CHART_MAX_SERIES) {
    throw new FundamentalChartSpecError(
      "TOO_MANY_SERIES",
      `A chart shows at most ${FUNDAMENTAL_CHART_MAX_SERIES} metrics.`,
    );
  }

  const availableByKey = new Map(availableSeries.map((series) => [series.metricKey, series]));
  const seenIds = new Set<string>();
  const preparedWithoutAxes = specs.map((spec) => {
    const source = availableByKey.get(spec.metricKey);
    if (!source) {
      throw new FundamentalChartSpecError("UNKNOWN_METRIC", `Unknown metric: ${spec.metricKey}`);
    }
    const transform = spec.transform ?? "value";
    if (!source.allowedTransforms.includes(transform)) {
      throw new FundamentalChartSpecError(
        "UNAVAILABLE_TRANSFORM",
        `${source.label} does not support the ${transform} transform.`,
      );
    }
    const id = `${spec.metricKey}:${transform}`;
    if (seenIds.has(id)) {
      throw new FundamentalChartSpecError("DUPLICATE_SERIES", `Duplicate chart series: ${id}`);
    }
    seenIds.add(id);
    return prepareSeries(source, periods, transform, spec.mark ?? source.defaultMark);
  });

  const axisKeys = [...new Set(preparedWithoutAxes.map((series) => series.axisKey))];
  if (axisKeys.length > FUNDAMENTAL_CHART_MAX_AXES) {
    throw new FundamentalChartSpecError(
      "TOO_MANY_AXES",
      "The selected metrics use more than two incompatible units. Split them into separate charts.",
    );
  }

  const sideByAxisKey = assignAxisSides(axisKeys, specs, preparedWithoutAxes);
  const series = preparedWithoutAxes.map((item) => ({
    ...item,
    axis: sideByAxisKey.get(item.axisKey) ?? "left",
  }));
  const axes = axisKeys.map((axisKey) => buildAxis(axisKey, sideByAxisKey.get(axisKey) ?? "left", series));

  return { periods: [...periods], series, axes };
}

export function buildFundamentalChartGeometry(
  model: FundamentalChartModel,
  width = FUNDAMENTAL_CHART_WIDTH,
  height = FUNDAMENTAL_CHART_HEIGHT,
): FundamentalChartGeometry {
  const hasRightAxis = model.axes.some((axis) => axis.side === "right");
  const layout = buildChartLayout(model.periods.length, hasRightAxis, width, height);
  const barSeries = model.series.filter((series) => series.mark === "bar");
  const barIndexById = new Map(barSeries.map((series, index) => [series.id, index]));
  const groupWidth = Math.min(layout.periodStep * 0.66, 72);
  const barGap = barSeries.length > 1 ? 3 : 0;
  const barWidth = barSeries.length === 0
    ? 0
    : Math.max(3, (groupWidth - barGap * (barSeries.length - 1)) / barSeries.length);
  const bars: FundamentalChartBar[] = [];
  const lines: FundamentalChartLine[] = [];

  model.series.forEach((series, seriesIndex) => {
    const axis = model.axes.find((candidate) => candidate.key === series.axisKey);
    if (!axis) return;
    if (series.mark === "bar") {
      const barSeriesIndex = barIndexById.get(series.id) ?? 0;
      series.points.forEach((point, periodIndex) => {
        if (point.value === null) return;
        const zeroY = scaleY(0, axis.domain, layout);
        const valueY = scaleY(point.value, axis.domain, layout);
        bars.push({
          seriesId: series.id,
          seriesIndex,
          periodIndex,
          x: layout.periodCenters[periodIndex]! - groupWidth / 2 + barSeriesIndex * (barWidth + barGap),
          y: Math.min(zeroY, valueY),
          width: barWidth,
          height: Math.max(1, Math.abs(valueY - zeroY)),
          value: point.value,
          zeroY,
        });
      });
      return;
    }

    const segments: FundamentalChartLinePoint[][] = [];
    let currentSegment: FundamentalChartLinePoint[] = [];
    series.points.forEach((point, periodIndex) => {
      if (point.value === null) {
        if (currentSegment.length > 0) segments.push(currentSegment);
        currentSegment = [];
        return;
      }
      currentSegment.push({
        seriesId: series.id,
        seriesIndex,
        periodIndex,
        x: layout.periodCenters[periodIndex]!,
        y: scaleY(point.value, axis.domain, layout),
        value: point.value,
      });
    });
    if (currentSegment.length > 0) segments.push(currentSegment);
    lines.push({ seriesId: series.id, seriesIndex, segments });
  });

  return { layout, bars, lines };
}

export function buildFundamentalChartTooltip(
  model: FundamentalChartModel,
  periodIndex: number,
): FundamentalChartTooltip {
  const period = model.periods[periodIndex];
  if (!period) throw new RangeError("Period index is outside the chart model.");
  const rows = model.series.map((series) => {
    const point = series.points[periodIndex] ?? null;
    return {
      seriesId: series.id,
      label: series.label,
      value: point?.value ?? null,
      // ?? would treat a null reason on a present point as missing, so tell "no point" apart from "point with no reason".
      unavailableReason: point === null ? "missing" : point.unavailableReason,
      formattedValue: formatFundamentalChartPoint(point, series),
    };
  });
  const periodLabel = formatFundamentalPeriod(period.periodEnd);
  // Screen readers spell "NM" letter by letter, so the spoken text expands it; the narrow visual column keeps the abbreviation.
  const spoken = (row: FundamentalChartTooltipRow) =>
    (row.unavailableReason === "not_meaningful" ? FUNDAMENTAL_NOT_MEANINGFUL_HINT : row.formattedValue);
  return {
    periodEnd: period.periodEnd,
    periodLabel,
    rows,
    accessibleLabel: `${periodLabel}: ${rows.map((row) => `${row.label} ${spoken(row)}`).join(", ")}`,
  };
}

/**
 * Differs from formatFundamentalChartValue only for empty values: with the whole point, it can say why it is empty.
 */
export function formatFundamentalChartPoint(
  point: Pick<FundamentalChartPoint, "value" | "unavailableReason"> | null | undefined,
  seriesOrAxis: Pick<PreparedFundamentalSeries | FundamentalChartAxis, "unitFamily" | "unit" | "currency">,
): string {
  if (point?.unavailableReason === "not_meaningful") return FUNDAMENTAL_NOT_MEANINGFUL_LABEL;
  return formatFundamentalChartValue(point?.value ?? null, seriesOrAxis);
}

export function formatFundamentalChartValue(
  value: number | null,
  seriesOrAxis: Pick<PreparedFundamentalSeries | FundamentalChartAxis, "unitFamily" | "unit" | "currency">,
): string {
  if (value === null || !Number.isFinite(value)) return "No data";
  if (seriesOrAxis.unit === "percentage_point") {
    return `${formatDecimal(value, 1)} pp`;
  }
  if (seriesOrAxis.unitFamily === "percent") return `${formatDecimal(value, 1)}%`;
  // A multiple reads as "42.6x"; compact notation would round it to nothing.
  if (seriesOrAxis.unitFamily === "multiple") return `${formatDecimal(value, 2)}x`;
  if (seriesOrAxis.unitFamily === "per_share") {
    const code = seriesOrAxis.currency || seriesOrAxis.unit;
    return formatCurrency(value, code, { maximumFractionDigits: 2, minimumFractionDigits: 2 })
      ?? `${code} ${formatDecimal(value, 2)}`.trim();
  }
  const compact = { notation: "compact", maximumFractionDigits: 1 } as const;
  if (seriesOrAxis.unitFamily === "shares") return `${new Intl.NumberFormat("en-US", compact).format(value)} shares`;
  const code = seriesOrAxis.currency || seriesOrAxis.unit;
  return formatCurrency(value, code, compact)
    ?? `${new Intl.NumberFormat("en-US", compact).format(value)} ${code}`.trim();
}

/** "$39.3B" for an ISO currency code; null when the unit is not one. */
function formatCurrency(value: number, code: string, options: Intl.NumberFormatOptions): string | null {
  if (!/^[A-Z]{3}$/.test(code)) return null;
  try {
    return new Intl.NumberFormat("en-US", { ...options, style: "currency", currency: code }).format(value);
  } catch {
    return null;
  }
}

export function formatFundamentalAxisTick(value: number, axis: FundamentalChartAxis): string {
  return formatFundamentalChartValue(value, axis);
}

export function formatFundamentalPeriod(periodEnd: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(periodEnd);
  if (!match) return periodEnd;
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

export function linePath(points: readonly Pick<FundamentalChartLinePoint, "x" | "y">[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${round(point.x)},${round(point.y)}`).join(" ");
}

export function selectFundamentalPeriodTickIndexes(
  periodCount: number,
  plotWidth: number,
): number[] {
  if (periodCount <= 0) return [];
  const maximumTickCount = Math.max(2, Math.floor(plotWidth / 56));
  if (periodCount <= maximumTickCount) {
    return Array.from({ length: periodCount }, (_, index) => index);
  }

  const stride = Math.ceil(periodCount / maximumTickCount);
  const indexes = Array.from({ length: periodCount }, (_, index) => index)
    .filter((index) => index % stride === 0);
  const lastIndex = periodCount - 1;
  const previousIndex = indexes.at(-1) ?? 0;
  if (lastIndex - previousIndex < stride) indexes[indexes.length - 1] = lastIndex;
  else indexes.push(lastIndex);
  return [...new Set(indexes)];
}

export function getFundamentalSeriesVisual(index: number): FundamentalSeriesVisual {
  return SERIES_VISUALS[index % SERIES_VISUALS.length]!;
}

function prepareSeries(
  source: PublicFundamentalSeries,
  periods: readonly PublicFundamentalPeriod[],
  transform: FundamentalTransform,
  mark: FundamentalChartMark,
): Omit<PreparedFundamentalSeries, "axis"> {
  const valuesByPeriod = new Map(source.points.map((point) => [point.periodEnd, point]));
  const sourcePoints = periods.map((period) => {
    const sourcePoint = valuesByPeriod.get(period.periodEnd);
    const parsedValue = parseChartNumber(sourcePoint?.valueDecimal ?? null);
    const value = parsedValue === null || source.displaySign === "as_reported"
      ? parsedValue
      : Math.abs(parsedValue);
    return {
      periodEnd: period.periodEnd,
      value,
      // An untransformed value is empty only because data is missing.
      unavailableReason: value === null ? ("missing" as const) : null,
      sourceValueDecimal: sourcePoint?.valueDecimal ?? null,
    };
  });
  const points = transformPoints(sourcePoints, transform);
  const transformedUnit = unitForTransform(source, transform);
  return {
    id: `${source.metricKey}:${transform}`,
    metricKey: source.metricKey,
    label: labelForTransform(source.label, transform),
    shortLabel: labelForTransform(source.shortLabel, transform),
    transform,
    mark,
    axisKey: axisKeyForSeries(source, transform),
    unitFamily: transformedUnit.unitFamily,
    unit: transformedUnit.unit,
    currency: transformedUnit.currency,
    points,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const YOY_MATCH_TOLERANCE_DAYS = 7;

function parsePeriodEndDate(periodEnd: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(periodEnd);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? ms : null;
}

function findYearAgoComparison(
  points: readonly FundamentalChartPoint[],
  index: number,
): FundamentalChartPoint | undefined {
  const dateMs = parsePeriodEndDate(points[index]!.periodEnd);
  if (dateMs === null) return undefined;
  const date = new Date(dateMs);
  // The target is the same month and day one year earlier. Date normalizes a leap-day 2/29 to 3/1;
  // the ±7-day tolerance also covers drift in the source's quarter-end dates.
  const targetMs = Date.UTC(date.getUTCFullYear() - 1, date.getUTCMonth(), date.getUTCDate());
  let best: FundamentalChartPoint | undefined;
  let bestDiff = Number.POSITIVE_INFINITY;
  points.forEach((candidate, candidateIndex) => {
    if (candidateIndex === index) return;
    const candidateMs = parsePeriodEndDate(candidate.periodEnd);
    if (candidateMs === null) return;
    const diff = Math.abs(candidateMs - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  });
  return bestDiff <= YOY_MATCH_TOLERANCE_DAYS * DAY_MS ? best : undefined;
}

function transformPoints(
  points: readonly FundamentalChartPoint[],
  transform: FundamentalTransform,
): FundamentalChartPoint[] {
  if (transform === "value") return points.map((point) => ({ ...point }));
  return points.map((point, index) => {
    // QoQ can use the adjacent entry (index-1): points inherit the periods' ascending periodEnd
    // order, and after normalization drops quarters without revenue the adjacent entry is the
    // previous available quarter, so no date matching is needed.
    // YoY cannot use a fixed offset (index-4): dropped quarters leave gaps, so index-4 could point
    // 5+ quarters back and silently produce a wrong growth rate. It matches the quarter end one
    // year earlier by periodEnd instead; when none exists (e.g. under a year of data) the value is
    // null, keeping the rule that an empty value beats a wrong one.
    const comparison = transform === "yoy_growth" || transform === "yoy_change"
      ? findYearAgoComparison(points, index)
      : index > 0
        ? points[index - 1]
        : undefined;
    let value: number | null = null;
    // A missing current or comparison value is "missing"; only a comparison that can be computed
    // but has no meaning becomes not_meaningful.
    let unavailableReason: FundamentalChartUnavailableReason | null = "missing";
    if (point.value !== null && comparison?.value !== null && comparison?.value !== undefined) {
      if (transform === "qoq_growth" || transform === "yoy_growth") {
        // Growth is undefined for a zero base, and for a negative base (cur / base - 1) flips the
        // sign: net income -100 → 50 (swing to profit) reads -150%, -100 → -150 (wider loss) reads
        // +50%, and -100 → -50 (narrower loss) reads -50%. All three would show wrong numbers,
        // so none is shown. This is not "missing": the data is complete but the ratio has no
        // meaning, so the page shows NM instead of "—". With base > 0 the formula is unchanged,
        // so a defined result such as a positive base turning to a loss (100 → -50 = -150%) still shows.
        if (comparison.value > 0) {
          value = normalizeComputedValue(((point.value / comparison.value) - 1) * 100);
          unavailableReason = null;
        } else {
          unavailableReason = "not_meaningful";
        }
      } else {
        // Difference transforms (percentage points) do not depend on the base sign and hold across zero.
        value = normalizeComputedValue(point.value - comparison.value);
        unavailableReason = null;
      }
    }
    return {
      periodEnd: point.periodEnd,
      value,
      unavailableReason,
      sourceValueDecimal: point.sourceValueDecimal,
    };
  });
}

function unitForTransform(
  source: PublicFundamentalSeries,
  transform: FundamentalTransform,
): Pick<PreparedFundamentalSeries, "unitFamily" | "unit" | "currency"> {
  if (transform === "qoq_growth" || transform === "yoy_growth") {
    return { unitFamily: "percent", unit: "percent", currency: "" };
  }
  if (transform === "qoq_change" || transform === "yoy_change") {
    return { unitFamily: "percent", unit: "percentage_point", currency: "" };
  }
  return { unitFamily: source.unitFamily, unit: source.unit, currency: source.currency };
}

function axisKeyForSeries(source: PublicFundamentalSeries, transform: FundamentalTransform): string {
  if (transform !== "value") return "percent";
  if (source.unitFamily === "percent") return "percent";
  if (source.unitFamily === "currency") return `currency:${source.currency || source.unit}`;
  return `${source.unitFamily}:${source.currency || source.unit}`;
}

function assignAxisSides(
  axisKeys: readonly string[],
  specs: readonly FundamentalChartSeriesSpec[],
  series: readonly Omit<PreparedFundamentalSeries, "axis">[],
): Map<string, FundamentalChartAxisSide> {
  const requestedByKey = new Map<string, FundamentalChartAxisSide>();
  specs.forEach((spec, index) => {
    if (!spec.axis) return;
    const key = series[index]!.axisKey;
    const requested = requestedByKey.get(key);
    if (requested && requested !== spec.axis) {
      throw new FundamentalChartSpecError("AXIS_CONFLICT", `Series with the same unit (${key}) cannot use different axes.`);
    }
    requestedByKey.set(key, spec.axis);
  });

  const result = new Map<string, FundamentalChartAxisSide>();
  const usedSides = new Set<FundamentalChartAxisSide>();
  axisKeys.forEach((key) => {
    const requested = requestedByKey.get(key);
    if (!requested) return;
    if (usedSides.has(requested)) {
      const otherKey = [...result.entries()].find(([, side]) => side === requested)?.[0];
      if (otherKey !== key) {
        throw new FundamentalChartSpecError("AXIS_CONFLICT", "Different units cannot share the same assigned axis.");
      }
    }
    result.set(key, requested);
    usedSides.add(requested);
  });
  axisKeys.forEach((key) => {
    if (result.has(key)) return;
    const side: FundamentalChartAxisSide = usedSides.has("left") ? "right" : "left";
    result.set(key, side);
    usedSides.add(side);
  });
  return result;
}

function buildAxis(
  key: string,
  side: FundamentalChartAxisSide,
  series: readonly PreparedFundamentalSeries[],
): FundamentalChartAxis {
  const members = series.filter((candidate) => candidate.axisKey === key);
  const values = members.flatMap((candidate) => candidate.points.flatMap((point) =>
    point.value === null ? [] : [point.value]));
  const includeZero = members.some((candidate) => candidate.mark === "bar")
    || members.some((candidate) => candidate.unitFamily === "percent");
  const domain = niceDomain(values, includeZero);
  const first = members[0]!;
  return {
    side,
    key,
    unitFamily: first.unitFamily,
    unit: members.some((member) => member.unit !== first.unit) ? "percent" : first.unit,
    currency: first.currency,
    domain,
    ticks: ticksForDomain(domain, 5),
    includeZero,
  };
}

function buildChartLayout(
  periodCount: number,
  hasRightAxis: boolean,
  width: number,
  height: number,
): FundamentalChartLayout {
  const compact = width < 540;
  const plotLeft = compact ? 70 : 72;
  const plotRight = width - (hasRightAxis ? (compact ? 54 : 76) : (compact ? 18 : 32));
  const plotTop = 24;
  const plotBottom = height - (compact ? 44 : 56);
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const periodStep = periodCount > 0 ? plotWidth / periodCount : plotWidth;
  return {
    width,
    height,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    plotWidth,
    plotHeight,
    periodStep,
    periodCenters: Array.from({ length: periodCount }, (_, index) => plotLeft + periodStep * (index + 0.5)),
  };
}

function scaleY(value: number, domain: readonly [number, number], layout: FundamentalChartLayout): number {
  const ratio = (value - domain[0]) / (domain[1] - domain[0]);
  return layout.plotBottom - ratio * layout.plotHeight;
}

function niceDomain(values: readonly number[], includeZero: boolean): readonly [number, number] {
  if (values.length === 0) return [0, 1];
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (includeZero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min === max) {
    const padding = Math.abs(min) * 0.1 || 1;
    min -= includeZero && min >= 0 ? 0 : padding;
    max += includeZero && max <= 0 ? 0 : padding;
  }
  const step = niceStep((max - min) / 4);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  return [normalizeZero(niceMin), normalizeZero(niceMax === niceMin ? niceMin + step : niceMax)];
}

function ticksForDomain(domain: readonly [number, number], targetCount: number): number[] {
  const step = niceStep((domain[1] - domain[0]) / Math.max(1, targetCount - 1));
  const ticks: number[] = [];
  const start = Math.ceil(domain[0] / step) * step;
  for (let value = start; value <= domain[1] + step * 0.001; value += step) {
    ticks.push(normalizeZero(Number(value.toPrecision(12))));
    if (ticks.length > 12) break;
  }
  return ticks;
}

function niceStep(roughStep: number): number {
  if (!Number.isFinite(roughStep) || roughStep <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function parseChartNumber(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function labelForTransform(label: string, transform: FundamentalTransform): string {
  const suffix: Record<FundamentalTransform, string> = {
    value: "",
    qoq_growth: " · QoQ growth",
    yoy_growth: " · YoY growth",
    qoq_change: " · QoQ change",
    yoy_change: " · YoY change",
  };
  return `${label}${suffix[transform]}`;
}

function formatDecimal(value: number, maximumFractionDigits: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function normalizeComputedValue(value: number): number {
  return normalizeZero(Number(value.toPrecision(12)));
}
