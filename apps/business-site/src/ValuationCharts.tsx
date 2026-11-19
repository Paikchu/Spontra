import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  LineType,
  createChart,
  type IChartApi,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type SeriesAttachedParameter,
  type Time,
} from "lightweight-charts";
import { messages, labels, useLocale } from "@/packages/web/src/i18n";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { axisNumber, axisUnit, compactMoney, formatPct, perShare } from "@/shared/analysis-runtime/locale";
import type { DailyPriceBar, LiveMarketDaily } from "@/shared/analysis-contract/market-daily";
import type { ValuationPriceGuide } from "@/shared/analysis-contract/price-guide";
import { DIMENSION_WEIGHTS, SCORE_ANCHOR_LEVELS, VALUATION_DIMENSIONS, VALUATION_METHODS, type Confidence, type MethodValuation, type Sensitivity, type ValuationDimensionKey, type ValuationMethodKey, type ValuationPublication, type ValuationResponse, type YearRow } from "@/shared/analysis-contract/valuation";

/**
 * Valuation figures: the fixed five-dimension pentagon, the dual-track valuation spectrum,
 * the TradingView Lightweight Charts daily live fair-value chart with upper/lower bound lines drawn
 * directly on the chart, the method football-field bridge, the multi-year cash-flow trajectory,
 * and the sensitivity tornado.
 */
const m = messages({
  radar: "Five-dimension chart", unscored: "not scored", ringNote: (levels: string) => `Rings at ${levels}`, weight: (w: string) => `Weight ${w}`,
  normalTrack: "12-month normal operating range", stressTrack: "Stress & opportunity scenarios",
  liveFairRange: "Live fair value range assessment",
  dailyChartAria: "TradingView daily candlestick chart with fair value upper and lower bound lines",
  loadingChart: "Loading daily market prices…",
  chartUnavailable: "Live daily market data is temporarily unavailable",
  openLabel: "O", highLabel: "H", lowLabel: "L", closeLabel: "C",
  hudRange: "Fair range",
  basisNormal: "Normal range",
  basisStress: "Bear–Bull",
  upperBound: "Upper", lowerBound: "Lower",
  selectDimensionHint: "Click any dimension on the chart to inspect its analysis",
  normalLow: "Normal low", normalHigh: "Normal high", base: "Base", bear: "Bear", bull: "Bull", expected: "Expected",
  latestQuote: "Current close", frozenQuote: "Report close",
  spectrumAria: "Valuation range comparison",
  methodsTitle: "Valuation methods comparison", methodHeader: "Method", weightHeader: "Weight", rangeHeader: "Low / Base / High",
  notApplied: "Not applied", weightedBase: "Weighted base", dispersionNote: (ratio: string) => `Method spread ${ratio}`,
  revenue: "Revenue", capex: "Capex", reinvestment: "Reinvestment", fcff: "Free cash flow", nopat: "NOPAT",
  yearCol: "Year", depreciationCol: "D&A", workingCapitalCol: "ΔNWC", adjustmentCol: "Adj.",
  yearShort: (y: number) => `Y${y}`, forecastYear: (y: number) => `Year ${y}`,
  trajectoryAria: "Multi-year revenue, capex and free cash flow trajectory",
  sensitivityAria: "Sensitivity of base cash-flow value",
}, {
  radar: "五维图", unscored: "未评分", ringNote: (levels: string) => `环线为 ${levels} 分`, weight: (w: string) => `权重 ${w}`,
  normalTrack: "12 个月正常经营区间", stressTrack: "压力与情景测试",
  liveFairRange: "实时股价合理范围评估",
  dailyChartAria: "锁定日线周期的实时股价走势与合理估值上下限图",
  loadingChart: "正在读取实时日线行情…",
  chartUnavailable: "暂无法读取实时日线行情",
  openLabel: "开", highLabel: "高", lowLabel: "低", closeLabel: "收",
  hudRange: "当日合理范围",
  basisNormal: "正常经营区间",
  basisStress: "悲观至乐观",
  upperBound: "上限", lowerBound: "下限",
  selectDimensionHint: "点击五维图任一维度查看对应分析",
  normalLow: "正常下限", normalHigh: "正常上限", base: "基准", bear: "悲观", bull: "乐观", expected: "期望",
  latestQuote: "最新参考价", frozenQuote: "报告基准价",
  spectrumAria: "估值区间对比",
  methodsTitle: "估值方法对比", methodHeader: "估值方法", weightHeader: "权重", rangeHeader: "低 / 基准 / 高",
  notApplied: "未采用", weightedBase: "加权基准", dispersionNote: (ratio: string) => `方法跨度 ${ratio}`,
  revenue: "营收", capex: "资本开支", reinvestment: "再投资", fcff: "企业自由现金流", nopat: "税后经营利润",
  yearCol: "年份", depreciationCol: "折旧摊销", workingCapitalCol: "营运资本变动", adjustmentCol: "调整",
  yearShort: (y: number) => `第 ${y} 年`, forecastYear: (y: number) => `第 ${y} 年`,
  trajectoryAria: "逐年营收、资本开支与自由现金流路径",
  sensitivityAria: "基准现金流估值敏感性",
});

const METHOD_LABEL = labels<ValuationMethodKey>(
  { dcf: "Discounted cash flow", ev_ebitda_forward: "EV/EBITDA, forward", pe_forward: "P/E, forward" },
  { dcf: "现金流折现", ev_ebitda_forward: "远期 EV/EBITDA", pe_forward: "远期 P/E" },
);

