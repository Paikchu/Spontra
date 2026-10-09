"use client";

import {
  useId,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { PublicFundamentalsResponse } from "@/shared/analysis-contract/fundamentals.ts";
import { FUNDAMENTAL_CHART_HEIGHT, FUNDAMENTAL_CHART_WIDTH, buildFundamentalChartGeometry, buildFundamentalChartModel, buildFundamentalChartTooltip, formatFundamentalAxisTick, getFundamentalSeriesVisual, linePath, selectFundamentalPeriodTickIndexes, type FundamentalChartAxis, type FundamentalChartModel, type FundamentalChartSeriesSpec, type FundamentalSeriesVisual } from "@/packages/web/src/model/fundamental-chart.ts";

export type FundamentalChartRendererProps = {
  title: string;
  description?: string;
  data: PublicFundamentalsResponse;
  series: readonly FundamentalChartSeriesSpec[];
  className?: string;
  /** Period the reader picked; its marks are drawn in the highlight colour. */
  selectedPeriodEnd?: string | null;
  onSelectPeriod?(periodEnd: string): void;
};

/** Marks the picked period apart from every series colour in the palette. */
const SELECTED_PERIOD_COLOR = "var(--chart-selected)";

export function FundamentalChartRenderer({
  title,
  description,
  data,
  series,
  className,
  selectedPeriodEnd = null,
  onSelectPeriod,
}: FundamentalChartRendererProps) {
  const titleId = useId();
  const descriptionId = useId();
  const rawPatternId = useId();
  const patternId = rawPatternId.replace(/[^a-zA-Z0-9_-]/g, "");
  const [activePeriodIndex, setActivePeriodIndex] = useState<number | null>(null);
  const modelResult = useMemo(() => {
    if (data.status !== "ready") return { model: null, error: null };
    try {
      return {
        model: buildFundamentalChartModel(data.periods, data.series, series),
        error: null,
      };
    } catch (error) {
      return {
        model: null,
        error: error instanceof Error ? error.message : "图表配置无法解析。",
      };
    }
  }, [data, series]);
  const model = modelResult.model;

  if (data.status === "pending") {
    return (
      <ChartFrame className={className} title={title} description={description}>
        <ChartMessage
          title="财报趋势正在准备"
          detail="正在同步季度数据。数据可用后，图表会自动更新。"
        />
      </ChartFrame>
    );
  }

  if (!model) {
    return (
      <ChartFrame className={className} title={title} description={description}>
        <ChartMessage title="这组指标暂时不能叠加" detail={modelResult.error ?? "请调整指标组合。"} />
      </ChartFrame>
    );
  }

  const hasValues = model.series.some((item) => item.points.some((point) => point.value !== null));
  if (!hasValues) {
    return (
      <ChartFrame className={className} title={title} description={description}>
        <ChartMessage title="暂无可绘制数据" detail="所选指标在这些报告期内均为空。可更换指标或扩大报告期范围。" />
      </ChartFrame>
    );
  }

  return (
    <figure className={["fundamental-chart", className].filter(Boolean).join(" ")} data-chart-role="fundamental-chart">
      <figcaption className="sr-only">
        <h3 id={titleId}>{title}</h3>
        {description ? <p id={descriptionId}>{description}</p> : null}
      </figcaption>

      <ChartLegend model={model} />
      <FundamentalSvgChart
        model={model}
        titleId={titleId}
        descriptionId={description ? descriptionId : undefined}
        patternId={patternId}
        activePeriodIndex={activePeriodIndex}
        onActivePeriodChange={setActivePeriodIndex}
        selectedPeriodIndex={model.periods.findIndex((period) => period.periodEnd === selectedPeriodEnd)}
        onSelectPeriod={onSelectPeriod}
      />

      <p className="sr-only" aria-live="polite" data-chart-role="live-region">
        {activePeriodIndex === null
          ? "可使用 Tab 键依次查看每个报告期的数据。"
          : buildFundamentalChartTooltip(model, activePeriodIndex).accessibleLabel}
      </p>
    </figure>
  );
}

function ChartFrame({
  title,
  description,
  className,
  children,
}: {
  title: string;
  description?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={["fundamental-chart", className].filter(Boolean).join(" ")} data-chart-role="fundamental-chart">
      <header className="sr-only">
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </header>
      {children}
    </section>
  );
}

function ChartMessage({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="fundamental-chart__message" role="status" data-chart-role="message">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function ChartLegend({ model }: { model: FundamentalChartModel }) {
  return (
    <ul className="fundamental-chart__legend" aria-label="图例" data-chart-role="legend">
      {model.series.map((series, index) => {
        const visual = getFundamentalSeriesVisual(index);
        return (
          <li key={series.id}>
            {/* Square block for a bar series, flat rule for a line series — the
                same two marks the chart itself draws, at legend scale. */}
            <svg width="17" height="11" viewBox="0 0 17 11" aria-hidden="true">
              {series.mark === "bar" ? (
                <BarLegendSwatch visual={visual} />
              ) : (
                <line x1="0" x2="17" y1="5.5" y2="5.5" stroke={visual.color} strokeWidth="2" strokeDasharray={visual.dashArray} />
              )}
            </svg>
            <span>{series.label}</span>
            <small>{series.axis === "left" ? "左轴" : "右轴"}</small>
          </li>
        );
      })}
    </ul>
  );
}

function FundamentalSvgChart({
  model,
  titleId,
  descriptionId,
  patternId,
  activePeriodIndex,
  onActivePeriodChange,
  selectedPeriodIndex,
  onSelectPeriod,
}: {
  model: FundamentalChartModel;
  titleId: string;
  descriptionId?: string;
  patternId: string;
  activePeriodIndex: number | null;
  onActivePeriodChange(index: number | null): void;
  selectedPeriodIndex: number;
  onSelectPeriod?(periodEnd: string): void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(FUNDAMENTAL_CHART_WIDTH);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const updateWidth = (width: number) => setChartWidth(Math.max(280, Math.min(1_200, Math.round(width))));
    updateWidth(viewport.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => updateWidth(entry?.contentRect.width ?? FUNDAMENTAL_CHART_WIDTH));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  const chartHeight = chartWidth < 540 ? 250 : FUNDAMENTAL_CHART_HEIGHT;
  const geometry = buildFundamentalChartGeometry(model, chartWidth, chartHeight);
  const { layout } = geometry;
  const leftAxis = model.axes.find((axis) => axis.side === "left");
  const rightAxis = model.axes.find((axis) => axis.side === "right");
  const activeTooltip = activePeriodIndex === null
    ? null
    : buildFundamentalChartTooltip(model, activePeriodIndex);
  const activeX = activePeriodIndex === null ? null : layout.periodCenters[activePeriodIndex] ?? null;

  const selectPeriod = (index: number) => {
    const period = model.periods[index];
    if (period) onSelectPeriod?.(period.periodEnd);
  };

  const handlePeriodKeyDown = (event: KeyboardEvent<SVGRectElement>, index: number) => {
    if (event.key === "Escape") {
      onActivePeriodChange(null);
      event.currentTarget.blur();
      return;
    }
    // A rect is not a button, so Enter and Space have to be wired by hand.
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectPeriod(index);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    const nextIndex = Math.max(0, Math.min(model.periods.length - 1, index + delta));
    onActivePeriodChange(nextIndex);
    // Arrow keys are a deliberate move, so they carry the selection with them
    // and the detail panel stays in step with the focused period.
    selectPeriod(nextIndex);
    document.getElementById(periodTargetId(patternId, nextIndex))?.focus();
  };

  const handlePointerLeave = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== "touch" && !(event.currentTarget.contains(document.activeElement))) {
      onActivePeriodChange(null);
    }
  };

  return (
    <div ref={viewportRef} className="fundamental-chart__viewport" data-chart-role="plot">
      <svg
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        role="img"
        aria-labelledby={[titleId, descriptionId].filter(Boolean).join(" ")}
        preserveAspectRatio="xMidYMid meet"
        onPointerLeave={handlePointerLeave}
      >
        <ChartPatterns patternId={patternId} />
        {leftAxis ? <AxisGrid axis={leftAxis} layout={layout} /> : null}
        {rightAxis?.includeZero ? <AxisZeroReference axis={rightAxis} layout={layout} /> : null}
        {leftAxis ? <YAxis axis={leftAxis} layout={layout} /> : null}
        {rightAxis ? <YAxis axis={rightAxis} layout={layout} /> : null}

        {geometry.bars.map((bar) => {
          const visual = getFundamentalSeriesVisual(bar.seriesIndex);
          const series = model.series[bar.seriesIndex]!;
          // A selected bar drops its pattern for solid highlight fill; the
          // pattern encodes which series it is, which the position already says
          // once the whole period is picked out.
          const selected = bar.periodIndex === selectedPeriodIndex;
          return (
            <rect
              key={`${bar.seriesId}:${bar.periodIndex}`}
              className="fundamental-chart__bar"
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              rx="1.5"
              fill={selected ? SELECTED_PERIOD_COLOR : barFill(visual, patternId, bar.seriesIndex)}
              stroke={selected ? SELECTED_PERIOD_COLOR : visual.color}
              data-series-id={series.id}
              data-period-index={bar.periodIndex}
              data-selected={selected ? "true" : undefined}
            />
          );
        })}

        {geometry.lines.map((line) => {
          const series = model.series[line.seriesIndex]!;
          const visual = getFundamentalSeriesVisual(line.seriesIndex);
          return (
            <g key={line.seriesId} data-series-id={series.id}>
              {line.segments.map((segment, segmentIndex) => (
                <path
                  key={segmentIndex}
                  className="fundamental-chart__line"
                  d={linePath(segment)}
                  fill="none"
                  stroke={visual.color}
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  strokeDasharray={visual.dashArray}
                />
              ))}
              {line.segments.flatMap((segment) => segment).map((point) => {
                const selected = point.periodIndex === selectedPeriodIndex;
                return (
                  <PointShape
                    key={point.periodIndex}
                    shape={visual.pointShape}
                    x={point.x}
                    y={point.y}
                    color={selected ? SELECTED_PERIOD_COLOR : visual.color}
                    size={selected ? 5.5 : 4}
                    selected={selected}
                  />
                );
              })}
            </g>
          );
        })}

        {activeX !== null ? (
          <line
            className="fundamental-chart__active-guide"
            x1={activeX}
            x2={activeX}
            y1={layout.plotTop}
            y2={layout.plotBottom}
          />
        ) : null}

        <XAxis model={model} layout={layout} selectedPeriodIndex={selectedPeriodIndex} />

        <g data-chart-role="period-targets">
          {model.periods.map((period, index) => {
            const tooltip = buildFundamentalChartTooltip(model, index);
            const targetWidth = Math.max(44, layout.periodStep);
            return (
              <rect
                id={periodTargetId(patternId, index)}
                key={period.periodEnd}
                className="fundamental-chart__hit-target"
                x={layout.periodCenters[index]! - targetWidth / 2}
                y={layout.plotTop}
                width={targetWidth}
                height={layout.plotHeight}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={tooltip.accessibleLabel}
                aria-pressed={selectedPeriodIndex === index}
                data-period-end={period.periodEnd}
                onFocus={() => onActivePeriodChange(index)}
                onBlur={(event) => {
                  if (!event.currentTarget.ownerSVGElement?.contains(event.relatedTarget as Node | null)) {
                    onActivePeriodChange(null);
                  }
                }}
                onPointerEnter={() => onActivePeriodChange(index)}
                onClick={() => {
                  onActivePeriodChange(index);
                  selectPeriod(index);
                }}
                onKeyDown={(event) => handlePeriodKeyDown(event, index)}
              />
            );
          })}
        </g>

        {activeTooltip && activeX !== null ? (
          <ChartTooltip tooltip={activeTooltip} x={activeX} model={model} layout={layout} />
        ) : null}
      </svg>
    </div>
  );
}

function AxisGrid({
  axis,
  layout,
}: {
  axis: FundamentalChartAxis;
  layout: ReturnType<typeof buildFundamentalChartGeometry>["layout"];
}) {
  return (
    <g aria-hidden="true">
      {axis.ticks.map((tick) => {
        const y = yForValue(tick, axis, layout);
        return (
          <line
            key={tick}
            className={tick === 0 ? "fundamental-chart__zero-line" : "fundamental-chart__grid-line"}
            x1={layout.plotLeft}
            x2={layout.plotRight}
            y1={y}
            y2={y}
          />
        );
      })}
    </g>
  );
}

function AxisZeroReference({
  axis,
  layout,
}: {
  axis: FundamentalChartAxis;
  layout: ReturnType<typeof buildFundamentalChartGeometry>["layout"];
}) {
  const y = yForValue(0, axis, layout);
  return (
    <line
      className="fundamental-chart__zero-line"
      x1={layout.plotLeft}
      x2={layout.plotRight}
      y1={y}
      y2={y}
      data-zero-axis={axis.side}
      aria-hidden="true"
    />
  );
}

function YAxis({
  axis,
  layout,
}: {
  axis: FundamentalChartAxis;
  layout: ReturnType<typeof buildFundamentalChartGeometry>["layout"];
}) {
  const x = axis.side === "left" ? layout.plotLeft - 10 : layout.plotRight + 10;
  return (
    <g className="fundamental-chart__axis" data-axis-id={axis.key} data-axis-side={axis.side}>
      {axis.ticks.map((tick) => (
        <text
          key={tick}
          x={x}
          y={yForValue(tick, axis, layout) + 4}
          textAnchor={axis.side === "left" ? "end" : "start"}
        >
          {formatFundamentalAxisTick(tick, axis)}
        </text>
      ))}
    </g>
  );
}

function XAxis({
  model,
  layout,
  selectedPeriodIndex,
}: {
  model: FundamentalChartModel;
  layout: ReturnType<typeof buildFundamentalChartGeometry>["layout"];
  selectedPeriodIndex: number;
}) {
  const visibleTickIndexes = new Set(
    selectFundamentalPeriodTickIndexes(model.periods.length, layout.plotWidth),
  );
  // Thinning may have dropped the selected label, and that is the one label the
  // reader is looking for, so it is put back regardless of density.
  if (selectedPeriodIndex >= 0) visibleTickIndexes.add(selectedPeriodIndex);
  return (
    <g className="fundamental-chart__axis fundamental-chart__axis--x" aria-hidden="true">
      <line x1={layout.plotLeft} x2={layout.plotRight} y1={layout.plotBottom} y2={layout.plotBottom} />
      {model.periods.map((period, index) => visibleTickIndexes.has(index) ? (
        <text
          key={period.periodEnd}
          x={layout.periodCenters[index]}
          y={layout.plotBottom + 28}
          textAnchor="middle"
          data-selected={index === selectedPeriodIndex ? "true" : undefined}
        >
          {formatPeriodTick(period.periodEnd)}
        </text>
      ) : null)}
    </g>
  );
}

function ChartTooltip({
  tooltip,
  x,
  model,
  layout,
}: {
  tooltip: ReturnType<typeof buildFundamentalChartTooltip>;
  x: number;
  model: FundamentalChartModel;
  layout: ReturnType<typeof buildFundamentalChartGeometry>["layout"];
}) {
  const width = 222;
  const rowHeight = 22;
  const height = 38 + tooltip.rows.length * rowHeight;
  const tooltipX = Math.max(layout.plotLeft + 4, Math.min(layout.plotRight - width - 4, x + 14));
  const tooltipY = layout.plotTop + 8;
  return (
    <g className="fundamental-chart__tooltip" transform={`translate(${tooltipX} ${tooltipY})`} aria-hidden="true">
      <rect width={width} height={height} rx="3" />
      <text className="fundamental-chart__tooltip-period" x="12" y="22">{tooltip.periodLabel}</text>
      {tooltip.rows.map((row, index) => {
        const visual = getFundamentalSeriesVisual(index);
        const series = model.series[index]!;
        return (
          <g key={row.seriesId} transform={`translate(0 ${38 + index * rowHeight})`}>
            <PointShape shape={visual.pointShape} x={15} y={0} color={visual.color} size={3.5} />
            <text x="27" y="4">{truncate(series.shortLabel, 12)}</text>
            <text x={width - 12} y="4" textAnchor="end">{row.formattedValue}</text>
          </g>
        );
      })}
    </g>
  );
}

function ChartPatterns({ patternId }: { patternId: string }) {
  return (
    <defs>
      {(["diagonal", "dots", "cross"] as const).map((pattern, visualIndex) => {
        const index = visualIndex + 1;
        const color = getFundamentalSeriesVisual(index).color;
        return (
          <pattern key={pattern} id={`${patternId}-${pattern}`} width="8" height="8" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" fill={color} opacity="0.9" />
            {pattern === "diagonal" ? <path d="M-2 2 L2 -2 M0 8 L8 0 M6 10 L10 6" stroke="var(--paper)" strokeWidth="1.4" opacity="0.72" /> : null}
            {pattern === "dots" ? <circle cx="4" cy="4" r="1.4" fill="var(--paper)" opacity="0.78" /> : null}
            {pattern === "cross" ? <path d="M4 0 V8 M0 4 H8" stroke="var(--paper)" strokeWidth="1" opacity="0.7" /> : null}
          </pattern>
        );
      })}
    </defs>
  );
}

function PointShape({
  shape,
  x,
  y,
  color,
  size,
  selected = false,
}: {
  shape: FundamentalSeriesVisual["pointShape"];
  x: number;
  y: number;
  color: string;
  size: number;
  selected?: boolean;
}) {
  // A selected point is filled rather than hollow, so it still reads as picked
  // where colour alone would not carry — print, or a colour-vision difference.
  const fill = selected ? color : "var(--paper)";
  if (shape === "square") {
    return <rect x={x - size} y={y - size} width={size * 2} height={size * 2} fill={fill} stroke={color} strokeWidth="2" />;
  }
  if (shape === "diamond") {
    return <path d={`M${x},${y - size - 0.5} L${x + size + 0.5},${y} L${x},${y + size + 0.5} L${x - size - 0.5},${y} Z`} fill={fill} stroke={color} strokeWidth="2" />;
  }
  if (shape === "triangle") {
    return <path d={`M${x},${y - size - 1} L${x + size + 1},${y + size} L${x - size - 1},${y + size} Z`} fill={fill} stroke={color} strokeWidth="2" />;
  }
  return <circle cx={x} cy={y} r={size} fill={fill} stroke={color} strokeWidth="2" />;
}

function BarLegendSwatch({ visual }: { visual: FundamentalSeriesVisual }) {
  return (
    <g>
      <rect x="3" y="0" width="11" height="11" fill={visual.color} stroke={visual.color} />
      {visual.barPattern === "diagonal" ? (
        <path d="M3 9 L11 1 M6 11 L14 3" stroke="var(--paper)" strokeWidth="1.2" />
      ) : null}
      {visual.barPattern === "dots" ? (
        <>
          <circle cx="6.5" cy="3.5" r="1.1" fill="var(--paper)" />
          <circle cx="10.5" cy="7.5" r="1.1" fill="var(--paper)" />
        </>
      ) : null}
      {visual.barPattern === "cross" ? (
        <path d="M8.5 0 V11 M3 5.5 H14" stroke="var(--paper)" strokeWidth="1" />
      ) : null}
    </g>
  );
}

function barFill(visual: FundamentalSeriesVisual, patternId: string, index: number): string {
  if (visual.barPattern === "solid") return visual.color;
  return `url(#${patternId}-${getFundamentalSeriesVisual(index).barPattern})`;
}

function yForValue(
  value: number,
  axis: FundamentalChartAxis,
  layout: ReturnType<typeof buildFundamentalChartGeometry>["layout"],
): number {
  const ratio = (value - axis.domain[0]) / (axis.domain[1] - axis.domain[0]);
  return layout.plotBottom - ratio * layout.plotHeight;
}

function periodTargetId(patternId: string, index: number): string {
  return `${patternId}-period-${index}`;
}

function formatPeriodTick(periodEnd: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(periodEnd);
  return match ? `${match[1]}.${Number(match[2])}` : periodEnd;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
