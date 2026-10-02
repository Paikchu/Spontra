import type { HistoricalObservation, SecCanonicalSeriesId, SecHistorySnapshot } from "../../workers/pipeline/src/sec/analysis.ts";

export const FIGURE_DATES = ["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"] as const;
export const FIGURE_REPORT_DATE = "2026-06-30";
export const FIGURE_FILING_DATE = "2026-07-30";

/** Five quarters, so the newest quarter has a year-ago comparison. Amounts in USD. */
export const FIGURE_VALUES: Partial<Record<SecCanonicalSeriesId, number[]>> = {
  revenue: [1050, 1100, 1110, 1120, 1240],
  gross_profit: [630, 660, 670, 680, 769],
  operating_income: [280, 300, 310, 320, 384],
  net_income: [180, 190, 200, 210, 273],
  diluted_eps: [0.74, 0.78, 0.82, 0.86, 1.14],
  operating_cash_flow: [220, 230, 240, 250, 230],
  capex: [60, 70, 80, 90, 120],
  cash: [800, 820, 850, 900, 960],
  debt: [400, 400, 400, 400, 400],
  shares: [2430, 2430, 2420, 2410, 2400],
};

export function figureHistory(values = FIGURE_VALUES, overrides: Partial<Record<SecCanonicalSeriesId, Partial<HistoricalObservation>>> = {}, dates: readonly string[] = FIGURE_DATES): SecHistorySnapshot {
  const point = (seriesId: SecCanonicalSeriesId, date: string, value: number, extra: Partial<HistoricalObservation> = {}): HistoricalObservation => ({
    observationId: `xbrl:${seriesId}:${date}`, seriesId, metricKey: seriesId, value: String(value),
    unit: seriesId === "shares" ? "shares" : seriesId === "diluted_eps" ? "USD/shares" : seriesId.endsWith("_margin") ? "ratio" : "USD",
    ...(["shares", "diluted_eps"].includes(seriesId) || seriesId.endsWith("_margin") ? {} : { currency: "USD" }),
    basis: seriesId.endsWith("_margin") || seriesId === "free_cash_flow" ? "derived" : "gaap", periodScope: "quarter", endDate: date,
    sourceAccession: `acc-${date}`, sourceFiledAt: date, sourceVersion: "test", qualityStatus: "validated_xbrl", ...extra,
  });
  const series = Object.entries(values).map(([seriesId, list]) => ({
    seriesId: seriesId as SecCanonicalSeriesId,
    quarters: list!.map((value, i) => point(seriesId as SecCanonicalSeriesId, dates[i], value, overrides[seriesId as SecCanonicalSeriesId])).reverse(),
    annual: [],
  }));
  const derived = (id: SecCanonicalSeriesId, f: (i: number) => number | undefined) => {
    const quarters = dates.flatMap((date, i) => { const v = f(i); return v === undefined ? [] : [point(id, date, v)]; }).reverse();
    if (quarters.length) series.push({ seriesId: id, quarters, annual: [] });
  };
  const v = (id: SecCanonicalSeriesId, i: number) => values[id]?.[i];
  derived("gross_margin", (i) => v("gross_profit", i) !== undefined && v("revenue", i) ? v("gross_profit", i)! / v("revenue", i)! : undefined);
  derived("operating_margin", (i) => v("operating_income", i) !== undefined && v("revenue", i) ? v("operating_income", i)! / v("revenue", i)! : undefined);
  derived("free_cash_flow", (i) => v("operating_cash_flow", i) !== undefined && v("capex", i) !== undefined ? v("operating_cash_flow", i)! - v("capex", i)! : undefined);
  return { registryVersion: "sec-canonical-series.v1", series };
}