const FACTOR_LABEL = labels({
  revenueGrowth: "Revenue growth", operatingMargin: "Operating margin", netMargin: "Net margin",
  fcfMargin: "Free cash flow margin", capexToRevenue: "Capex to revenue", sbcToRevenue: "Stock compensation to revenue",
  returnOnEquity: "Return on equity", discountRate: "Discount rate", salesToCapital: "Sales to capital",
  terminalGrowth: "Terminal growth", capex: "Capital expenditure", terminalRoic: "Terminal ROIC",
  roe: "Return on equity", terminalRoe: "Terminal ROE", multiple: "Multiple",
  assetPrices: "Asset prices", afterSbcEquityCashMargin: "Equity cash margin",
}, {
  revenueGrowth: "营收增长", operatingMargin: "营业利润率", netMargin: "净利率",
  fcfMargin: "自由现金流利润率", capexToRevenue: "资本开支占营收", sbcToRevenue: "股权激励占营收",
  returnOnEquity: "净资产收益率", discountRate: "折现率", salesToCapital: "销售资本比",
  terminalGrowth: "终值增长", capex: "资本开支", terminalRoic: "终值投入资本回报率",
  roe: "净资产收益率", terminalRoe: "终值净资产收益率", multiple: "倍数",
  assetPrices: "资产价格", afterSbcEquityCashMargin: "股权现金利润率",
});

const pct = (v: number, digits = 0) => `${v < 0 ? "−" : ""}${(Math.abs(v) * 100).toFixed(digits)}%`;
const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

const RADAR = { w: 400, h: 360, cx: 200, cy: 190, r: 100, labelRadius: 156 } as const;
/** A vertex on the fixed pentagon: the five axes in contract order, clockwise from the top. */
function vertex(index: number, radius: number): { x: number; y: number } {
  const angle = (index * 72 - 90) * Math.PI / 180;
  return { x: RADAR.cx + radius * Math.cos(angle), y: RADAR.cy + radius * Math.sin(angle) };
}
const ring = (radius: number) => VALUATION_DIMENSIONS.map((_, i) => { const v = vertex(i, radius); return `${v.x.toFixed(1)},${v.y.toFixed(1)}`; }).join(" ");

/**
 * The same axes, order and weights for every company, rings at the scoring anchors, the scored polygon as one series.
 * Vertices and labels can be clicked to inspect a single dimension's rationale without listing all five at once.
 */
export function Radar({ report, label, confidence, compact, selectedKey, onSelect }: {
  report: Pick<ValuationPublication, "dimensions">;
  label: (key: ValuationDimensionKey) => string;
  confidence?: (level: Confidence) => string;
  compact?: boolean;
  selectedKey?: ValuationDimensionKey;
  onSelect?: (key: ValuationDimensionKey) => void;
}) {
  const byKey = new Map(report.dimensions.map(d => [d.key, d]));
  if (VALUATION_DIMENSIONS.some(key => !finite(byKey.get(key)?.score))) return null;
  const points = VALUATION_DIMENSIONS.map((key, i) => {
    const d = byKey.get(key);
    const score = d && finite(d.score) ? Math.max(0, Math.min(10, d.score)) : null;
    const v = vertex(i, RADAR.r * (score ?? 0) / 10), at = vertex(i, RADAR.labelRadius);
    return { key, score, confidence: d?.confidence ?? null, v, at };
  });
  const summary = points.map(p => `${label(p.key)} ${p.score != null ? p.score.toFixed(1) : m.unscored}`).join(" · ");
  const conf = (c: Confidence | null) => c && c !== "medium" && confidence ? ` · ${confidence(c)}` : "";
  return <figure className="val-radar" data-compact={compact ? "" : undefined} data-interactive={onSelect ? "" : undefined} aria-label={`${m.radar} · ${summary}`}>
    <div className="val-radar-plot"><svg viewBox={`0 0 ${RADAR.w} ${RADAR.h}`} role="img" aria-label={summary} className="val-radar-svg">
      {SCORE_ANCHOR_LEVELS.map(level => <polygon key={level} className="val-radar-ring" points={ring(RADAR.r * level / 10)} />)}
      {points.map(p => {
        const end = vertex(VALUATION_DIMENSIONS.indexOf(p.key), RADAR.r);
        return <line key={p.key} className="val-radar-axis" x1={RADAR.cx} y1={RADAR.cy} x2={end.x.toFixed(1)} y2={end.y.toFixed(1)} />;
      })}
      <polygon className="val-radar-area" points={points.map(p => `${p.v.x.toFixed(1)},${p.v.y.toFixed(1)}`).join(" ")} />
      {points.map(p => {
        const active = selectedKey === p.key;
        return (
          <g key={p.key} className="val-radar-node" onClick={onSelect ? () => onSelect(p.key) : undefined} style={{ cursor: onSelect ? "pointer" : undefined }}>
            {active && <circle className="val-radar-dot-halo" cx={p.v.x.toFixed(1)} cy={p.v.y.toFixed(1)} r={9} />}
            <circle className="val-radar-dot" data-active={active ? "" : undefined} data-unscored={p.score == null ? "" : undefined} cx={p.v.x.toFixed(1)} cy={p.v.y.toFixed(1)} r={active ? 6 : 4.5}>
              <title>{`${label(p.key)} · ${p.score != null ? p.score.toFixed(1) : m.unscored}`}</title>
            </circle>
            {onSelect && <circle className="val-radar-hit" cx={p.v.x.toFixed(1)} cy={p.v.y.toFixed(1)} r={16} />}
          </g>
        );
      })}
    </svg>
    {points.map(p => onSelect ? (
      <button
        key={p.key}
        type="button"
        className="val-radar-label"
        data-active={selectedKey === p.key ? "" : undefined}
        aria-pressed={selectedKey === p.key}
        onClick={() => onSelect(p.key)}
        style={{ left: `${(p.at.x / RADAR.w * 100).toFixed(1)}%`, top: `${(p.at.y / RADAR.h * 100).toFixed(1)}%` }}
      >
        <b>{label(p.key)} <em>{p.score != null ? p.score.toFixed(1) : "—"}</em></b>
        {!compact && <small>{m.weight(pct(DIMENSION_WEIGHTS[p.key]))}{conf(p.confidence)}</small>}
      </button>
    ) : (
      <span key={p.key} className="val-radar-label" style={{ left: `${(p.at.x / RADAR.w * 100).toFixed(1)}%`, top: `${(p.at.y / RADAR.h * 100).toFixed(1)}%` }}>
        <b>{label(p.key)}{!compact && <em> {p.score != null ? p.score.toFixed(1) : "—"}</em>}</b>
        {!compact && <small>{m.weight(pct(DIMENSION_WEIGHTS[p.key]))}{conf(p.confidence)}</small>}
      </span>
    ))}</div>
    {!onSelect && !compact && <figcaption>{m.ringNote(SCORE_ANCHOR_LEVELS.join(" / "))}</figcaption>}
  </figure>;
}

