import { SEC_FIGURE_CATALOG, SEC_FIGURE_SCHEMA, incomeParts, summarizeSecFigure, yearAgoPoint, type SecFigure, type SecFigureSeries, type SecIncomeSnapshot } from '../../../../shared/analysis-runtime/sec-figures.ts';
import type { SecAnalysisBrief, SecCanonicalSeriesId } from './analysis.ts';
import { verifiedTrend } from './presentation.ts';

/**
 * Every figure the reader may place, built only from validated XBRL filed by this filing date.
 * A figure is offered only when its newest point is this report's period, so it describes this filing.
 */
export function buildSecFigures(brief: SecAnalysisBrief, filingDate: string, reportDate: string): SecFigure[] {
  const scope = brief.periodScope;
  const trend = (id: SecCanonicalSeriesId): SecFigureSeries | undefined => {
    const series = brief.history.series.find((s) => s.seriesId === id);
    const value = series && verifiedTrend(series, scope, filingDate, reportDate);
    return value && value.points.at(-1)!.date === reportDate ? { metricKey: value.metricKey, unit: value.unit, basis: value.basis, points: value.points } : undefined;
  };
  const revenue = trend('revenue'), grossProfit = trend('gross_profit'), operatingIncome = trend('operating_income'), netIncome = trend('net_income');
  const netMargin = ratioSeries('net_margin', netIncome, revenue);
  const base = (kind: SecFigure['kind']) => ({ kind, figureKey: `${kind}:${reportDate}`, periodScope: scope, periodEnd: reportDate });
  const candidates: unknown[] = [];

  const kpis = [revenue, trend('gross_margin') ?? trend('operating_margin'), trend('diluted_eps'), trend('free_cash_flow')].filter((s): s is SecFigureSeries => Boolean(s));
  if (kpis.length >= 2) candidates.push({ ...base('kpi_strip'), series: kpis });
  if (revenue && revenue.points.some((_, i) => yearAgoPoint(revenue.points, i))) candidates.push({ ...base('growth'), revenue });
  const margins = [trend('gross_margin'), trend('operating_margin'), netMargin].filter((s): s is SecFigureSeries => Boolean(s));
  if (margins.length >= 2) candidates.push({ ...base('margin_ladder'), series: margins });

  const snapshot = (date: string): SecIncomeSnapshot | undefined => {
    const at = (s?: SecFigureSeries) => s?.points.find((p) => p.date === date);
    const values = [at(revenue), at(grossProfit), at(operatingIncome), at(netIncome)];
    if (values.some((p) => !p) || new Set([revenue, grossProfit, operatingIncome, netIncome].map((s) => s!.unit)).size !== 1 || !/^[A-Z]{3}$/.test(revenue!.unit)) return undefined;
    const [r, g, o, n] = values as NonNullable<typeof values[number]>[];
    const value = { date, currency: revenue!.unit, revenue: r.value, grossProfit: g.value, operatingIncome: o.value, netIncome: n.value, accessions: [...new Set(values.map((p) => p!.accession))] };
    return incomeParts(value) ? value : undefined;
  };
  const current = snapshot(reportDate);
  if (current) {
    candidates.push({ ...base('profit_flow'), current });
    const priorPoint = revenue && yearAgoPoint(revenue.points, revenue.points.length - 1);
    const prior = priorPoint && snapshot(priorPoint.date);
    if (prior) candidates.push({ ...base('per_hundred'), current, prior });
  }

  const ocf = trend('operating_cash_flow'), capex = trend('capex'), fcf = trend('free_cash_flow');
  const latest = (s?: SecFigureSeries) => s?.points.at(-1);
  if (ocf && capex && fcf && ocf.unit === capex.unit && ocf.unit === fcf.unit && /^[A-Z]{3}$/.test(ocf.unit)) {
    const [o, c, f] = [latest(ocf)!, latest(capex)!, latest(fcf)!];
    // The derived FCF must be exactly this OCF less this capex; otherwise the bridge would not close.
    if (Math.abs(o.value - c.value - f.value) <= Math.max(1, Math.abs(o.value) * 1e-6)) {
      const ni = netIncome?.unit === ocf.unit ? latest(netIncome) : undefined;
      candidates.push({ ...base('cash_bridge'), currency: ocf.unit, ...(ni ? { netIncome: ni.value } : {}),
        operatingCashFlow: o.value, capex: c.value, freeCashFlow: f.value, accessions: [...new Set([o, c, f, ...(ni ? [ni] : [])].map((p) => p.accession))] });
    }
  }
  const cash = trend('cash'), debt = trend('debt');
  if (cash && debt && cash.unit === debt.unit) candidates.push({ ...base('cash_debt'), cash, debt });
  const shares = trend('shares');
  if (shares) candidates.push({ ...base('share_count'), shares });

  return candidates.flatMap((candidate) => {
    const parsed = SEC_FIGURE_SCHEMA.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

/** What the writer and reviewer see: the figure's purpose, limits and the numbers it will draw. */
export function figureCatalog(figures: SecFigure[]) {
  return figures.map((figure) => ({ figureKey: figure.figureKey, kind: figure.kind, ...SEC_FIGURE_CATALOG[figure.kind], periodEnd: figure.periodEnd, data: summarizeSecFigure(figure) }));
}

function ratioSeries(metricKey: string, numerator?: SecFigureSeries, denominator?: SecFigureSeries): SecFigureSeries | undefined {
  if (!numerator || !denominator || numerator.unit !== denominator.unit) return undefined;
  const points = numerator.points.flatMap((p) => {
    const d = denominator.points.find((q) => q.date === p.date);
    return d && d.value > 0 ? [{ date: p.date, value: p.value / d.value, accession: p.accession }] : [];
  });
  return points.length >= 2 && points.at(-1)!.date === numerator.points.at(-1)!.date ? { metricKey, unit: 'ratio', basis: 'derived', points } : undefined;
}
