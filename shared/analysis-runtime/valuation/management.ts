import type { ManagementComparisonRow, ManagementTarget, ManagementTargetSet, ModelDrivers, ReferenceScenario, SanityGate } from "../../analysis-contract/valuation.ts";
import type { CalcRequest } from "./calculator.ts";

/**
 * The management case (docs/valuation-v2-SPEC.md §3b): a reference path computed by code from management's cited
 * targets, with the researched model's own rate, shares, bridge, horizon, tax and sales-to-capital. It is compared
 * with the base case and shown beside it; it is never the base. Pure: the same targets give the same path.
 */
type Fcff = Extract<ModelDrivers, { modelType: "fcff" }>;
export type ManagementFacts = { revenue0: number; operatingMargin0: number | null; sbcToRevenue: number | null; da0: number | null; capex0: number | null };
/** A revenue path more than this far under a management revenue target, or above it at all beyond the tolerance, is flagged. */
const MANAGEMENT_DISCOUNT_FLAG = 0.25, MANAGEMENT_PREMIUM_FLAG = 0.10;

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
/** The forecast year (1-based) a fiscal year lands on: the first year ending at or after the fiscal year's end; 0 when it is already past, null beyond the horizon. */
export function forecastYearOf(fiscalYear: number, set: Pick<ManagementTargetSet, "fiscalYearEndMonth">, periodEnd: string, years: number): number | null {
  const end = fiscalYear * 12 + set.fiscalYearEndMonth - 1, base = monthIndex(periodEnd);
  if (end <= base) return 0;
  const year = Math.ceil((end - base) / 12);
  return year <= years ? year : null;
}

const byYear = (set: ManagementTargetSet, periodEnd: string, years: number, metric: ManagementTarget["metric"]) => {
  const out = new Map<number, ManagementTarget>();
  for (const t of set.targets.filter(t => t.metric === metric && !t.segment)) {
    const year = forecastYearOf(t.fiscalYear, set, periodEnd, years);
    if (year != null && year >= 1 && (!out.has(year) || t.fiscalYear > out.get(year)!.fiscalYear)) out.set(year, t);
  }
  return out;
};

/** Revenue growth by year through the total-revenue targets (geometric between anchors), then a straight fade to the terminal growth. */
export function managementRevenueGrowth(set: ManagementTargetSet, periodEnd: string, years: number, revenue0: number, terminalGrowth: number): { growth: number[]; anchors: Array<{ fiscalYear: number; year: number; target: number }> } | null {
  const targets = [...byYear(set, periodEnd, years, "revenue").entries()].sort((a, b) => a[0] - b[0]);
  if (!targets.length || !(revenue0 > 0)) return null;
  const growth = new Array<number>(years).fill(0);
  let year = 0, revenue = revenue0;
  for (const [at, t] of targets) {
    const rate = (t.value / revenue) ** (1 / (at - year)) - 1;
    for (let i = year; i < at; i++) growth[i] = rate;
    year = at; revenue = t.value;
  }
  const last = growth[year - 1]!, remaining = years - year;
  for (let i = year; i < years; i++) growth[i] = last + (terminalGrowth - last) * (i - year + 1) / remaining;
  return { growth, anchors: targets.map(([at, t]) => ({ fiscalYear: t.fiscalYear, year: at, target: t.value })) };
}

/**
 * Build capex by year from the capex targets and the cash-flow target: gross capex less maintenance (D&A scaled with
 * revenue) and less the reinvestment revenue growth already pays through sales-to-capital; in a year with a free-cash-flow
 * floor, whatever leaves exactly that cash flow. Years after the last anchor carry none, so the build ends in the horizon.
 */
export function managementBuildCapex(set: ManagementTargetSet, periodEnd: string, path: { revenue: number[]; nopat: number[]; reinvestment: number[] }, facts: ManagementFacts): { buildCapex: number[]; anchors: Array<{ metric: "capex" | "fcf"; fiscalYear: number; year: number; target: number }>; notes: string[] } | null {
  const years = path.revenue.length;
  const capex = byYear(set, periodEnd, years, "capex"), fcf = byYear(set, periodEnd, years, "fcf");
  if (!capex.size && !fcf.size) return null;
  const build = new Array<number>(years).fill(0);
  const anchors: Array<{ metric: "capex" | "fcf"; fiscalYear: number; year: number; target: number }> = [];
  const notes: string[] = [];
  for (let i = 0; i < years; i++) {
    const c = capex.get(i + 1), f = fcf.get(i + 1);
    if (f) {
      build[i] = Math.max(path.nopat[i]! - path.reinvestment[i]! - f.value, 0);
      anchors.push({ metric: "fcf", fiscalYear: f.fiscalYear, year: i + 1, target: f.value });
      if (path.nopat[i]! - path.reinvestment[i]! < f.value) notes.push(`year ${i + 1}: the path's cash flow before build capex is under the FY${f.fiscalYear} free-cash-flow floor`);
    } else if (c) {
      const maintenance = facts.da0 != null && facts.revenue0 > 0 ? facts.da0 * path.revenue[i]! / facts.revenue0 : 0;
      build[i] = Math.max(c.value - maintenance - path.reinvestment[i]!, 0);
      anchors.push({ metric: "capex", fiscalYear: c.fiscalYear, year: i + 1, target: c.value });
    }
  }
  if (build[years - 1]! > 0) { build[years - 1] = 0; notes.push("build capex in the last year dropped so the build ends inside the horizon"); }
  return { buildCapex: build, anchors, notes };
}

