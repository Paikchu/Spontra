import { z } from "zod";

/**
 * Report figures the application draws from validated XBRL. The Pipeline builds every instance
 * before writing; the model only places an existing `figureKey` beside its argument and writes the
 * title and caption. Values never come from the model.
 */
export const SEC_FIGURE_KINDS = ["kpi_strip", "growth", "margin_ladder", "profit_flow", "per_hundred", "cash_bridge", "cash_debt", "share_count"] as const;
export type SecFigureKind = typeof SEC_FIGURE_KINDS[number];

/** What each kind can answer. Shown to the writer and reviewer next to every available instance. */
export const SEC_FIGURE_CATALOG: Record<SecFigureKind, { label: string; answers: string; limits: string }> = {
  kpi_strip: { label: "关键数字条", answers: "本期 2–4 个已核验的核心数字、与去年同期的变化和近几期走势", limits: "只呈现数字本身，不解释原因" },
  growth: { label: "收入与同比增速", answers: "收入规模走势，以及同比增速在加快还是放缓", limits: "整体收入不能证明分部、客户或价格变化" },
  margin_ladder: { label: "三道利润率", answers: "毛利率、营业利润率、净利率逐层的变化，盈利能力是否改善", limits: "利润率变化的原因须由正文和证据说明" },
  profit_flow: { label: "收入到净利润的流向", answers: "本期收入依次扣除直接成本、经营费用、税及其他后剩下多少净利润", limits: "只拆到利润表大类，不含分部或费用明细" },
  per_hundred: { label: "每 100 元收入的去向", answers: "按 100 元收入拆分成本、经营费用、税及其他和净利润，并与去年同期对照", limits: "结构变化不能单独证明定价或成本效率的原因" },
  cash_bridge: { label: "利润到自由现金流", answers: "净利润经营运等调整得到经营现金流，再扣资本开支后剩下多少自由现金流", limits: "营运调整是合计数，不区分库存、应收等明细" },
  cash_debt: { label: "现金与长期债务", answers: "现金与长期债务的规模、走势及净现金或净负债", limits: "不含租赁、短期借款等全部负债" },
  share_count: { label: "股数变化", answers: "股数在增加（稀释）还是减少（回购）", limits: "不区分回购与股权激励各自的规模" },
};

export const SEC_FIGURE_METRIC_LABELS: Record<string, string> = {
  revenue: "营收", gross_profit: "毛利润", gross_margin: "毛利率", operating_income: "营业利润", operating_margin: "营业利润率",
  net_income: "净利润", net_margin: "净利率", diluted_eps: "摊薄每股收益", operating_cash_flow: "经营现金流", capex: "资本开支",
  free_cash_flow: "自由现金流", cash: "现金及等价物", debt: "长期债务", shares: "股数",
};

const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => Number.isFinite(Date.parse(value)), "Invalid date");
const accession = z.string().min(1).max(40);
const amount = z.number();
const point = z.strictObject({ date: day, value: amount, accession });
const series = z.strictObject({
  metricKey: z.string().min(1).max(120), unit: z.string().min(1).max(24), basis: z.string().min(1).max(24),
  points: z.array(point).min(2).max(12),
}).refine((value) => value.points.every((p, i) => i === 0 || value.points[i - 1].date < p.date), "Points must be unique and ascending");
const income = z.strictObject({
  date: day, currency: z.string().regex(/^[A-Z]{3}$/),
  revenue: amount, grossProfit: amount, operatingIncome: amount, netIncome: amount,
  accessions: z.array(accession).min(1).max(8),
});
const base = { figureKey: id, periodScope: z.enum(["quarter", "annual"]), periodEnd: day };

export const SEC_FIGURE_SCHEMA = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("kpi_strip"), series: z.array(series).min(2).max(4) }),
  z.strictObject({ ...base, kind: z.literal("growth"), revenue: series }),
  z.strictObject({ ...base, kind: z.literal("margin_ladder"), series: z.array(series).min(2).max(3) }),
  z.strictObject({ ...base, kind: z.literal("profit_flow"), current: income }),
  z.strictObject({ ...base, kind: z.literal("per_hundred"), current: income, prior: income }),
  z.strictObject({ ...base, kind: z.literal("cash_bridge"), currency: z.string().regex(/^[A-Z]{3}$/),
    netIncome: amount.optional(), operatingCashFlow: amount, capex: amount, freeCashFlow: amount, accessions: z.array(accession).min(1).max(8) }),
  z.strictObject({ ...base, kind: z.literal("cash_debt"), cash: series, debt: series }),
  z.strictObject({ ...base, kind: z.literal("share_count"), shares: series }),
]);

export type SecFigure = z.infer<typeof SEC_FIGURE_SCHEMA>;
export type SecFigureSeries = z.infer<typeof series>;
export type SecFigurePoint = z.infer<typeof point>;
export type SecIncomeSnapshot = z.infer<typeof income>;

