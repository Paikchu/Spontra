import type { FactorDistribution, RevenueAnchor } from "../../analysis-contract/valuation.ts";
import { financeLeaseAmount } from "./lease-basis.ts";
import { rpoRevenueFloor, type CalcRequest, type Lifecycle } from "./calculator.ts";

/**
 * The deterministic prior (docs/valuation-v2-SPEC.md §2): a first pass from the company's own history, its RPO and its
 * capex cycle, with no model involved. The workflow hands it to the assumptions phase as a starting point to revise, and
 * the dry run uses it as the whole answer when no model is available. Pure: the same inputs give the same request.
 */
export type PriorFact = { id: string; value: number; unit: string };
export type PriorInput = {
  currency: string;
  facts: PriorFact[];
  distributions: FactorDistribution[];
  diagnostics: Array<{ key: string; value: number | null }>;
  /** The newest RPO disclosure, as the capital structure carries it (bucket starts as dates). */
  rpo: { asOf: string; total: number; buckets: Array<{ start: string | null; months: number | null; share: number | null }> } | null;
  riskFree: number | null;
  beta: number | null;
  price: number | null;
  /** The prior's equity risk premium; the research must source the final one. */
  equityRiskPremium?: number;
  midYear?: boolean;
  /**
   * The build-capex timing by forecast year, e.g. management's capex plan with its peak in year two; default a four-year
   * taper. The shape is scaled to the taper's total, so it moves when the history-derived excess is spent, not how much.
   */
  capexShape?: number[] | null;
};

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

/** Build: capex far above depreciation and the cash flow negative or capex above 30% of revenue. Growth: trailing revenue growth above 15%. Else mature. */
export function lifecycleOf(input: { facts: PriorFact[]; diagnostics: Array<{ key: string; value: number | null }> }): Lifecycle {
  const fact = (id: string) => input.facts.find(f => f.id === id)?.value ?? null;
  const diag = (key: string) => input.diagnostics.find(d => d.key === key)?.value ?? null;
  const capex = fact("capex_ttm") != null ? Math.abs(fact("capex_ttm")!) : null, revenue = fact("revenue_ttm"), fcf = fact("fcf_ttm");
  const capexToDa = diag("capexToDa"), capexToRevenue = capex != null && revenue ? capex / revenue : null;
  if ((capexToDa != null && capexToDa >= 2 && fcf != null && fcf < 0) || (capexToRevenue != null && capexToRevenue > 0.3)) return "build";
  if ((diag("revenueGrowthTtm") ?? 0) > 0.15) return "growth";
  return "mature";
}

/** The contracted-revenue floor over `years` from the newest RPO disclosure; null without a total or a stated timing. */
export function anchorOf(rpo: PriorInput["rpo"], years: number, revenue0: number): RevenueAnchor | null {
  if (!rpo || !(rpo.total > 0)) return null;
  const base = monthIndex(rpo.asOf);
  const buckets = rpo.buckets.flatMap(b => b.share != null && b.share > 0 ? [{ startMonths: b.start ? Math.max(0, monthIndex(b.start) - base - 1) : 0, months: b.months, share: b.share }] : []);
  if (!buckets.length) return null;
  return rpoRevenueFloor({ asOf: rpo.asOf, total: rpo.total, buckets, years, revenue0 });
}

/** The forecast horizon by life cycle: a build phase needs the years for capex to normalize. */
export const horizonFor = (lifecycle: Lifecycle) => lifecycle === "build" ? 7 : 5;

/** Two years at the starting rate (the contracted horizon), then a straight fade to the ending rate. */
const fade = (from: number, to: number, years: number) => Array.from({ length: years }, (_, i) => i < 2 || years <= 3 ? from : from + (to - from) * (i - 2) / (years - 3));

