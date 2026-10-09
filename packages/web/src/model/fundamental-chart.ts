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
 * 无意义增速的标注，以及展开说明它的那句话。基数为零或为负时增速在数学上无定义，
 * 业内惯例记作 NM（not meaningful），而不是把它和「这期没有数据」写成同一个破折号。
 */
export const FUNDAMENTAL_NOT_MEANINGFUL_LABEL = "NM";
export const FUNDAMENTAL_NOT_MEANINGFUL_HINT = "not meaningful：基数为零或为负，增速没有数学意义";

export type FundamentalChartAxisSide = "left" | "right";

export type FundamentalChartSeriesSpec = {
  metricKey: FundamentalMetricKey;
  transform?: FundamentalTransform;
  mark?: FundamentalChartMark;
  axis?: FundamentalChartAxisSide;
};

/**
 * 一个点为什么空着。"missing" 是这一期没有数据；"not_meaningful" 是数据齐全，
 * 但基数为零或为负，增速没有数学意义（扭亏为盈、亏损扩大等）。两者都以 value:
 * null 出现，只有这个字段能把它们分开，页面据此决定显示「—」还是「NM」。
 */
export type FundamentalChartUnavailableReason = "missing" | "not_meaningful";

export type FundamentalChartPoint = {
  periodEnd: string;
  value: number | null;
  // value 为数时是 null，为 null 时必有原因。
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
    throw new FundamentalChartSpecError("EMPTY_SERIES", "至少选择一个指标。");
  }
  if (specs.length > FUNDAMENTAL_CHART_MAX_SERIES) {
    throw new FundamentalChartSpecError(
      "TOO_MANY_SERIES",
      `同一图表最多展示 ${FUNDAMENTAL_CHART_MAX_SERIES} 个指标。`,
    );
  }

  const availableByKey = new Map(availableSeries.map((series) => [series.metricKey, series]));
  const seenIds = new Set<string>();
  const preparedWithoutAxes = specs.map((spec) => {
    const source = availableByKey.get(spec.metricKey);
    if (!source) {
      throw new FundamentalChartSpecError("UNKNOWN_METRIC", `未知指标：${spec.metricKey}`);
    }
    const transform = spec.transform ?? "value";
    if (!source.allowedTransforms.includes(transform)) {
      throw new FundamentalChartSpecError(
        "UNAVAILABLE_TRANSFORM",
        `${source.label} 不支持 ${transform} 变换。`,
      );
    }
    const id = `${spec.metricKey}:${transform}`;
    if (seenIds.has(id)) {
      throw new FundamentalChartSpecError("DUPLICATE_SERIES", `重复图表序列：${id}`);
    }
    seenIds.add(id);
    return prepareSeries(source, periods, transform, spec.mark ?? source.defaultMark);
  });

  const axisKeys = [...new Set(preparedWithoutAxes.map((series) => series.axisKey))];
  if (axisKeys.length > FUNDAMENTAL_CHART_MAX_AXES) {
    throw new FundamentalChartSpecError(
      "TOO_MANY_AXES",
      "所选指标包含超过两种不可共用的单位，请拆分为多张图表。",
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
      // ?? 会把"有值"的 null 也当成缺失，所以这里显式区分"没有这个点"和"点上没有原因"。
      unavailableReason: point === null ? "missing" : point.unavailableReason,
      formattedValue: formatFundamentalChartPoint(point, series),
    };
  });
  const periodLabel = formatFundamentalPeriod(period.periodEnd);
  // 读屏把 "NM" 念成两个字母，所以朗读的那份把它展开成整句；视觉上的窄列仍然只放缩写。
  const spoken = (row: FundamentalChartTooltipRow) =>
    (row.unavailableReason === "not_meaningful" ? FUNDAMENTAL_NOT_MEANINGFUL_HINT : row.formattedValue);
  return {
    periodEnd: period.periodEnd,
    periodLabel,
    rows,
    accessibleLabel: `${periodLabel}，${rows.map((row) => `${row.label} ${spoken(row)}`).join("，")}`,
  };
}