type SpectrumMark = {
  id: string;
  label: string;
  value: number;
  kind: "price" | "bear" | "lower" | "expected" | "base" | "upper" | "bull";
  date?: string;
};

type PlacedMark = SpectrumMark & {
  posPct: number;
  labelPct: number;
  lane: "top" | "bottom";
};

/**
 * Assign alternating top/bottom callout lanes and gently separate adjacent label centers on the same lane
 * so tightly clustered figures (such as Bear $53.44 and Close $53.13) never collide.
 */
function placeMarks(items: SpectrumMark[], min: number, max: number): PlacedMark[] {
  const span = max - min || 1;
  const pctAt = (v: number) => Math.max(2, Math.min(98, ((v - min) / span) * 100));
  const sorted = [...items]
    .sort((a, b) => a.value - b.value)
    .map((item, idx) => ({
      ...item,
      posPct: pctAt(item.value),
      labelPct: pctAt(item.value),
      lane: (item.kind === "price" ? "bottom" : idx % 2 === 0 ? "top" : "bottom") as "top" | "bottom",
    }));

  // Ensure items within 14% width sit on opposite lanes when possible.
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    if (curr.posPct - prev.posPct < 15 && curr.lane === prev.lane && curr.kind !== "price") {
      curr.lane = prev.lane === "top" ? "bottom" : "top";
    }
  }
  // Nudge same-lane items apart if there are 3+ clustered items on one side.
  for (const lane of ["top", "bottom"] as const) {
    const onLane = sorted.filter(x => x.lane === lane);
    for (let i = 1; i < onLane.length; i++) {
      const prev = onLane[i - 1]!;
      const curr = onLane[i]!;
      if (curr.labelPct - prev.labelPct < 18) {
        curr.labelPct = Math.min(92, prev.labelPct + 18);
      }
    }
    for (let i = onLane.length - 2; i >= 0; i--) {
      const curr = onLane[i]!;
      const next = onLane[i + 1]!;
      if (next.labelPct - curr.labelPct < 18) {
        curr.labelPct = Math.max(8, next.labelPct - 18);
      }
    }
  }
  return sorted;
}

const signedPct = (v: number | null | undefined) => v == null || !Number.isFinite(v)
  ? "—"
  : `${v > 0 ? "+" : v < 0 ? "−" : ""}${(Math.abs(v) * 100).toFixed(1)}%`;

function useLightTheme(): boolean {
  const [light, setLight] = useState(() => typeof document !== "undefined" && document.documentElement.classList.contains("light"));
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const sync = () => setLight(root.classList.contains("light"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return light;
}

const LIVE_POLL_MS = 60_000;

type ValuationCheckpoint = {
  date: string;
  generatedAt: string;
  low: number;
  mid: number;
  high: number;
};

type TimelinePoint = {
  time: string;
  low: number;
  mid: number;
  high: number;
  changed: boolean;
  effectiveDate: string;
};

function buildValuationCheckpoints(
  report: ValuationPublication,
  versions: ValuationResponse["versions"] | undefined,
  basis: "normal" | "stress",
  currentBounds: { low: number; mid: number; high: number },
): ValuationCheckpoint[] {
  const byDate = new Map<string, ValuationCheckpoint>();
  const put = (cp: ValuationCheckpoint) => {
    const prev = byDate.get(cp.date);
    if (!prev || cp.generatedAt >= prev.generatedAt) byDate.set(cp.date, cp);
  };

  for (const v of versions ?? []) {
    if (v.reportStatus !== "ready" || v.generatedAt > report.generatedAt) continue;
    const range = basis === "normal" ? v.normalRange : v.stressRange;
    if (!range || !finite(range.low) || !finite(range.base) || !finite(range.high)) continue;
    const date = (v.researchAsOf || v.generatedAt).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      put({ date, generatedAt: v.generatedAt, low: range.low, mid: range.base, high: range.high });
    }
  }

  const currentVersion = versions?.find(v => v.versionId === report.versionId);
  const currentDate = (currentVersion?.researchAsOf || report.researchAsOf || report.generatedAt).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(currentDate)) {
    put({ date: currentDate, generatedAt: report.generatedAt, ...currentBounds });
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Aligns historical valuation range checkpoints onto the daily candlestick timeline:
 * preserves each historical range prior to subsequent change dates, shifts cleanly on each
 * change date, and clamps any weekend/pre-market update onto the latest bar so live bounds stay visible.
 */
function buildValuationTimeline(bars: DailyPriceBar[], checkpoints: ValuationCheckpoint[]): TimelinePoint[] {
  if (!bars.length || !checkpoints.length) return [];
  const lastBarDate = bars.at(-1)!.time;

  const effectiveByDate = new Map<string, ValuationCheckpoint>();
  for (const cp of checkpoints) {
    const effective = cp.date > lastBarDate ? lastBarDate : cp.date;
    const prev = effectiveByDate.get(effective);
    if (!prev || cp.generatedAt >= prev.generatedAt) {
      effectiveByDate.set(effective, { ...cp, date: effective });
    }
  }
  const ordered = [...effectiveByDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const timeline: TimelinePoint[] = [];
  let idx = 0;
  let prevLow: number | null = null;
  let prevHigh: number | null = null;

  for (const bar of bars) {
    while (idx + 1 < ordered.length && ordered[idx + 1]!.date <= bar.time) idx++;
    const active = ordered[idx]!;
    const changed = prevLow != null && prevHigh != null && (
      Math.abs(active.low - prevLow) > 1e-6 || Math.abs(active.high - prevHigh) > 1e-6
    );
    timeline.push({
      time: bar.time,
      low: active.low,
      mid: active.mid,
      high: active.high,
      changed,
      effectiveDate: active.date,
    });
    prevLow = active.low;
    prevHigh = active.high;
  }
  return timeline;
}

/**
 * Lightweight Charts series primitive that paints a light-green translucent fair-value corridor
 * following the historical upper/lower bound polylines point-by-point.
 */
class FairValueCorridorPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<"Candlestick", Time> | null = null;
  private readonly points: TimelinePoint[];
  private readonly fillColor: string;
  private readonly view: IPrimitivePaneView;

  constructor(points: TimelinePoint[], fillColor: string) {
    this.points = points;
    this.fillColor = fillColor;
    this.view = {
      zOrder: () => "bottom",
      renderer: () => ({
        draw: target => {
          const chart = this.chart;
          const series = this.series;
          if (!chart || !series || this.points.length < 2) return;
          const timeScale = chart.timeScale();
          const coords: Array<{ x: number; yHigh: number; yLow: number }> = [];
          for (const pt of this.points) {
            const x = timeScale.timeToCoordinate(pt.time as Time);
            const yHigh = series.priceToCoordinate(pt.high);
            const yLow = series.priceToCoordinate(pt.low);
            if (x == null || yHigh == null || yLow == null) continue;
            coords.push({ x, yHigh, yLow });
          }
          if (coords.length < 2) return;

          target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio, verticalPixelRatio }) => {
            context.save();
            context.beginPath();
            context.moveTo(coords[0]!.x * horizontalPixelRatio, coords[0]!.yHigh * verticalPixelRatio);
            for (let i = 1; i < coords.length; i++) {
              context.lineTo(coords[i]!.x * horizontalPixelRatio, coords[i]!.yHigh * verticalPixelRatio);
            }
            for (let i = coords.length - 1; i >= 0; i--) {
              context.lineTo(coords[i]!.x * horizontalPixelRatio, coords[i]!.yLow * verticalPixelRatio);
            }
            context.closePath();
            context.fillStyle = this.fillColor;
            context.fill();
            context.restore();
          });
        },
      }),
    };
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart as IChartApi;
    this.series = param.series as ISeriesApi<"Candlestick", Time>;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }
}