/** The management case's drivers from the model's base drivers and the cited targets; null without a total-revenue target inside the horizon. */
export function managementDrivers(base: Fcff, set: ManagementTargetSet, periodEnd: string, facts: ManagementFacts): { drivers: Fcff; anchors: ReferenceScenario["anchors"]; notes: string[] } | null {
  const years = base.path.revenueGrowth.length;
  const revenue = managementRevenueGrowth(set, periodEnd, years, base.revenue0, base.terminalGrowth);
  if (!revenue) return null;
  const notes: string[] = [`revenue through the FY targets (${revenue.anchors.map(a => `FY${a.fiscalYear} → year ${a.year}`).join(", ")}), then a straight fade to ${(base.terminalGrowth * 100).toFixed(1)}%`];
  // Margin: from the trailing margin to the target, held after; a non-GAAP target less the trailing stock compensation share.
  const margins = [...byYear(set, periodEnd, years, "operating_margin").entries()].sort((a, b) => a[0] - b[0]);
  let operatingMargin = [...base.path.operatingMargin];
  const anchors: ReferenceScenario["anchors"] = revenue.anchors.map(a => ({ metric: "revenue" as const, fiscalYear: a.fiscalYear, year: a.year, target: a.target, path: null }));
  if (margins.length && facts.operatingMargin0 != null) {
    const start = facts.operatingMargin0;
    operatingMargin = new Array<number>(years).fill(start);
    let from = 0, level = start;
    for (const [at, t] of margins) {
      const target = t.basis === "non_gaap" ? t.value - (facts.sbcToRevenue ?? 0) : t.value;
      for (let i = from; i < at; i++) operatingMargin[i] = level + (target - level) * (i - from + 1) / (at - from);
      for (let i = at; i < years; i++) operatingMargin[i] = target;
      anchors.push({ metric: "operating_margin", fiscalYear: t.fiscalYear, year: at, target: t.value, path: target });
      notes.push(t.basis === "non_gaap" ? `FY${t.fiscalYear} non-GAAP margin ${(t.value * 100).toFixed(0)}% less trailing stock compensation ${((facts.sbcToRevenue ?? 0) * 100).toFixed(1)}% of revenue = ${(target * 100).toFixed(1)}% on the calculator's basis` : `FY${t.fiscalYear} margin ${(t.value * 100).toFixed(1)}%`);
      from = at; level = target;
    }
  }
  // The path without build capex, to size the build from the capex and cash-flow targets. In a year with a cash-flow
  // floor the growth reinvestment alone may already breach it: then that year's sales-to-capital rises so the stated cash
  // flow is reached (management's capex "steps down"), as long as NOPAT covers the floor.
  const salesToCapital = [...base.path.salesToCapital];
  const fcfYears = byYear(set, periodEnd, years, "fcf");
  const path = { revenue: [] as number[], nopat: [] as number[], reinvestment: [] as number[] };
  let rev = base.revenue0;
  for (let i = 0; i < years; i++) {
    const previous = rev;
    rev = previous * (1 + revenue.growth[i]!);
    const nopat = rev * operatingMargin[i]! * (1 - base.path.taxRate[i]!);
    let reinvestment = Math.max((rev - previous) / salesToCapital[i]!, 0);
    const floor = fcfYears.get(i + 1);
    if (floor && nopat - reinvestment < floor.value && nopat > floor.value && rev > previous) {
      salesToCapital[i] = Math.min((rev - previous) / (nopat - floor.value), 20);
      reinvestment = (rev - previous) / salesToCapital[i]!;
      notes.push(`year ${i + 1}: sales-to-capital raised to ${salesToCapital[i]!.toFixed(2)} so cash flow meets the FY${floor.fiscalYear} floor of ${(floor.value / 1e9).toFixed(0)}B`);
    }
    path.revenue.push(rev); path.nopat.push(nopat); path.reinvestment.push(reinvestment);
  }
  const build = managementBuildCapex(set, periodEnd, path, facts);
  if (build) { anchors.push(...build.anchors.map(a => ({ ...a, path: null }))); notes.push(...build.notes, `build capex from the capex and cash-flow targets: ${build.buildCapex.map(v => (v / 1e9).toFixed(1)).join(", ")}B`); }
  for (const a of anchors) if (a.metric === "revenue") a.path = path.revenue[a.year - 1] ?? null;
  const { buildCapex: _dropped, ...rest } = base.path;
  const drivers: Fcff = { ...base, path: { ...rest, revenueGrowth: revenue.growth, operatingMargin, salesToCapital, ...(build ? { buildCapex: build.buildCapex } : {}) } };
  return { drivers, anchors, notes };
}

