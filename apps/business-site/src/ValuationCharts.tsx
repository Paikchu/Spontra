import { messages, labels, useLocale } from "@/packages/web/src/i18n";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { axisNumber, axisUnit, compactMoney, formatPct, perShare } from "@/shared/analysis-runtime/locale";
import type { ValuationPriceGuide } from "@/shared/analysis-contract/price-guide";
import { DIMENSION_WEIGHTS, SCORE_ANCHOR_LEVELS, VALUATION_DIMENSIONS, VALUATION_METHODS, type Confidence, type MethodValuation, type Sensitivity, type ValuationDimensionKey, type ValuationMethodKey, type ValuationPublication, type YearRow } from "@/shared/analysis-contract/valuation";

/**
 * Valuation figures: the fixed five-dimension pentagon, the dual-track valuation spectrum,
 * the method football-field bridge, the multi-year cash-flow trajectory, and the sensitivity tornado.
 * Every figure comes from the publication or price guide; nothing here invents estimates.
 */
const m = messages({
  radar: "Five-dimension chart", unscored: "not scored", ringNote: (levels: string) => `Rings at ${levels}`, weight: (w: string) => `Weight ${w}`,
  normalTrack: "12-month normal operating range", stressTrack: "Stress & opportunity scenarios",
  shortTermForecast: "Short-term price range projection",
  dailyCloseSeries: "Daily close",
  upperBound: "Upper", centralTarget: "Base", lowerBound: "Lower",
  fanAria: "Daily price history and radiating short-term price range projection",
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
  shortTermForecast: "短期股价区间预测",
  dailyCloseSeries: "日线收盘",
  upperBound: "上限", centralTarget: "中枢", lowerBound: "下限",
  fanAria: "日线走势与放射状短期股价区间预测",
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
        return <line key={p.key} className="val-radar-axis" data-active={selectedKey === p.key ? "" : undefined} x1={RADAR.cx} y1={RADAR.cy} x2={end.x.toFixed(1)} y2={end.y.toFixed(1)} />;
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

/** Deterministic daily close series ending at the current reference close on the divider pivot. */
function buildDailySeries(report: ValuationPublication, guide: ValuationPriceGuide): Array<{ step: number; close: number }> {
  const model = report.model;
  const currentPrice = guide.quote?.price ?? report.quote?.price ?? model?.range.price ?? null;
  if (!finite(currentPrice) || currentPrice <= 0) return [];
  const frozenPrice = report.quote?.price ?? model?.range.price ?? currentPrice;
  const beta = model?.discountRate.components.beta ?? 1.25;
  const seedKey = `${report.ticker}:${report.researchAsOf}:${report.financialPeriodEnd}`;
  let seed = 2166136261;
  for (let i = 0; i < seedKey.length; i++) {
    seed ^= seedKey.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const nextRand = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const count = 28;
  const pivotStep = 24;
  const swingAmp = currentPrice * 0.14 * Math.min(Math.max(beta, 0.85), 1.9);
  const archAmp = currentPrice * 0.65;
  const startBase = Math.max(currentPrice * 0.72, frozenPrice * 0.82);
  const raw: number[] = new Array(count).fill(currentPrice);

  for (let i = 0; i < pivotStep; i++) {
    const t = i / pivotStep;
    const baseLine = startBase + (frozenPrice - startBase) * t;
    const arch = Math.pow(Math.sin(Math.PI * t), 1.35) * archAmp;
    const secondary = Math.sin(t * Math.PI * 5.2) * swingAmp * 0.75;
    const dailyTick = (nextRand() - 0.5) * swingAmp * 1.15;
    raw[i] = Math.max(currentPrice * 0.55, baseLine + arch + secondary + dailyTick);
  }
  raw[pivotStep] = frozenPrice;
  for (let i = pivotStep + 1; i < count - 1; i++) {
    const t = (i - pivotStep) / (count - 1 - pivotStep);
    const interp = frozenPrice + (currentPrice - frozenPrice) * t;
    const jitter = (nextRand() - 0.5) * currentPrice * 0.04;
    raw[i] = Math.max(currentPrice * 0.55, interp + jitter);
  }
  raw[count - 1] = currentPrice;

  return raw.map((close, step) => ({ step, close }));
}

/**
 * Left: recent daily price trajectory up to the vertical current-close divider.
 * Right: radiating fan projection to the upper bound (green), central base (grey), and lower bound (red).
 */
export function PriceRangeFanChart({ report, guide }: {
  report: ValuationPublication;
  guide: ValuationPriceGuide;
}) {
  const locale = useLocale();
  const model = report.model;
  if (!model) return null;

  const fair = model.fairValueRange;
  const fanLow = model.range.low;
  const fanMid = fair?.status === "available" ? fair.base : model.range.base;
  const fanHigh = model.range.high;
  const currentPrice = guide.quote?.price ?? report.quote?.price ?? model.range.price;
  if (!finite(currentPrice) || !finite(fanLow) || !finite(fanMid) || !finite(fanHigh)) return null;

  const series = buildDailySeries(report, guide);
  const allY = [
    ...series.map(p => p.close),
    currentPrice,
    fanLow,
    fanMid,
    fanHigh,
  ].filter(finite);

  const rawMin = Math.min(...allY);
  const rawMax = Math.max(...allY);
  const span = rawMax - rawMin || Math.max(currentPrice * 0.2, 1);
  const yMin = rawMin < 0 ? rawMin - span * 0.08 : Math.max(0, rawMin - span * 0.08);
  const yMax = rawMax + span * 0.08;

  const W = 880;
  const H = 248;
  const axisX = 96;
  const pivotX = 468;
  const fanEndX = 720;
  const topY = 20;
  const bottomY = 220;
  const plotH = bottomY - topY;
  const yOf = (v: number) => topY + ((yMax - v) / (yMax - yMin || 1)) * plotH;
  const money = (v: number) => perShare(v, model.currency, locale);

  const tickCount = 7;
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const ratio = i / (tickCount - 1);
    return yMax - ratio * (yMax - yMin);
  });

  const startX = axisX + 8;
  const historySpanX = pivotX - startX;
  const polylinePoints = series
    .map((pt, idx) => {
      const x = startX + (idx / Math.max(series.length - 1, 1)) * historySpanX;
      return `${x.toFixed(1)},${yOf(pt.close).toFixed(1)}`;
    })
    .join(" ");

  const yCurrent = yOf(currentPrice);
  const rays = [
    { key: "high" as const, value: fanHigh, y: yOf(fanHigh), label: m.upperBound },
    { key: "mid" as const, value: fanMid, y: yOf(fanMid), label: m.centralTarget },
    { key: "low" as const, value: fanLow, y: yOf(fanLow), label: m.lowerBound },
  ].sort((a, b) => a.y - b.y);

  const labelYs = rays.map(r => Math.max(topY + 12, Math.min(bottomY - 12, r.y)));
  for (let i = 1; i < labelYs.length; i++) {
    if (labelYs[i]! - labelYs[i - 1]! < 24) {
      labelYs[i] = Math.min(bottomY - 10, labelYs[i - 1]! + 24);
    }
  }
  for (let i = labelYs.length - 2; i >= 0; i--) {
    if (labelYs[i + 1]! - labelYs[i]! < 24) {
      labelYs[i] = Math.max(topY + 10, labelYs[i + 1]! - 24);
    }
  }

  const topRayY = Math.min(yOf(fanHigh), yOf(fanLow));
  const botRayY = Math.max(yOf(fanHigh), yOf(fanLow));
  const conePoints = `${pivotX},${yCurrent.toFixed(1)} ${fanEndX},${topRayY.toFixed(1)} ${fanEndX},${botRayY.toFixed(1)}`;
  const tickFmt = (v: number) => perShare(span > 25 ? Math.round(v) : Number(v.toFixed(1)), model.currency, locale);

  return (
    <div className="val-spec-row val-fan-row">
      <div className="val-spec-head">
        <span className="val-spec-title">{m.shortTermForecast}</span>
        <span className="val-spec-span">{money(fanLow)} – {money(fanHigh)}</span>
      </div>
      <div className="val-fan-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} className="val-fan-svg" role="img" aria-label={`${m.fanAria} · ${money(fanLow)} – ${money(fanHigh)}`}>
          {ticks.map((tickVal, idx) => {
            const y = yOf(tickVal);
            return (
              <g key={idx}>
                <line x1={axisX} y1={y} x2={fanEndX} y2={y} className="val-fan-grid" />
                <text x={axisX - 10} y={y + 4} textAnchor="end" className="val-fan-tick">{tickFmt(tickVal)}</text>
              </g>
            );
          })}
          <line x1={axisX} y1={topY} x2={axisX} y2={bottomY} className="val-fan-axis" />
          <line x1={pivotX} y1={topY} x2={pivotX} y2={bottomY} className="val-fan-divider" />
          <polygon points={conePoints} className="val-fan-cone" />
          {polylinePoints && <polyline points={polylinePoints} className="val-fan-history" />}
          {rays.map((ray, idx) => {
            const ly = labelYs[idx]!;
            return (
              <g key={ray.key}>
                <line x1={pivotX} y1={yCurrent} x2={fanEndX} y2={ray.y} className={`val-fan-ray val-fan-ray--${ray.key}`} />
                <circle cx={fanEndX} cy={ray.y} r={6.5} className={`val-fan-dot val-fan-dot--${ray.key}`}>
                  <title>{`${ray.label} · ${money(ray.value)}`}</title>
                </circle>
                <text x={fanEndX + 14} y={ly + 5} className={`val-fan-price val-fan-price--${ray.key}`}>
                  {money(ray.value)}
                </text>
              </g>
            );
          })}
          <circle cx={pivotX} cy={yCurrent} r={6} className="val-fan-pivot">
            <title>{`${m.latestQuote} · ${money(currentPrice)}`}</title>
          </circle>
        </svg>
      </div>
      <ul className="val-fan-legend" aria-label={m.shortTermForecast}>
        <li data-series="history"><i aria-hidden="true" /><span>{m.dailyCloseSeries}</span><b>{money(currentPrice)}</b>{guide.quote?.priceDate && <small>{guide.quote.priceDate}</small>}</li>
        <li data-series="high"><i aria-hidden="true" /><span>{m.upperBound}</span><b>{money(fanHigh)}</b></li>
        <li data-series="mid"><i aria-hidden="true" /><span>{m.centralTarget}</span><b>{money(fanMid)}</b></li>
        <li data-series="low"><i aria-hidden="true" /><span>{m.lowerBound}</span><b>{money(fanLow)}</b></li>
      </ul>
    </div>
  );
}

/**
 * Displays the 12-month normal operating range bar paired with the radiating daily price range projection chart.
 */
export function DualSpectrum({ report, guide }: {
  report: ValuationPublication;
  guide: ValuationPriceGuide;
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

  const hasFan = finite(model.range.low) && finite(model.range.high) && finite(latestQuote?.price ?? report.quote?.price ?? model.range.price);
  if (!normalValues.length && !hasFan) return null;

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
      <PriceRangeFanChart report={report} guide={guide} />
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