function readThemePalette(light: boolean) {
  const styles = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const pick = (name: string, fallback: string) => styles?.getPropertyValue(name).trim() || fallback;
  return {
    background: pick("--surface", light ? "#ffffff" : "#0d0d0d"),
    text: pick("--muted-foreground", light ? "#55685f" : "#a1a1a1"),
    border: pick("--border", light ? "#dbe3dd" : "#2a2a2a"),
    grid: light ? "rgba(11, 31, 26, 0.06)" : "rgba(255, 255, 255, 0.06)",
    up: pick("--up", light ? "#096b5f" : "#79d9cd"),
    loss: pick("--loss", light ? "#a33d34" : "#f08e83"),
    bandFill: light ? "rgba(34, 197, 94, 0.13)" : "rgba(74, 222, 128, 0.12)",
    mono: pick("--mono", "ui-monospace, monospace"),
  };
}

function useLiveMarketDaily(ticker: string): { data: LiveMarketDaily | null; status: "loading" | "ready" | "unavailable" } {
  const [state, setState] = useState<{ ticker: string; data: LiveMarketDaily | null; status: "loading" | "ready" | "unavailable" }>({
    ticker,
    data: null,
    status: "loading",
  });

  useEffect(() => {
    let active = true;
    let currentAbort: AbortController | null = null;

    const load = async (initial: boolean) => {
      if (initial && active) setState(prev => prev.ticker === ticker && prev.data ? prev : { ticker, data: null, status: "loading" });
      currentAbort?.abort();
      const abort = new AbortController();
      currentAbort = abort;
      try {
        const res = await fetch(`/api/business/v1/companies/${encodeURIComponent(ticker)}/market-daily`, {
          signal: abort.signal,
          headers: { accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json() as LiveMarketDaily;
        if (!active || abort.signal.aborted) return;
        if (body?.schemaVersion === "market-daily.v1" && Array.isArray(body.bars) && body.bars.length > 0) {
          setState({ ticker, data: body, status: "ready" });
        } else {
          setState(prev => prev.ticker === ticker && prev.data ? prev : { ticker, data: null, status: "unavailable" });
        }
      } catch {
        if (!active || abort.signal.aborted) return;
        setState(prev => prev.ticker === ticker && prev.data ? prev : { ticker, data: null, status: "unavailable" });
      }
    };

    void load(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(false);
    }, LIVE_POLL_MS);

    return () => {
      active = false;
      currentAbort?.abort();
      window.clearInterval(timer);
    };
  }, [ticker]);

  return state.ticker === ticker
    ? { data: state.data, status: state.status }
    : { data: null, status: "loading" };
}

/**
 * Full-width TradingView Lightweight Charts daily candlestick chart locked to the 1D interval,
 * with moving upper/lower valuation boundary polylines and shaded fair-value corridor that adjust
 * from each valuation change date while preserving historical valuation records.
 */
export function LivePriceValuationTool({ report, guide, versions }: {
  report: ValuationPublication;
  guide: ValuationPriceGuide;
  versions?: ValuationResponse["versions"];
}) {
  const locale = useLocale();
  const light = useLightTheme();
  const chartHostRef = useRef<HTMLDivElement>(null);
  const model = report.model;
  const symbol = report.ticker.trim().toUpperCase();
  const { data: market, status: marketStatus } = useLiveMarketDaily(symbol);

  const fair = model?.fairValueRange;
  const hasNormal = fair?.status === "available" && finite(fair.low) && finite(fair.base) && finite(fair.high);
  const hasStress = !!model && finite(model.range.low) && finite(model.range.base) && finite(model.range.high);
  const rangesDiffer = hasNormal && hasStress && (
    Math.abs(fair.low - model.range.low) > 0.01 || Math.abs(fair.high - model.range.high) > 0.01
  );

  const defaultBasis = hasNormal ? "normal" : "stress";
  const [basis, setBasis] = useState<"normal" | "stress">(defaultBasis);
  const [syncKey, setSyncKey] = useState(() => `${report.ticker}:${report.versionId}`);
  const nextSyncKey = `${report.ticker}:${report.versionId}`;
  if (syncKey !== nextSyncKey) {
    setSyncKey(nextSyncKey);
    setBasis(defaultBasis);
  }
  const activeBasis = basis === "normal" && hasNormal ? "normal" : hasStress ? "stress" : "normal";

  const bandLow = model ? (activeBasis === "normal" && hasNormal ? fair.low : model.range.low) : null;
  const bandMid = model ? (activeBasis === "normal" && hasNormal ? fair.base : (fair?.status === "available" ? fair.base : model.range.base)) : null;
  const bandHigh = model ? (activeBasis === "normal" && hasNormal ? fair.high : model.range.high) : null;

  const timeline = useMemo(() => {
    if (!market?.bars.length || !finite(bandLow) || !finite(bandMid) || !finite(bandHigh)) return [] as TimelinePoint[];
    const checkpoints = buildValuationCheckpoints(report, versions, activeBasis, { low: bandLow, mid: bandMid, high: bandHigh });
    return buildValuationTimeline(market.bars, checkpoints);
  }, [market, report, versions, activeBasis, bandLow, bandMid, bandHigh]);

  const timelineByTime = useMemo(() => new Map(timeline.map(pt => [pt.time, pt])), [timeline]);

  const [hoveredBar, setHoveredBar] = useState<DailyPriceBar | null>(null);

  useEffect(() => {
    const container = chartHostRef.current;
    if (!container || !market?.bars.length || !timeline.length) return;

    const palette = readThemePalette(light);
    const chart = createChart(container, {
      width: container.clientWidth || 720,
      height: container.clientHeight || 400,
      layout: {
        background: { type: ColorType.Solid, color: palette.background },
        textColor: palette.text,
        fontFamily: palette.mono,
        fontSize: 11,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid },
      },
      rightPriceScale: {
        borderColor: palette.border,
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderColor: palette.border,
        timeVisible: false,
        secondsVisible: false,
        rightOffset: 6,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: palette.border, labelBackgroundColor: palette.border },
        horzLine: { color: palette.border, labelBackgroundColor: palette.border },
      },
      localization: {
        locale: locale === "zh-CN" ? "zh-CN" : "en-US",
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: palette.up,
      downColor: palette.loss,
      borderVisible: false,
      wickUpColor: palette.up,
      wickDownColor: palette.loss,
      priceLineVisible: true,
      lastValueVisible: true,
    });
    candleSeries.setData(market.bars);

    // Light-green translucent fair-value corridor following the moving upper/lower polylines.
    candleSeries.attachPrimitive(new FairValueCorridorPrimitive(timeline, palette.bandFill));

    // Solid red upper boundary polyline & solid green lower boundary polyline: adjust on each change date, preserve history.
    const upperSeries = chart.addSeries(LineSeries, {
      color: palette.loss,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      lineType: LineType.Simple,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3.5,
      title: m.upperBound,
    });
    upperSeries.setData(timeline.map(pt => ({ time: pt.time, value: pt.high })));

    const lowerSeries = chart.addSeries(LineSeries, {
      color: palette.up,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      lineType: LineType.Simple,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3.5,
      title: m.lowerBound,
    });
    lowerSeries.setData(timeline.map(pt => ({ time: pt.time, value: pt.low })));

    chart.timeScale().fitContent();

    const byTime = new Map(market.bars.map(bar => [bar.time, bar]));
    const onCrosshair = (param: { time?: Time }) => {
      const bar = typeof param.time === "string" ? byTime.get(param.time) ?? null : null;
      setHoveredBar(bar);
    };
    chart.subscribeCrosshairMove(onCrosshair);

    let rafId = 0;
    const ro = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        chart.applyOptions({
          width: Math.max(240, Math.floor(rect.width)),
          height: Math.max(260, Math.floor(rect.height)),
        });
      });
    });
    ro.observe(container);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
      setHoveredBar(null);
    };
  }, [market, timeline, light, locale]);

  if (!model || !finite(bandLow) || !finite(bandMid) || !finite(bandHigh)) return null;

  const latestBar = market?.bars.at(-1) ?? null;
  const activeBar = hoveredBar ?? latestBar;
  const activePoint = activeBar ? timelineByTime.get(activeBar.time) ?? null : null;
  const livePrice = market?.livePrice ?? latestBar?.close ?? guide.quote?.price ?? report.quote?.price ?? model.range.price ?? null;
  const prevClose = hoveredBar
    ? (() => {
        const idx = market?.bars.findIndex(b => b.time === hoveredBar.time) ?? -1;
        return idx > 0 ? market!.bars[idx - 1]!.close : null;
      })()
    : market?.previousClose ?? (market && market.bars.length >= 2 ? market.bars.at(-2)!.close : null);

  const shownPrice = activeBar?.close ?? livePrice;
  const dayChange = shownPrice != null && prevClose != null && prevClose > 0 ? (shownPrice - prevClose) / prevClose : null;

  const money = (v: number) => perShare(v, model.currency, locale);

  return (
    <div className="val-spec-row val-tv-row">
      <div className="val-spec-head">
        <div className="val-tv-title-group">
          <span className="val-spec-title">{m.liveFairRange}</span>
          {rangesDiffer && (
            <div className="val-tv-basis" role="tablist" aria-label={m.liveFairRange}>
              <button type="button" role="tab" aria-selected={activeBasis === "normal"} onClick={() => setBasis("normal")}>
                {m.basisNormal}
              </button>
              <button type="button" role="tab" aria-selected={activeBasis === "stress"} onClick={() => setBasis("stress")}>
                {m.basisStress}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="val-tv-stage">
        {activeBar && (
          <div className="val-tv-hud" aria-live="polite">
            <span className="val-tv-hud-date">{activeBar.time}</span>
            <span className="val-tv-hud-ohlc">
              <span><small>{m.openLabel}</small> {activeBar.open.toFixed(2)}</span>
              <span><small>{m.highLabel}</small> {activeBar.high.toFixed(2)}</span>
              <span><small>{m.lowLabel}</small> {activeBar.low.toFixed(2)}</span>
              <span><small>{m.closeLabel}</small> <b>{activeBar.close.toFixed(2)}</b></span>
            </span>
            {dayChange != null && (
              <span className="val-tv-hud-chg" data-sign={dayChange > 0 ? "up" : dayChange < 0 ? "down" : undefined}>
                {signedPct(dayChange)}
              </span>
            )}
            {activePoint && (
              <span className="val-tv-hud-range">
                <small>{m.hudRange}</small> {activePoint.low.toFixed(2)} – {activePoint.high.toFixed(2)}
              </span>
            )}
          </div>
        )}
        <div
          ref={chartHostRef}
          className="val-tv-chart-host"
          role="img"
          aria-label={`${symbol} · ${m.dailyChartAria} · ${money(bandLow)} – ${money(bandHigh)}`}
        />
        {marketStatus === "loading" && !market && (
          <div className="val-tv-overlay" role="status">{m.loadingChart}</div>
        )}
        {marketStatus === "unavailable" && !market && (
          <div className="val-tv-overlay" role="status">{m.chartUnavailable}</div>
        )}
      </div>
    </div>
  );
}

/**
 * Displays the 12-month normal operating range bar paired with the embedded TradingView daily live fair-value tool.
 */
export function DualSpectrum({ report, guide, versions }: {
  report: ValuationPublication;
  guide: ValuationPriceGuide;
  versions?: ValuationResponse["versions"];
}) {
  const locale = useLocale();
  const model = report.model;
  if (!model) return null;

  const fair = model.fairValueRange;
  const normalOk = fair?.status === "available" && (guide.status === "available" || guide.reason === "no_quote" || guide.reason === "unusable_quote" || guide.reason === "stale_quote" || guide.reason === "currency_mismatch");
  const latestQuote = guide.quote;

  const normalValues = [
    ...(normalOk ? [fair.low, fair.base, fair.high] : []),
    latestQuote?.price,
  ].filter(finite);

  const hasTool = (fair?.status === "available" && finite(fair.low) && finite(fair.high))
    || (finite(model.range.low) && finite(model.range.high));
  if (!normalValues.length && !hasTool) return null;

  const rawMin = normalValues.length ? Math.min(...normalValues) : 0;
  const rawMax = normalValues.length ? Math.max(...normalValues) : 1;
  const pad = Math.max((rawMax - rawMin) * 0.09, 1);
  const lo = rawMin < 0 ? rawMin - pad : Math.max(0, rawMin - pad);
  const hi = rawMax + pad;
  const pctAt = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100));
  const money = (v: number) => perShare(v, model.currency, locale);

  const normalMarks: SpectrumMark[] = normalOk ? [
    ...(latestQuote ? [{ id: "latest", label: m.latestQuote, value: latestQuote.price, kind: "price" as const, date: latestQuote.priceDate }] : []),
    { id: "n-low", label: m.normalLow, value: fair.low, kind: "lower" },
    { id: "n-base", label: m.base, value: fair.base, kind: "base" },
    { id: "n-high", label: m.normalHigh, value: fair.high, kind: "upper" },
  ] : [];

  const placedNormal = placeMarks(normalMarks, lo, hi);
  const zeroLeft = lo < 0 && hi > 0 ? pctAt(0) : null;

  return (
    <div className="val-spectrum" role="region" aria-label={m.spectrumAria}>
      {normalOk && (
        <div className="val-spec-row" data-tone="normal">
          <div className="val-spec-head">
            <span className="val-spec-title">{m.normalTrack}</span>
            <span className="val-spec-span">{money(fair.low)} – {money(fair.high)}</span>
          </div>
          <div className="val-spec-plot">
            <div className="val-spec-rail">
              {zeroLeft != null && <i className="val-spec-zero" style={{ left: `${zeroLeft.toFixed(2)}%` }} aria-hidden="true" />}
              <span
                className="val-spec-band"
                style={{
                  left: `${pctAt(Math.min(fair.low, fair.high)).toFixed(2)}%`,
                  width: `${Math.max(1, pctAt(Math.max(fair.low, fair.high)) - pctAt(Math.min(fair.low, fair.high))).toFixed(2)}%`,
                }}
              />
              {placedNormal.map(mark => (
                <span
                  key={mark.id}
                  className="val-spec-pin"
                  data-kind={mark.kind}
                  data-lane={mark.lane}
                  style={{ left: `${mark.posPct.toFixed(2)}%` }}
                  title={`${mark.label} · ${money(mark.value)}${mark.date ? ` · ${mark.date}` : ""}`}
                >
                  <i aria-hidden="true" />
                </span>
              ))}
            </div>
            {placedNormal.map(mark => (
              <span
                key={mark.id}
                className="val-spec-callout"
                data-kind={mark.kind}
                data-lane={mark.lane}
                style={{ left: `${mark.labelPct.toFixed(2)}%` }}
              >
                <b>{money(mark.value)}</b>
                <small>{mark.label}</small>
              </span>
            ))}
          </div>
          <ul className="val-spec-legend" aria-label={m.normalTrack}>
            {placedNormal.map(mark => (
              <li key={mark.id} data-kind={mark.kind}>
                <i aria-hidden="true" />
                <span>{mark.label}</span>
                <b>{money(mark.value)}</b>
                {mark.date && <small>{mark.date}</small>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <LivePriceValuationTool report={report} guide={guide} versions={versions} />
    </div>
  );
}

/**
 * Football-field comparison of the valuation methods (Cash Flow, Forward EV/EBITDA, Forward P/E)
 * showing each method's range, weighted contribution, and reference price pin.
 */
export function MethodBridge({ methods, weightedBase, price, currency }: {
  methods: MethodValuation[];
  weightedBase: number | null;
  price: number | null;
  currency: string;
}) {
  const locale = useLocale();
  if (!methods.length) return null;
  const activeValues = methods.flatMap(item => [item.low, item.base, item.high]).filter(finite);
  if (weightedBase != null && Number.isFinite(weightedBase)) activeValues.push(weightedBase);
  if (price != null && Number.isFinite(price)) activeValues.push(price);

  const rawMin = activeValues.length ? Math.min(...activeValues) : 0;
  const rawMax = activeValues.length ? Math.max(...activeValues) : 1;
  const pad = Math.max((rawMax - rawMin) * 0.08, 1);
  const lo = rawMin < 0 ? rawMin - pad : Math.max(0, rawMin - pad);
  const hi = rawMax + pad;
  const pctAt = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100));
  const money = (v: number) => perShare(v, currency, locale);

  const baseVals = methods.filter(item => item.weight > 0 && finite(item.base)).map(item => item.base as number);
  let dispersion: string | null = null;
  if (baseVals.length >= 2) {
    const low = Math.min(...baseVals), high = Math.max(...baseVals);
    if (low > 0 && high / low > 1.05) {
      dispersion = `${(high / low).toFixed(2)}${locale === "zh-CN" ? "倍" : "×"}`;
    }
  }

  return (
    <div className="val-methods" role="region" aria-label={m.methodsTitle}>
      <div className="val-methods-head">
        <h4>{m.methodsTitle}</h4>
        <div className="val-methods-meta">
          {dispersion && <span className="val-chip">{m.dispersionNote(dispersion)}</span>}
          {weightedBase != null && Number.isFinite(weightedBase) && (
            <span className="val-chip val-chip--strong">{m.weightedBase} <b>{money(weightedBase)}</b></span>
          )}
        </div>
      </div>
      <div className="val-methods-list">
        {methods.map(item => {
          const usable = finite(item.low) && finite(item.base) && finite(item.high);
          const name = VALUATION_METHODS.includes(item.method) ? METHOD_LABEL[item.method] : item.label;
          const left = usable ? pctAt(Math.min(item.low!, item.high!)) : 0;
          const width = usable ? Math.max(1.5, pctAt(Math.max(item.low!, item.high!)) - left) : 0;
          const basePos = usable ? pctAt(item.base!) : 0;
          return (
            <div key={item.method} className="val-method-row" data-unused={item.weight <= 0 || !usable ? "" : undefined}>
              <div className="val-method-info">
                <span className="val-method-name">{name}</span>
                <span className="val-method-weight">{item.weight > 0 ? pct(item.weight, 0) : m.notApplied}</span>
              </div>
              <div className="val-method-bar-wrap">
                {usable ? (
                  <div className="val-method-track">
                    {lo < 0 && hi > 0 && <i className="val-method-zero" style={{ left: `${pctAt(0).toFixed(2)}%` }} aria-hidden="true" />}
                    {price != null && Number.isFinite(price) && (
                      <i className="val-method-ref val-method-ref--price" style={{ left: `${pctAt(price).toFixed(2)}%` }} title={`${m.latestQuote} · ${money(price)}`} />
                    )}
                    {weightedBase != null && Number.isFinite(weightedBase) && (
                      <i className="val-method-ref val-method-ref--base" style={{ left: `${pctAt(weightedBase).toFixed(2)}%` }} title={`${m.weightedBase} · ${money(weightedBase)}`} />
                    )}
                    <span className="val-method-band" style={{ left: `${left.toFixed(2)}%`, width: `${width.toFixed(2)}%` }} />
                    <i className="val-method-tick" style={{ left: `${basePos.toFixed(2)}%` }} />
                  </div>
                ) : (
                  <div className="val-method-empty" lang={langOf(item.notes[0] ?? item.basis)}>{item.notes[0] ?? item.basis}</div>
                )}
              </div>
              <div className="val-method-nums">
                {usable ? <>
                  <small>{money(item.low!)}</small>
                  <b>{money(item.base!)}</b>
                  <small>{money(item.high!)}</small>
                </> : <span>—</span>}
              </div>
              {usable && item.basis && <p className="val-method-basis" lang={langOf(item.basis)}>{item.basis}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Multi-year build trajectory chart (Revenue, CapEx / Reinvestment, FCFF) paired with a responsive sticky table.
 */
export function YearlyTrajectory({ yearly, currency, explicitCapital, normalization }: {
  yearly: YearRow[];
  currency: string;
  explicitCapital: boolean;
  normalization?: number[];
}) {
  const locale = useLocale();
  if (!yearly.length) return null;

  const capVal = (row: YearRow) => explicitCapital ? (row.capex ?? 0) : (row.reinvestment ?? 0);
  const allVals = yearly.flatMap(r => [r.revenue ?? 0, capVal(r), r.cashFlow]);
  const minV = Math.min(0, ...allVals);
  const maxV = Math.max(0, ...allVals);
  const span = maxV - minV || 1;
  const padMax = maxV + span * 0.08;
  const padMin = minV < 0 ? minV - span * 0.08 : 0;

  const W = 680, H = 200, ML = 56, MR = 14, MT = 14, MB = 26;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const yOf = (v: number) => MT + ((padMax - v) / (padMax - padMin || 1)) * plotH;
  const yZero = yOf(0);
  const groupW = plotW / yearly.length;
  const barW = Math.min(14, Math.max(5, (groupW - 14) / 3));

  const ticks = [padMax, padMax > 0 && padMin < 0 ? 0 : padMax * 0.5, padMin < 0 ? padMin : 0];
  const money = (value: number | null | undefined) => value == null ? "—" : compactMoney(value, currency, locale);
  const adjusted = normalization?.some(value => value !== 0);

  return (
    <div className="val-trajectory">
      <div className="val-trajectory-head">
        <div className="val-trajectory-legend">
          <span><i data-series="rev" />{m.revenue}</span>
          <span><i data-series="cap" />{explicitCapital ? m.capex : m.reinvestment}</span>
          <span><i data-series="fcf-pos" />{m.fcff} (+)</span>
          {minV < 0 && <span><i data-series="fcf-neg" />{m.fcff} (−)</span>}
        </div>
        <span className="val-trajectory-unit">{axisUnit(currency, locale)}</span>
      </div>
      <div className="val-trajectory-svg-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} className="val-trajectory-svg" role="img" aria-label={m.trajectoryAria}>
          {ticks.map((t, i) => {
            const y = yOf(t);
            const isZero = Math.abs(t) < 1e-6;
            return (
              <g key={i}>
                <line x1={ML} y1={y} x2={W - MR} y2={y} className={isZero ? "val-traj-zero" : "val-traj-grid"} />
                <text x={ML - 8} y={y + 4} textAnchor="end" className="val-traj-tick">{axisNumber(t, locale)}</text>
              </g>
            );
          })}
          {yearly.map((row, idx) => {
            const cx = ML + idx * groupW + groupW / 2;
            const rev = row.revenue ?? 0;
            const cap = capVal(row);
            const fcf = row.cashFlow;
            const drawBar = (v: number, x: number, cls: string) => {
              const yTop = v >= 0 ? yOf(v) : yZero;
              const h = Math.max(1.5, Math.abs(yOf(v) - yZero));
              return <rect x={x} y={yTop} width={barW} height={h} rx={2} className={cls} />;
            };
            const tip = `${m.forecastYear(row.year)} · ${m.revenue} ${money(row.revenue)} · ${explicitCapital ? m.capex : m.reinvestment} ${money(cap)} · ${m.fcff} ${money(fcf)}`;
            return (
              <g key={row.year} className="val-traj-group">
                <title>{tip}</title>
                {drawBar(rev, cx - barW * 1.6, "val-traj-bar-rev")}
                {drawBar(cap, cx - barW * 0.5, "val-traj-bar-cap")}
                {drawBar(fcf, cx + barW * 0.6, fcf >= 0 ? "val-traj-bar-fcf-up" : "val-traj-bar-fcf-down")}
                <text x={cx} y={H - 6} textAnchor="middle" className="val-traj-xlabel">{m.yearShort(row.year)}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="val-table-wrap" tabIndex={0} role="region" aria-label={m.trajectoryAria}>
        <table className="val-table val-table--yearly">
          <thead>
            <tr>
              <th>{m.yearCol}</th>
              <th>{m.revenue}</th>
              <th>{m.nopat}</th>
              {explicitCapital ? <><th>{m.capex}</th><th>{m.depreciationCol}</th><th>{m.workingCapitalCol}</th></> : <th>{m.reinvestment}</th>}
              {adjusted && <th>{m.adjustmentCol}</th>}
              <th>{m.fcff}</th>
            </tr>
          </thead>
          <tbody>
            {yearly.map(row => (
              <tr key={row.year}>
                <th>{m.forecastYear(row.year)}</th>
                <td>{money(row.revenue)}</td>
                <td>{money(row.nopat)}</td>
                {explicitCapital ? <><td>{money(row.capex)}</td><td>{money(row.depreciation)}</td><td>{money(row.workingCapitalChange)}</td></> : <td>{money(row.reinvestment)}</td>}
                {adjusted && <td>{money(normalization?.[row.year - 1])}</td>}
                <td data-sign={row.cashFlow >= 0 ? "up" : "down"}>{money(row.cashFlow)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Centered zero-axis bidirectional sensitivity bars sorted by absolute percentage impact.
 */
export function SensitivityTornado({ sensitivities, currency }: {
  sensitivities: Sensitivity[];
  currency: string;
}) {
  const locale = useLocale();
  if (!sensitivities.length) return null;
  const sorted = [...sensitivities].sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
  const maxAbs = Math.max(...sorted.map(s => Math.abs(s.changePercent)), 1);

  return (
    <ol className="val-tornado" aria-label={m.sensitivityAria}>
      {sorted.map(s => {
        const up = s.changePercent >= 0;
        const pctWidth = Math.min(100, (Math.abs(s.changePercent) / maxAbs) * 100);
        const knownFactor = s.factor in FACTOR_LABEL;
        const factorName = knownFactor ? FACTOR_LABEL[s.factor as keyof typeof FACTOR_LABEL] : s.factor;
        return (
          <li key={`${s.factor}-${s.step}`}>
            <span className="val-tornado-label">
              <span lang={knownFactor ? undefined : langOf(s.factor)}>{factorName}</span>
              <small lang={langOf(s.step)}>{s.step}</small>
            </span>
            <span className="val-tornado-track" aria-hidden="true">
              <span className="val-tornado-neg">
                {!up && <i style={{ width: `${pctWidth.toFixed(1)}%` }} />}
              </span>
              <span className="val-tornado-axis" />
              <span className="val-tornado-pos">
                {up && <i style={{ width: `${pctWidth.toFixed(1)}%` }} />}
              </span>
            </span>
            <b data-sign={up ? "up" : "down"}>
              {formatPct(s.changePercent, { signed: true })} · {perShare(s.perShare, currency, locale)}
            </b>
          </li>
        );
      })}
    </ol>
  );
}