/** The relative build-capex shape management's capex targets describe (gross capex less one and a half times trailing D&A, over the trailing excess); null without capex targets. */
export function managementCapexShape(set: ManagementTargetSet, periodEnd: string, years: number, facts: ManagementFacts): number[] | null {
  const capex = byYear(set, periodEnd, years, "capex");
  if (!capex.size || facts.capex0 == null || facts.da0 == null) return null;
  const excess = Math.max(facts.capex0 - 1.5 * facts.da0, 0);
  if (!(excess > 0)) return null;
  const last = Math.max(...capex.keys());
  return Array.from({ length: years }, (_, i) => {
    const t = capex.get(i + 1);
    if (t) return Math.max(t.value - 1.5 * facts.da0!, 0) / excess;
    // Before the first target the trailing excess carries on; after the last the build steps down to nothing over two years.
    if (i + 1 < Math.min(...capex.keys())) return 1;
    const since = i + 1 - last;
    const previous = Math.max(capex.get(last)!.value - 1.5 * facts.da0!, 0) / excess;
    return since === 1 ? previous * 0.5 : 0;
  });
}

/** The base revenue path against the total-revenue targets the horizon covers: one row per target year with the base figure and the gap (base / target − 1). */
export function managementComparisonRows(base: Fcff, set: ManagementTargetSet, periodEnd: string): ManagementComparisonRow[] {
  const years = base.path.revenueGrowth.length;
  const targets = [...byYear(set, periodEnd, years, "revenue").entries()].sort((a, b) => a[0] - b[0]);
  let revenue = base.revenue0;
  const path: number[] = [];
  for (const g of base.path.revenueGrowth) { revenue *= 1 + g; path.push(revenue); }
  return targets.map(([year, t]) => ({ metric: "revenue" as const, year, fiscalYear: t.fiscalYear, target: t.value, base: path[year - 1]!, gap: path[year - 1]! / t.value - 1 }));
}

/** The base revenue path against the total-revenue targets: flagged when more than the limit under a target, or above it beyond the tolerance. */
export function managementGate(base: Fcff, set: ManagementTargetSet, periodEnd: string): SanityGate | null {
  const rows = managementComparisonRows(base, set, periodEnd);
  if (!rows.length) return null;
  const worst = rows.reduce((a, b) => Math.abs(b.gap) > Math.abs(a.gap) ? b : a);
  const under = rows.filter(r => r.gap < -MANAGEMENT_DISCOUNT_FLAG), over = rows.filter(r => r.gap > MANAGEMENT_PREMIUM_FLAG);
  const detail = rows.map(r => `year ${r.year} (FY${r.fiscalYear}) base ${(r.base / 1e9).toFixed(1)}B vs management ${(r.target / 1e9).toFixed(1)}B (${r.gap >= 0 ? "+" : ""}${(r.gap * 100).toFixed(0)}%)`).join("; ");
  const status = under.length || over.length ? "flag" : "pass";
  return { key: "management_targets", status, detail: status === "pass" ? `base revenue within ${(MANAGEMENT_DISCOUNT_FLAG * 100).toFixed(0)}% under and ${(MANAGEMENT_PREMIUM_FLAG * 100).toFixed(0)}% over management's targets: ${detail}` : `${under.length ? "base revenue discounts management's targets by more than " + (MANAGEMENT_DISCOUNT_FLAG * 100).toFixed(0) + "%" : "base revenue runs above management's own targets"}; the narrative must say why: ${detail}`, value: worst.gap, limit: worst.gap < 0 ? -MANAGEMENT_DISCOUNT_FLAG : MANAGEMENT_PREMIUM_FLAG };
}

/** The facts the management case needs, from the registered fact list. */
export function managementFactsOf(facts: Array<{ id: string; value: number }>, revenue0: number): ManagementFacts {
  const fact = (id: string) => facts.find(f => f.id === id)?.value ?? null;
  const revenue = fact("revenue_ttm") ?? revenue0;
  return { revenue0, operatingMargin0: fact("operating_margin_ttm"), sbcToRevenue: fact("sbc_ttm") != null && revenue > 0 ? fact("sbc_ttm")! / revenue : null, da0: fact("da_ttm"), capex0: fact("capex_ttm") != null ? Math.abs(fact("capex_ttm")!) : null };
}

/** A request whose three scenarios are the management path, for its own cross-check under the shared rate, shares and bridge; the judged probabilities, the comparison and the consensus belong to the researched model and stay out. */
export function managementRequest(request: CalcRequest, drivers: Fcff): CalcRequest {
  const scenario = (narrative: string) => ({ narrative, probability: null, triggers: [], invalidation: [], evidenceIds: [], drivers });
  const { management: _m, scenarioProbabilities: _p, managementComparison: _c, consensusNote: _n, ...context } = request.context ?? {};
  return { ...request, scenarios: { bear: scenario("management case"), base: scenario("management case"), bull: scenario("management case") }, context: { ...context, consensus: null } };
}