/** The prior request, or null when revenue, shares, history, the risk-free rate or a beta is missing. */
export function priorRequest(input: PriorInput): CalcRequest | null {
  const fact = (id: string) => input.facts.find(f => f.id === id)?.value ?? null;
  const revenue = fact("revenue_ttm"), shares = fact("shares_diluted_weighted") ?? fact("shares_outstanding");
  const growth = input.distributions.find(d => d.factor === "revenueGrowth"), margin = input.distributions.find(d => d.factor === "operatingMargin");
  const rf = input.riskFree;
  if (!revenue || !shares || !growth || !margin || rf == null || input.beta == null) return null;
  const lifecycle = lifecycleOf(input);
  const years = horizonFor(lifecycle);
  const tax = fact("effective_tax_rate_ttm") ?? 0.21;
  const financeLeases = financeLeaseAmount(input.facts);
  if (financeLeases == null || fact("debt") == null || fact("cash") == null || fact("finance_lease_debt_overlap") === 1) return null;
  const equity = fact("equity"), debt = fact("debt")! + financeLeases, cash = fact("cash")! + (fact("investments") ?? 0);
  const claims = debt + (fact("preferred_stock") ?? 0) + (fact("minority_interest") ?? 0) + (fact("other_senior_claims") ?? 0);
  const price = input.price;
  const marketCap = price ? price * shares : equity ?? null;
  const equityWeight = marketCap && marketCap > 0 ? marketCap / (marketCap + debt) : 0.8;
  const interest = fact("interest_expense_ttm");
  const costOfDebt = interest && debt > 0 ? Math.min(Math.max(interest / debt, rf), 0.15) : rf + 0.015;
  const erp = input.equityRiskPremium ?? 0.045;
  const costOfEquity = rf + input.beta * erp;
  const r = equityWeight * costOfEquity + (1 - equityWeight) * costOfDebt * (1 - tax);
  // Terminal growth: nominal growth of the economy at most, and never above 3% without a reason the prior cannot give.
  const g = Math.min(rf, 0.03, Math.max(growth.median, 0));
  const capexRatio = input.distributions.find(d => d.factor === "capexToRevenue")?.median ?? 0.05;
  const salesToCapital = Math.min(Math.max(1 / Math.max(capexRatio * 4, 0.05), 0.5), 6);
  const roic = input.diagnostics.find(m => m.key === "roic")?.value ?? null;
  const terminalRoic = Math.max(roic ?? r + 0.02, r + 0.005);
  const anchor = anchorOf(input.rpo, years, revenue);
  // Contracted revenue already above this year's revenue is growth the history cannot deny: the floor's compound rate to each of the first two years.
  const anchoredGrowth = anchor ? Math.max(...anchor.floorToRevenue0.slice(0, 2).map((ratio, i) => ratio > 1 ? ratio ** (1 / (i + 1)) - 1 : -Infinity)) : -Infinity;
  const start = (history: number) => Math.max(history, anchoredGrowth, -0.3);
  // Capital spent ahead of revenue: capex beyond one and a half times depreciation, tapering off over four years.
  const capex = fact("capex_ttm") != null ? Math.abs(fact("capex_ttm")!) : null, da = fact("da_ttm");
  const excess = lifecycle === "build" && capex != null && da != null ? Math.max(capex - 1.5 * da, 0) : 0;
  const taper = [1, 0.75, 0.5, 0.25, ...new Array<number>(Math.max(years - 4, 0)).fill(0)].slice(0, years);
  let shape = taper;
  if (input.capexShape?.some(k => k > 0)) {
    const given = [...input.capexShape.slice(0, years), ...new Array<number>(Math.max(years - input.capexShape.length, 0)).fill(0)].map(k => Math.max(k, 0));
    given[years - 1] = 0;
    const scale = taper.reduce((a, b) => a + b, 0) / given.reduce((a, b) => a + b, 0);
    shape = Number.isFinite(scale) && scale > 0 ? given.map(k => k * scale) : taper;
  }
  const buildCapex = excess > 0 ? shape.map(k => k * excess) : null;
  const path = (gr0: number, grN: number, mg: number) => ({
    revenueGrowth: fade(gr0, grN, years), operatingMargin: new Array<number>(years).fill(mg), taxRate: new Array<number>(years).fill(tax), salesToCapital: new Array<number>(years).fill(salesToCapital), ...(buildCapex ? { buildCapex } : {}),
  });
  const scenario = (narrative: string, gr0: number, grN: number, mg: number) => ({ narrative, probability: null, triggers: [], invalidation: [], evidenceIds: [], drivers: { modelType: "fcff" as const, revenue0: revenue, path: path(gr0, grN, mg), terminalGrowth: g, terminalRoic } });
  const notes = [`prior: ${lifecycle} life cycle, ${years}-year horizon`, "operating rent stays in earnings; cash and investments versus debt, finance leases, preferred and minority claims"];
  if (anchor) notes.push(`RPO floor years 1–2: ${anchor.floorToRevenue0.slice(0, 2).map(v => `${(v * 100).toFixed(0)}% of trailing revenue`).join(", ")}`);
  if (buildCapex) notes.push(shape !== taper ? `build capex ${excess.toExponential(2)} × ${shape.map(k => k.toFixed(2)).join(", ")} (the cited capex plan's timing, scaled to the taper's total)` : `build capex ${excess.toExponential(2)} tapering over four years`);
  return {
    modelType: "fcff", currency: input.currency, midYear: input.midYear === true,
    discountRate: { value: r, basis: "wacc", components: { riskFree: rf, beta: input.beta, equityRiskPremium: erp, costOfEquity, costOfDebt, taxRate: tax, equityWeight }, rationale: "prior from sourced components; the equity risk premium is a placeholder the research must source", sourceRefs: [] },
    shares: { base: shares, dilutionReserve: 0, basis: "prior" }, bridge: { leaseTreatment: "operating_expense", nonOperatingAssets: cash, debtAndClaims: claims, nonOperatingEquityAdjustment: 0, notes }, price,
    scenarios: {
      bear: scenario("history p25, fading to 2%", start(growth.p25), Math.min(0.02, start(growth.p25)), margin.p25),
      base: scenario("history median, fading to 4%", start(growth.median), Math.min(0.04, start(growth.median)), margin.median),
      bull: scenario("history p75, fading to 6%", start(growth.p75), Math.min(0.06, start(growth.p75)), margin.p75),
    },
    context: { facts: input.facts, riskFree: rf, anchor, lifecycle },
  };
}