/**
 * 和 formatFundamentalChartValue 的区别只在空值：拿得到整个点，就能说出它为什么空。
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
  if (value === null || !Number.isFinite(value)) return "暂无数据";
  if (seriesOrAxis.unit === "percentage_point") {
    return `${formatDecimal(value, 1)} 个百分点`;
  }
  if (seriesOrAxis.unitFamily === "percent") return `${formatDecimal(value, 1)}%`;
  // A multiple reads as "42.6x"; compact notation would round it to nothing.
  if (seriesOrAxis.unitFamily === "multiple") return `${formatDecimal(value, 2)}x`;
  if (seriesOrAxis.unitFamily === "per_share") {
    return `${seriesOrAxis.currency || seriesOrAxis.unit} ${formatDecimal(value, 2)}`.trim();
  }
  const compact = new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
  if (seriesOrAxis.unitFamily === "shares") return `${compact} 股`;
  return `${compact} ${seriesOrAxis.currency || seriesOrAxis.unit}`.trim();
}

export function formatFundamentalAxisTick(value: number, axis: FundamentalChartAxis): string {
  return formatFundamentalChartValue(value, axis).replace(" 个百分点", "pp");
}

export function formatFundamentalPeriod(periodEnd: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(periodEnd);
  if (!match) return periodEnd;
  return `${match[1]}年${Number(match[2])}月`;
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
      // 未经变换的原值只会因为缺数据而为空。
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
  // 目标日期为"一年前的同一月日"。闰年 2/29 会被 Date 归一化到 3/1，
  // ±7 天容差同时覆盖数据源季度末日期的漂移。
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
    // QoQ 用相邻条目（index-1）是安全的：points 继承 periods 按 periodEnd 的升序，
    // 而 normalization 剔除缺营收季度后，相邻条目恰好就是排序意义上的前一个"可用"季度，
    // 因此相邻条目语义与"前一个实际季度"一致，无需按日期匹配。
    // YoY 不能沿用固定索引偏移（index-4）：剔除季度会在数组中留下"空洞"，
    // 使 index-4 指向相隔 5+ 个季度的期间并静默产生错误增长率。因此改为按
    // periodEnd 日期匹配一年前的同季度末；找不到（例如序列不足一年）则值为 null，
    // 与"宁可显示空也不显示错值"的既有语义一致。
    const comparison = transform === "yoy_growth" || transform === "yoy_change"
      ? findYearAgoComparison(points, index)
      : index > 0
        ? points[index - 1]
        : undefined;
    let value: number | null = null;
    // 缺了当期或缺了比较期都是「没有数据」；只有算得出比较、结果却没有意义的情况
    // 才改写成 not_meaningful。
    let unavailableReason: FundamentalChartUnavailableReason | null = "missing";
    if (point.value !== null && comparison?.value !== null && comparison?.value !== undefined) {
      if (transform === "qoq_growth" || transform === "yoy_growth") {
        // 分母为 0 时增长率无定义；分母为负时同样无定义——(cur / base - 1) 会把符号
        // 整体翻转：净利润 -100 → 50（扭亏为盈）算成 -150%，
        // -100 → -150（亏损扩大）反而算成 +50%，-100 → -50（亏损收窄）算成 -50%。
        // 三个方向都是页面上直接可见的错数字，因此统一不出数字。但这不是"没有数据"：
        // 数据齐全，只是这个比值没有意义，页面据 not_meaningful 标 NM 而不是「—」。
        // base > 0 时保持原公式不变，因此正基数转亏（100 → -50 = -150%）这类有定义
        // 的结果仍照常输出。
        if (comparison.value > 0) {
          value = normalizeComputedValue(((point.value / comparison.value) - 1) * 100);
          unavailableReason = null;
        } else {
          unavailableReason = "not_meaningful";
        }
      } else {
        // 差值型变换（百分点）与基数符号无关，跨零仍然成立。
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
      throw new FundamentalChartSpecError("AXIS_CONFLICT", `同单位序列 ${key} 不能分配到不同坐标轴。`);
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
        throw new FundamentalChartSpecError("AXIS_CONFLICT", "不同单位不能共用同一条指定坐标轴。");
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
    qoq_growth: " · 环比增速",
    yoy_growth: " · 同比增速",
    qoq_change: " · 环比变化",
    yoy_change: " · 同比变化",
  };
  return `${label}${suffix[transform]}`;
}

function formatDecimal(value: number, maximumFractionDigits: number): string {
  return new Intl.NumberFormat("zh-CN", {
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