/** Stored snapshots are re-validated at render time; damaged ones are skipped, never drawn. */
export function readableSecFigure(value: unknown): SecFigure | null {
  const parsed = SEC_FIGURE_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const DAY = 86_400_000;
/** The comparable observation one year earlier (fiscal calendars drift by a few days). */
export function yearAgoPoint(points: readonly SecFigurePoint[], index: number): SecFigurePoint | undefined {
  const current = Date.parse(points[index]?.date ?? "");
  return points.slice(0, index).reverse().find((p) => Math.abs((current - Date.parse(p.date)) / DAY - 365) <= 21);
}

/** Change of the latest point against the same period last year, else against the prior period. */
export function latestChange(value: SecFigureSeries): { basis: "yoy" | "prior"; prior: SecFigurePoint; current: SecFigurePoint; delta: number; ratio?: number } {
  const index = value.points.length - 1;
  const current = value.points[index];
  const yoy = yearAgoPoint(value.points, index);
  const prior = yoy ?? value.points[index - 1];
  const delta = current.value - prior.value;
  return { basis: yoy ? "yoy" : "prior", prior, current, delta, ...(prior.value > 0 ? { ratio: delta / prior.value } : {}) };
}

/** Year-over-year growth for each point that has a comparable year-ago observation. */
export function yoyGrowth(value: SecFigureSeries): Array<{ date: string; growth: number }> {
  return value.points.flatMap((p, i) => {
    const prior = yearAgoPoint(value.points, i);
    return prior && prior.value > 0 ? [{ date: p.date, growth: (p.value - prior.value) / prior.value }] : [];
  });
}

export type IncomeParts = { cost: number; operatingExpenses: number; taxAndOther: number; netIncome: number };
/** Income statement layers. Null when a layer is negative and cannot be drawn as a share of revenue. */
export function incomeParts(snapshot: SecIncomeSnapshot): IncomeParts | null {
  const parts = {
    cost: snapshot.revenue - snapshot.grossProfit,
    operatingExpenses: snapshot.grossProfit - snapshot.operatingIncome,
    taxAndOther: snapshot.operatingIncome - snapshot.netIncome,
    netIncome: snapshot.netIncome,
  };
  return snapshot.revenue > 0 && Object.values(parts).every((v) => Number.isFinite(v) && v >= 0) ? parts : null;
}

/** Whole-number shares of 100 that always add to 100 (largest remainder). */
export function perHundred(snapshot: SecIncomeSnapshot): IncomeParts | null {
  const parts = incomeParts(snapshot);
  if (!parts) return null;
  const keys = Object.keys(parts) as Array<keyof IncomeParts>;
  const raw = keys.map((key) => parts[key] / snapshot.revenue * 100);
  const floors = raw.map(Math.floor);
  let rest = 100 - floors.reduce((sum, v) => sum + v, 0);
  for (const index of raw.map((v, i) => [v - floors[i], i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) {
    if (rest <= 0) break;
    floors[index] += 1; rest -= 1;
  }
  return Object.fromEntries(keys.map((key, i) => [key, floors[i]])) as IncomeParts;
}

export type CashBridgeStep = { key: string; label: string; value: number; kind: "total" | "change"; start: number; end: number };
export function cashBridgeSteps(figure: Extract<SecFigure, { kind: "cash_bridge" }>): CashBridgeStep[] {
  const steps: CashBridgeStep[] = [];
  if (figure.netIncome !== undefined) {
    steps.push({ key: "net_income", label: "净利润", value: figure.netIncome, kind: "total", start: 0, end: figure.netIncome });
    const adjustment = figure.operatingCashFlow - figure.netIncome;
    steps.push({ key: "adjustments", label: "非现金与营运调整", value: adjustment, kind: "change", start: figure.netIncome, end: figure.operatingCashFlow });
  }
  steps.push({ key: "operating_cash_flow", label: "经营现金流", value: figure.operatingCashFlow, kind: "total", start: 0, end: figure.operatingCashFlow });
  steps.push({ key: "capex", label: "资本开支", value: -figure.capex, kind: "change", start: figure.operatingCashFlow, end: figure.operatingCashFlow - figure.capex });
  steps.push({ key: "free_cash_flow", label: "自由现金流", value: figure.freeCashFlow, kind: "total", start: 0, end: figure.freeCashFlow });
  return steps;
}

const round = (value: number, digits = 4) => Number(value.toPrecision(digits));
/** Computed facts the writer may cite in captions; the reviewer checks text against the same numbers. */
export function summarizeSecFigure(figure: SecFigure): Record<string, unknown> {
  const latest = (s: SecFigureSeries) => ({ metricKey: s.metricKey, unit: s.unit, ...latestChangeSummary(s) });
  switch (figure.kind) {
    case "kpi_strip": return { metrics: figure.series.map(latest) };
    case "growth": return { latest: latest(figure.revenue), yoyGrowth: yoyGrowth(figure.revenue).map((g) => ({ date: g.date, growth: round(g.growth) })) };
    case "margin_ladder": case "cash_debt": case "share_count": {
      const list = figure.kind === "margin_ladder" ? figure.series : figure.kind === "cash_debt" ? [figure.cash, figure.debt] : [figure.shares];
      return { series: list.map(latest), ...(figure.kind === "cash_debt" ? { netCash: round(figure.cash.points.at(-1)!.value - figure.debt.points.at(-1)!.value) } : {}) };
    }
    case "profit_flow": return { date: figure.current.date, currency: figure.current.currency, revenue: figure.current.revenue, parts: incomeParts(figure.current) };
    case "per_hundred": return { currency: figure.current.currency, current: { date: figure.current.date, perHundred: perHundred(figure.current) }, prior: { date: figure.prior.date, perHundred: perHundred(figure.prior) } };
    case "cash_bridge": return { currency: figure.currency, steps: cashBridgeSteps(figure).map(({ label, value }) => ({ label, value })) };
  }
}

function latestChangeSummary(s: SecFigureSeries) {
  const change = latestChange(s);
  return { date: change.current.date, value: change.current.value, comparedWith: change.basis, priorDate: change.prior.date, priorValue: change.prior.value,
    ...(change.ratio !== undefined ? { changeRatio: round(change.ratio) } : {}) };
}
