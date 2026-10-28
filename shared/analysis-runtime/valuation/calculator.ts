import { DIMENSION_WEIGHTS, SCENARIO_KEYS, VALUATION_DIMENSIONS, type Confidence, type DiscountRate, type EquityBridge, type FactorDistribution, type ImpliedPath, type ModelDrivers, type ScenarioAssumptions, type ScenarioKey, type ScenarioResult, type Sensitivity, type ShareCount, type ValuationDimension, type ValuationModelResult, type ValuationModelType, type ValuationRange, type ValuationVerdict, type YearRow } from "../../analysis-contract/valuation.ts";

/**
 * The deterministic valuation calculator (docs/valuation-assessment-implementation.md §4, docs/valuation-methodology-optimization.md
 * §2–§6). Every amount a report shows comes from here; the model supplies inputs and reasons. Nothing is rounded until it
 * is displayed. Invalid inputs are rejected with a `ValuationCalcError` rather than producing NaN, Infinity or a made-up figure.
 */
export const CALCULATOR_VERSION = "valuation.calc.v1";
export const FORECAST_YEARS = 5;
/** Terminal value above this share of operating value is a gap the report must name as its first invalidation condition. */
export const TERMINAL_SHARE_LIMIT = 0.8;

export type ValuationCalcErrorCode = "invalid_input" | "rate_order" | "shares" | "multiple" | "scenario_order" | "unsupported_model";
export class ValuationCalcError extends Error {
  readonly code: ValuationCalcErrorCode;
  constructor(code: ValuationCalcErrorCode, message: string) { super(message); this.name = "ValuationCalcError"; this.code = code; }
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const requireFinite = (value: unknown, name: string): number => { if (!finite(value)) throw new ValuationCalcError("invalid_input", `${name} must be a finite number`); return value; };
const requireYears = (values: unknown, name: string, years = FORECAST_YEARS): number[] => {
  if (!Array.isArray(values) || values.length !== years) throw new ValuationCalcError("invalid_input", `${name} must list ${years} yearly values`);
  return values.map((v, i) => requireFinite(v, `${name}[${i + 1}]`));
};
const requireRates = (r: number, g: number) => {
  requireFinite(r, "discount rate"); requireFinite(g, "terminal growth");
  if (r <= 0) throw new ValuationCalcError("invalid_input", "discount rate must be positive");
  if (r <= g) throw new ValuationCalcError("rate_order", "terminal growth must be below the discount rate");
};

export type CalcRequest = {
  modelType: ValuationModelType;
  currency: string;
  discountRate: DiscountRate;
  shares: { base: number; dilutionReserve: number; basis: string };
  bridge: EquityBridge;
  scenarios: Record<ScenarioKey, ScenarioAssumptions>;
  price: number | null;
};

/** Discounts a cash-flow path and a terminal value at year `n`: the common kernel every cash-flow model shares. */
export function discountPath(cashFlows: number[], terminalValue: number, r: number, rows: Array<Partial<YearRow>> = []): { pvExplicit: number; pvTerminal: number; yearly: YearRow[] } {
  const yearly = cashFlows.map((cashFlow, i) => {
    const discountFactor = 1 / (1 + r) ** (i + 1);
    return { year: i + 1, revenue: rows[i]?.revenue ?? null, nopat: rows[i]?.nopat ?? null, reinvestment: rows[i]?.reinvestment ?? null, cashFlow, discountFactor, presentValue: cashFlow * discountFactor };
  });
  const pvExplicit = yearly.reduce((sum, row) => sum + row.presentValue, 0);
  const pvTerminal = terminalValue / (1 + r) ** cashFlows.length;
  return { pvExplicit, pvTerminal, yearly };
}

/** Gordon terminal value on the year after the last forecast year. */
export const gordonTerminal = (lastCashFlow: number, r: number, g: number) => lastCashFlow * (1 + g) / (r - g);

/**
 * The value-driver terminal: growth has to be paid for with reinvestment at the terminal return on capital, so
 * `FCF = NOPAT × (1 − g/ROIC)`; at ROIC equal to the cost of capital growth adds almost nothing.
 */
export function valueDriverTerminal(lastNopat: number, r: number, g: number, terminalRoic: number): { terminalValue: number; reinvestmentRate: number } {
  requireFinite(terminalRoic, "terminal ROIC");
  if (terminalRoic <= 0) throw new ValuationCalcError("invalid_input", "terminal ROIC must be positive");
  if (g < 0) throw new ValuationCalcError("invalid_input", "terminal growth cannot be negative under the value-driver terminal");
  const reinvestmentRate = g / terminalRoic;
  if (reinvestmentRate >= 1) throw new ValuationCalcError("invalid_input", "terminal growth cannot exceed the terminal ROIC");
  return { terminalValue: lastNopat * (1 + g) * (1 - reinvestmentRate) / (r - g), reinvestmentRate };
}

const shareValue = (equity: number, shares: number) => equity / shares;
const terminalShareOf = (pvExplicit: number, pvTerminal: number) => { const total = pvExplicit + pvTerminal; return total > 0 ? pvTerminal / total : null; };

/** One scenario of one model: the equity value and per-share value from its drivers, the shared rate, shares and bridge. */
export function scenarioValue(drivers: ModelDrivers, r: number, shares: number, bridge: EquityBridge): ScenarioResult {
  if (!(shares > 0)) throw new ValuationCalcError("shares", "shares must be positive");
  const notes: string[] = [];
  switch (drivers.modelType) {
    case "fcff": {
      const revenue0 = requireFinite(drivers.revenue0, "revenue0");
      const path = drivers.path;
      const growth = requireYears(path.revenueGrowth, "revenueGrowth"), margin = requireYears(path.operatingMargin, "operatingMargin");
      const tax = requireYears(path.taxRate, "taxRate"), s2c = requireYears(path.salesToCapital, "salesToCapital");
      const normalization = path.normalization ? requireYears(path.normalization, "normalization") : new Array<number>(FORECAST_YEARS).fill(0);
      requireRates(r, drivers.terminalGrowth);
      let revenue = revenue0;
      const rows: Array<Partial<YearRow>> = [], cashFlows: number[] = [];
      let depreciationCap = 0;
      for (let i = 0; i < FORECAST_YEARS; i++) {
        const previous = revenue;
        revenue = previous * (1 + growth[i]!);
        if (s2c[i]! <= 0) throw new ValuationCalcError("invalid_input", "salesToCapital must be positive");
        const nopat = revenue * margin[i]! * (1 - tax[i]!);
        let reinvestment = (revenue - previous) / s2c[i]!;
        // Shrinking revenue releases capital, but never more than a year's worth of depreciation can plausibly return.
        depreciationCap = Math.abs(nopat) * 0.25;
        if (reinvestment < 0 && -reinvestment > depreciationCap) { reinvestment = -depreciationCap; notes.push(`year ${i + 1}: negative reinvestment capped`); }
        cashFlows.push(nopat - reinvestment + normalization[i]!);
        rows.push({ revenue, nopat, reinvestment });
      }
      const lastNopat = rows[FORECAST_YEARS - 1]!.nopat!;
      const { terminalValue, reinvestmentRate } = valueDriverTerminal(lastNopat, r, drivers.terminalGrowth, drivers.terminalRoic);
      notes.push(`terminal reinvestment rate ${(reinvestmentRate * 100).toFixed(1)}% of NOPAT`);
      if (drivers.terminalRoic < r) notes.push("terminal ROIC below the discount rate: terminal growth destroys value");
      const { pvExplicit, pvTerminal, yearly } = discountPath(cashFlows, terminalValue, r, rows);
      const enterpriseValue = pvExplicit + pvTerminal;
      const equityValue = enterpriseValue + bridge.nonOperatingAssets - bridge.debtAndClaims;
      return { perShare: shareValue(equityValue, shares), equityValue, enterpriseValue, pvExplicit, pvTerminal, terminalShare: terminalShareOf(pvExplicit, pvTerminal), yearly, notes };
    }
    case "fcfe": {
      const cf0 = requireFinite(drivers.cfo, "cfo") - requireFinite(drivers.capex, "capex") - requireFinite(drivers.sbc, "sbc") + requireFinite(drivers.normalization, "normalization") + requireFinite(drivers.netBorrowing, "netBorrowing");
      const growth = requireYears(drivers.growth, "growth");
      requireRates(r, drivers.terminalGrowth);
      const cashFlows: number[] = []; let cf = cf0;
      for (const g of growth) { cf = cf * (1 + g); cashFlows.push(cf); }
      const { pvExplicit, pvTerminal, yearly } = discountPath(cashFlows, gordonTerminal(cf, r, drivers.terminalGrowth), r);
      const equityValue = pvExplicit + pvTerminal + bridge.nonOperatingEquityAdjustment;
      return { perShare: shareValue(equityValue, shares), equityValue, enterpriseValue: null, pvExplicit, pvTerminal, terminalShare: terminalShareOf(pvExplicit, pvTerminal), yearly, notes: [`FCFE[0] = ${cf0}`] };
    }
    case "revenue_fcfe": {
      const growth = requireYears(drivers.growth, "growth"), margins = requireYears(drivers.afterSbcEquityCashMargin, "afterSbcEquityCashMargin");
      requireRates(r, drivers.terminalGrowth);
      let revenue = requireFinite(drivers.revenue0, "revenue0");
      const rows: Array<Partial<YearRow>> = [], cashFlows: number[] = [];
      for (let i = 0; i < FORECAST_YEARS; i++) { revenue = revenue * (1 + growth[i]!); cashFlows.push(revenue * margins[i]!); rows.push({ revenue }); }
      const { pvExplicit, pvTerminal, yearly } = discountPath(cashFlows, gordonTerminal(cashFlows[FORECAST_YEARS - 1]!, r, drivers.terminalGrowth), r, rows);
      const equityValue = pvExplicit + pvTerminal + bridge.nonOperatingEquityAdjustment;
      return { perShare: shareValue(equityValue, shares), equityValue, enterpriseValue: null, pvExplicit, pvTerminal, terminalShare: terminalShareOf(pvExplicit, pvTerminal), yearly, notes };
    }
    case "residual_income": {
      const b0 = requireFinite(drivers.bookEquity0, "bookEquity0");
      const roe = requireYears(drivers.roe, "roe"), payout = requireYears(drivers.payout, "payout");
      const g = requireFinite(drivers.terminalGrowth, "terminalGrowth"), terminalRoe = requireFinite(drivers.terminalRoe, "terminalRoe");
      requireRates(r, g);
      if (b0 <= 0) throw new ValuationCalcError("invalid_input", "opening book equity must be positive");
      if (terminalRoe <= 0 || g < 0 || g > terminalRoe) throw new ValuationCalcError("invalid_input", "terminal ROE must be positive and at least the terminal growth");
      let book = b0; const residuals: number[] = []; const rows: Array<Partial<YearRow>> = [];
      for (let i = 0; i < FORECAST_YEARS; i++) {
        const earnings = roe[i]! * book, dividends = payout[i]! * earnings;
        residuals.push(earnings - r * book);
        rows.push({ nopat: earnings });
        book = book + earnings - dividends;
      }
      if (book <= 0) throw new ValuationCalcError("invalid_input", "book equity must stay positive through the forecast");
      const terminalResidual = (terminalRoe - r) * book;
      const terminalValue = terminalResidual / (r - g);
      const { pvExplicit, pvTerminal, yearly } = discountPath(residuals, terminalValue, r, rows);
      const equityValue = b0 + pvExplicit + pvTerminal;
      notes.push(`implied terminal payout ${((1 - g / terminalRoe) * 100).toFixed(1)}%`, `book equity after year ${FORECAST_YEARS}: ${book}`);
      return { perShare: shareValue(equityValue, shares), equityValue, enterpriseValue: null, pvExplicit, pvTerminal, terminalShare: null, yearly, notes };
    }
    case "earnings_multiple": {
      const eps = (1 - requireFinite(drivers.weight, "weight")) * requireFinite(drivers.epsLow, "epsLow") + drivers.weight * requireFinite(drivers.epsHigh, "epsHigh");
      return multipleValue(eps, drivers.multiple, drivers.horizonYears, r, shares, notes);
    }
    case "reported_earnings_multiple":
    case "proforma_earnings_multiple": {
      const eps = requireFinite(drivers.commonEarnings, "commonEarnings") / shares * requireFinite(drivers.earningsScale, "earningsScale");
      if (drivers.commonEarnings <= 0 && drivers.multiple > 0) throw new ValuationCalcError("multiple", "a positive multiple cannot value non-positive earnings");
      return multipleValue(eps, drivers.multiple, drivers.horizonYears, r, shares, notes);
    }
    case "asset_nav": {
      let assetValue = 0, tax = 0;
      for (const [i, asset] of drivers.assets.entries()) {
        const gross = requireFinite(asset.units, `assets[${i}].units`) * requireFinite(asset.price, `assets[${i}].price`);
        assetValue += gross;
        tax += Math.max(gross - requireFinite(asset.costBasis, `assets[${i}].costBasis`), 0) * requireFinite(asset.taxRate, `assets[${i}].taxRate`);
      }
      const equityValue = assetValue - tax + requireFinite(drivers.otherNetAssets, "otherNetAssets") - requireFinite(drivers.debtClaims, "debtClaims") - requireFinite(drivers.preferredClaims, "preferredClaims") - requireFinite(drivers.operatingReserve, "operatingReserve");
      notes.push(`gross asset value ${assetValue}`, `tax on gains ${tax}`);
      return { perShare: shareValue(equityValue, shares), equityValue, enterpriseValue: assetValue, pvExplicit: null, pvTerminal: null, terminalShare: null, yearly: [], notes };
    }
    case "affo_multiple": {
      const perShare = (1 - requireFinite(drivers.weight, "weight")) * requireFinite(drivers.affoLow, "affoLow") + drivers.weight * requireFinite(drivers.affoHigh, "affoHigh") - requireFinite(drivers.recurringCostPerShare, "recurringCostPerShare");
      return multipleValue(perShare, drivers.multiple, drivers.horizonYears, r, shares, notes);
    }
    case "affo_dcf": {
      const cf0 = requireFinite(drivers.annualAffo, "annualAffo") - requireFinite(drivers.recurringCost, "recurringCost");
      const growth = requireYears(drivers.growth, "growth");
      requireRates(r, drivers.terminalGrowth);
      const cashFlows: number[] = []; let cf = cf0;
      for (const g of growth) { cf = cf * (1 + g); cashFlows.push(cf); }
      const { pvExplicit, pvTerminal, yearly } = discountPath(cashFlows, gordonTerminal(cf, r, drivers.terminalGrowth), r);
      const equityValue = pvExplicit + pvTerminal + bridge.nonOperatingEquityAdjustment;
      return { perShare: shareValue(equityValue, shares), equityValue, enterpriseValue: null, pvExplicit, pvTerminal, terminalShare: terminalShareOf(pvExplicit, pvTerminal), yearly, notes };
    }
  }
  throw new ValuationCalcError("unsupported_model", "unsupported model type");
}

function multipleValue(perShareBasis: number, multiple: number, horizonYears: number, r: number, shares: number, notes: string[]): ScenarioResult {
  requireFinite(multiple, "multiple"); requireFinite(horizonYears, "horizonYears"); requireFinite(r, "discount rate");
  if (multiple < 0) throw new ValuationCalcError("multiple", "multiple cannot be negative");
  if (horizonYears < 0) throw new ValuationCalcError("invalid_input", "horizonYears cannot be negative");
  const perShare = perShareBasis * multiple / (1 + r) ** horizonYears;
  notes.push(`per-share basis ${perShareBasis}`);
  return { perShare, equityValue: perShare * shares, enterpriseValue: null, pvExplicit: null, pvTerminal: null, terminalShare: null, yearly: [], notes };
}

/** The whole model: three scenarios, the range, the sensitivities on the base case and the market-implied path. */
export function calculateValuation(request: CalcRequest): ValuationModelResult {
  const r = requireFinite(request.discountRate.value, "discount rate");
  const base = requireFinite(request.shares.base, "shares.base"), dilution = requireFinite(request.shares.dilutionReserve, "shares.dilutionReserve");
  const shares: ShareCount = { base, dilutionReserve: dilution, economic: base + dilution, basis: request.shares.basis };
  if (shares.economic <= 0) throw new ValuationCalcError("shares", "economic shares must be positive");
  for (const key of ["nonOperatingAssets", "debtAndClaims", "nonOperatingEquityAdjustment"] as const) requireFinite(request.bridge[key], `bridge.${key}`);
  const expectedBasis = request.discountRate.basis;
  if ((request.modelType === "fcff" && expectedBasis !== "wacc") || (request.modelType !== "fcff" && request.modelType !== "asset_nav" && expectedBasis !== "cost_of_equity")) {
    throw new ValuationCalcError("invalid_input", `${request.modelType} discounts at ${request.modelType === "fcff" ? "wacc" : "cost_of_equity"}, not ${expectedBasis}`);
  }
  const results = {} as Record<ScenarioKey, ScenarioAssumptions & { result: ScenarioResult }>;
  for (const key of SCENARIO_KEYS) {
    const scenario = request.scenarios[key];
    if (!scenario || scenario.drivers.modelType !== request.modelType) throw new ValuationCalcError("invalid_input", `scenario ${key} is missing or uses another model`);
    results[key] = { ...scenario, result: scenarioValue(scenario.drivers, r, shares.economic, request.bridge) };
  }
  const values = { bear: results.bear.result.perShare, base: results.base.result.perShare, bull: results.bull.result.perShare };
  if (!(values.bear <= values.base && values.base <= values.bull)) throw new ValuationCalcError("scenario_order", `scenario values are out of order (bear ${values.bear}, base ${values.base}, bull ${values.bull}); revise the assumptions`);
  if (request.modelType === "fcff") checkScenarioConsistency(request.scenarios);
  const probabilities = SCENARIO_KEYS.map(k => request.scenarios[k].probability);
  let expected: number | null = null;
  if (probabilities.every(finite)) {
    const sum = probabilities.reduce((a, b) => a + b, 0);
    if (probabilities.some(p => p < 0) || Math.abs(sum - 1) > 1e-6) throw new ValuationCalcError("invalid_input", "scenario probabilities must be non-negative and sum to 1");
    expected = SCENARIO_KEYS.reduce((sum, k) => sum + request.scenarios[k].probability! * values[k], 0);
  } else if (probabilities.some(finite)) throw new ValuationCalcError("invalid_input", "give a probability for every scenario or for none");
  const range = valuationRange(values, expected, request.price);
  const sensitivities = sensitivitiesOf(request, r, shares.economic);
  const implied = request.price != null && request.modelType === "fcff" ? impliedGrowth(request, r, shares.economic, request.price) : null;
  const limitations: string[] = ["Cash flows are discounted at year end; no mid-year convention and no stub period."];
  const terminalShare = results.base.result.terminalShare;
  if (terminalShare != null && terminalShare > TERMINAL_SHARE_LIMIT) limitations.push(`Terminal value is ${(terminalShare * 100).toFixed(0)}% of the base operating value.`);
  return { calculatorVersion: CALCULATOR_VERSION, modelType: request.modelType, currency: request.currency, discountRate: request.discountRate, shares, bridge: request.bridge, scenarios: results, range, sensitivities, implied, limitations };
}

/** A bull case that grows faster than the base must reinvest at least as much; a scenario is one coherent story. */
function checkScenarioConsistency(scenarios: Record<ScenarioKey, ScenarioAssumptions>) {
  const avg = (list: number[]) => list.reduce((a, b) => a + b, 0) / list.length;
  const base = scenarios.base.drivers, bull = scenarios.bull.drivers;
  if (base.modelType !== "fcff" || bull.modelType !== "fcff") return;
  const baseReinvest = avg(base.path.revenueGrowth) / avg(base.path.salesToCapital), bullReinvest = avg(bull.path.revenueGrowth) / avg(bull.path.salesToCapital);
  if (avg(bull.path.revenueGrowth) > avg(base.path.revenueGrowth) + 1e-9 && bullReinvest + 1e-9 < baseReinvest) {
    throw new ValuationCalcError("scenario_order", "reinvestment_inconsistent: the bull case grows faster than the base but reinvests less of its revenue growth");
  }
}

export function valuationRange(values: Record<ScenarioKey, number>, expected: number | null, price: number | null): ValuationRange {
  const ratio = (numerator: number | null, denominator: number | null) => numerator != null && denominator != null && denominator > 0 && numerator > 0 ? numerator / denominator - 1 : null;
  return {
    low: values.bear, high: values.bull, base: values.base, expected, price,
    marginOfSafety: price != null && price > 0 && values.base > 0 ? 1 - price / values.base : null,
    downsideCoverage: ratio(values.bear, price), expectedUpside: ratio(expected, price), baseUpside: ratio(values.base, price),
  };
}

type Perturbation = { factor: string; step: string; apply: (d: ModelDrivers) => ModelDrivers; rate?: number };
const addAll = (list: number[], delta: number) => list.map(v => v + delta);
const scaleAll = (list: number[], factor: number) => list.map(v => v * factor);

/** One-at-a-time moves on the base case, ordered by how much each moves the per-share value. */
export function sensitivitiesOf(request: CalcRequest, r: number, shares: number): Sensitivity[] {
  const base = request.scenarios.base.drivers;
  const baseValue = scenarioValue(base, r, shares, request.bridge).perShare;
  const moves: Perturbation[] = [{ factor: "discountRate", step: "+0.5pp", apply: d => d, rate: r + 0.005 }];
  switch (base.modelType) {
    case "fcff":
      moves.push(
        { factor: "revenueGrowth", step: "+1pp", apply: d => d.modelType === "fcff" ? { ...d, path: { ...d.path, revenueGrowth: addAll(d.path.revenueGrowth, 0.01) } } : d },
        { factor: "operatingMargin", step: "+1pp", apply: d => d.modelType === "fcff" ? { ...d, path: { ...d.path, operatingMargin: addAll(d.path.operatingMargin, 0.01) } } : d },
        { factor: "salesToCapital", step: "+10%", apply: d => d.modelType === "fcff" ? { ...d, path: { ...d.path, salesToCapital: scaleAll(d.path.salesToCapital, 1.1) } } : d },
        { factor: "terminalGrowth", step: "+0.5pp", apply: d => d.modelType === "fcff" ? { ...d, terminalGrowth: d.terminalGrowth + 0.005 } : d },
        { factor: "terminalRoic", step: "+1pp", apply: d => d.modelType === "fcff" ? { ...d, terminalRoic: d.terminalRoic + 0.01 } : d },
      );
      break;
    case "fcfe": case "affo_dcf":
      moves.push(
        { factor: "growth", step: "+1pp", apply: d => d.modelType === base.modelType && "growth" in d ? { ...d, growth: addAll(d.growth, 0.01) } as ModelDrivers : d },
        { factor: "terminalGrowth", step: "+0.5pp", apply: d => "terminalGrowth" in d ? { ...d, terminalGrowth: d.terminalGrowth + 0.005 } as ModelDrivers : d },
      );
      break;
    case "revenue_fcfe":
      moves.push(
        { factor: "growth", step: "+1pp", apply: d => d.modelType === "revenue_fcfe" ? { ...d, growth: addAll(d.growth, 0.01) } : d },
        { factor: "afterSbcEquityCashMargin", step: "+1pp", apply: d => d.modelType === "revenue_fcfe" ? { ...d, afterSbcEquityCashMargin: addAll(d.afterSbcEquityCashMargin, 0.01) } : d },
        { factor: "terminalGrowth", step: "+0.5pp", apply: d => d.modelType === "revenue_fcfe" ? { ...d, terminalGrowth: d.terminalGrowth + 0.005 } : d },
      );
      break;
    case "residual_income":
      moves.push(
        { factor: "roe", step: "+1pp", apply: d => d.modelType === "residual_income" ? { ...d, roe: addAll(d.roe, 0.01) } : d },
        { factor: "terminalRoe", step: "+1pp", apply: d => d.modelType === "residual_income" ? { ...d, terminalRoe: d.terminalRoe + 0.01 } : d },
        { factor: "terminalGrowth", step: "+0.5pp", apply: d => d.modelType === "residual_income" ? { ...d, terminalGrowth: d.terminalGrowth + 0.005 } : d },
      );
      break;
    case "earnings_multiple": case "reported_earnings_multiple": case "proforma_earnings_multiple": case "affo_multiple":
      moves.push({ factor: "multiple", step: "+10%", apply: d => "multiple" in d ? { ...d, multiple: d.multiple * 1.1 } as ModelDrivers : d });
      break;
    case "asset_nav":
      moves.push({ factor: "assetPrices", step: "+10%", apply: d => d.modelType === "asset_nav" ? { ...d, assets: d.assets.map(a => ({ ...a, price: a.price * 1.1 })) } : d });
      break;
  }
  const out: Sensitivity[] = [];
  for (const move of moves) {
    try {
      const value = scenarioValue(move.apply(base), move.rate ?? r, shares, request.bridge).perShare;
      out.push({ factor: move.factor, step: move.step, perShare: value, changePercent: baseValue !== 0 ? (value / baseValue - 1) * 100 : 0 });
    } catch { /* a move that breaks a constraint (r <= g) is left out */ }
  }
  return out.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
}

/**
 * Reverse DCF: the constant revenue growth over the forecast that, with the base case's other drivers, makes the
 * base per-share value equal the price. Solved by bisection on a monotone interval; `converged` false when the price
 * sits outside what any growth in [−50%, +100%] produces.
 */
export function impliedGrowth(request: CalcRequest, r: number, shares: number, price: number): ImpliedPath | null {
  const base = request.scenarios.base.drivers;
  if (base.modelType !== "fcff" || !(price > 0)) return null;
  const valueAt = (g: number) => scenarioValue({ ...base, path: { ...base.path, revenueGrowth: new Array<number>(FORECAST_YEARS).fill(g) } }, r, shares, request.bridge).perShare;
  const baseAverage = base.path.revenueGrowth.reduce((a, b) => a + b, 0) / FORECAST_YEARS;
  let low = -0.5, high = 1.0;
  let fLow: number, fHigh: number;
  try { fLow = valueAt(low) - price; fHigh = valueAt(high) - price; } catch { return null; }
  if (fLow > 0 || fHigh < 0 || !(fLow <= fHigh)) return { factor: "revenueGrowth", implied: fLow > 0 ? low : high, baseAverage, gap: (fLow > 0 ? low : high) - baseAverage, converged: false };
  for (let i = 0; i < 80 && high - low > 1e-7; i++) {
    const mid = (low + high) / 2;
    const f = valueAt(mid) - price;
    if (f > 0) high = mid; else low = mid;
  }
  const implied = (low + high) / 2;
  return { factor: "revenueGrowth", implied, baseAverage, gap: implied - baseAverage, converged: true };
}

/** Treasury-stock-method dilution from in-the-money options and unvested units at the reference price. */
export function treasuryStockDilution(input: { options: number; weightedStrike: number; unvestedUnits: number; price: number }): number {
  const { options, weightedStrike, unvestedUnits, price } = input;
  if (!(price > 0)) return Math.max(unvestedUnits, 0);
  const optionDilution = options > 0 && weightedStrike < price ? options - options * weightedStrike / price : 0;
  return Math.max(optionDilution, 0) + Math.max(unvestedUnits, 0);
}

/** Quartiles of a factor's history, with the percentile rank of a value: the share of observations at or below it. */
export function distributionOf(factor: string, periods: Array<{ periodEnd: string; value: number }>): FactorDistribution | null {
  const values = periods.map(p => p.value).filter(finite).sort((a, b) => a - b);
  if (values.length < 3) return null;
  const q = (p: number) => { const i = (values.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return values[lo]! + (values[hi]! - values[lo]!) * (i - lo); };
  return { factor, periods: periods.filter(p => finite(p.value)), min: values[0]!, p25: q(0.25), median: q(0.5), p75: q(0.75), max: values[values.length - 1]! };
}
export function percentileRank(distribution: FactorDistribution, value: number): number {
  const values = distribution.periods.map(p => p.value);
  return values.filter(v => v <= value).length / values.length;
}
export const outsideHistory = (distribution: FactorDistribution, value: number) => value < distribution.min || value > distribution.max;

/** Cost of equity and WACC from sourced components; returns null for a component set too incomplete to use. */
export function discountRateBaseline(c: { riskFree: number; beta: number; equityRiskPremium: number; costOfDebt: number | null; taxRate: number | null; equityWeight: number | null }, basis: "wacc" | "cost_of_equity"): { value: number; costOfEquity: number } | null {
  if (![c.riskFree, c.beta, c.equityRiskPremium].every(finite)) return null;
  const costOfEquity = c.riskFree + c.beta * c.equityRiskPremium;
  if (basis === "cost_of_equity") return { value: costOfEquity, costOfEquity };
  if (!finite(c.costOfDebt) || !finite(c.taxRate) || !finite(c.equityWeight)) return null;
  const kd = Math.max(c.costOfDebt, c.riskFree);
  return { value: c.equityWeight * costOfEquity + (1 - c.equityWeight) * kd * (1 - c.taxRate), costOfEquity };
}

// ---- Scores, confidence and verdict (docs/valuation-assessment-implementation.md §3) ----

const VALID_SCORE = (score: number) => score >= 0 && score <= 10 && Math.abs(score * 2 - Math.round(score * 2)) < 1e-9;

/** The fixed-weight composite, one decimal; null as soon as any dimension is unscored. Weights are never redistributed. */
export function weightedScore(dimensions: ReadonlyArray<Pick<ValuationDimension, "key" | "score">>): number | null {
  const byKey = new Map(dimensions.map(d => [d.key, d.score]));
  let total = 0;
  for (const key of VALUATION_DIMENSIONS) {
    const score = byKey.get(key);
    if (score == null || !VALID_SCORE(score)) return null;
    total += DIMENSION_WEIGHTS[key] * score;
  }
  return Math.round(total * 10) / 10;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
/** The lowest dimension confidence; low whenever a dimension is unscored. */
export function overallConfidence(dimensions: ReadonlyArray<Pick<ValuationDimension, "score" | "confidence">>): Confidence {
  if (dimensions.length < VALUATION_DIMENSIONS.length || dimensions.some(d => d.score == null)) return "low";
  const lowest = Math.min(...dimensions.map(d => CONFIDENCE_RANK[d.confidence]));
  return (Object.keys(CONFIDENCE_RANK) as Confidence[]).find(c => CONFIDENCE_RANK[c] === lowest) ?? "low";
}

export type VerdictInput = {
  dimensions: ReadonlyArray<Pick<ValuationDimension, "key" | "score" | "confidence">>;
  marginOfSafety: number | null;
  /** Whether a comparable model and quote exist at all. */
  hasModel: boolean;
  /** Research found a decisive, unanswered counter-argument to the long-term thesis. */
  decisiveCounterEvidence: boolean;
  /** Evidence the core long-term logic has failed. */
  coreLogicFailed: boolean;
};
/** The report's conclusion, in the order the spec fixes: not_supported, then supported, otherwise pending. */
export function verdictOf(input: VerdictInput): ValuationVerdict {
  if (input.coreLogicFailed) return "not_supported";
  if (input.hasModel && input.marginOfSafety != null && input.marginOfSafety <= 0) return "not_supported";
  const score = weightedScore(input.dimensions);
  const catalysts = input.dimensions.find(d => d.key === "mispricingCatalysts")?.score ?? null;
  if (score != null && CONFIDENCE_RANK[overallConfidence(input.dimensions)] >= CONFIDENCE_RANK.medium && input.hasModel && input.marginOfSafety != null && input.marginOfSafety > 0
    && catalysts != null && catalysts >= 8 && !input.decisiveCounterEvidence) return "supported";
  return "pending";
}

/** The ceilings the spec puts on a dimension given what the numbers say; a score above its ceiling is rejected. */
export function dimensionCeilings(input: { marginOfSafety: number | null; downsideCoverage: number | null; bearProbability: number | null; terminalShare: number | null; hasIndependentConsensus: boolean; impliedGap: number | null; impliedGapThreshold: number | null; goingConcernUnresolved: boolean }): Partial<Record<ValuationDimension["key"], number>> {
  const ceilings: Partial<Record<ValuationDimension["key"], number>> = {};
  if (input.marginOfSafety == null || input.marginOfSafety <= 0) ceilings.valuationSafety = 5.5;
  else {
    if (input.downsideCoverage != null && input.downsideCoverage < -0.4 && (input.bearProbability ?? 0) >= 0.25) ceilings.valuationSafety = 7.5;
    if (input.terminalShare != null && input.terminalShare > TERMINAL_SHARE_LIMIT) ceilings.valuationSafety = Math.min(ceilings.valuationSafety ?? 10, 7.5);
  }
  const quantifiedGap = input.impliedGap != null && input.impliedGapThreshold != null && Math.abs(input.impliedGap) > input.impliedGapThreshold;
  if (!input.hasIndependentConsensus && !quantifiedGap) ceilings.mispricingCatalysts = input.impliedGap == null ? 7.5 : 6;
  if (input.goingConcernUnresolved) ceilings.financialResilience = 7.5;
  return ceilings;
}
