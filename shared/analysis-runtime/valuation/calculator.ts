import { DIMENSION_WEIGHTS, SCENARIO_KEYS, VALUATION_DIMENSIONS, VALUATION_METHODS, type Confidence, type ConsensusTarget, type DiscountRate, type EquityBridge, type FactorDistribution, type ImpliedPath, type InputCheck, type InputVerification, type ManagementTargetSet, type MethodValuation, type ModelDrivers, type MultipleQuartiles, type PeerMultiples, type PeerSelectionBasis, type ReferenceScenario, type RevenueAnchor, type SanityGate, type ScenarioAssumptions, type ScenarioKey, type ScenarioResult, type Sensitivity, type ShareCount, type Triangulation, type ValuationDimension, type ValuationMethodKey, type ValuationModelResult, type ValuationModelType, type ValuationRange, type ValuationVerdict, type YearRow } from "../../analysis-contract/valuation.ts";
import { managementDrivers, managementFactsOf, managementGate, managementRequest } from "./management.ts";
import { weightedQuantile } from "./peers.ts";

/**
 * The deterministic valuation calculator (docs/valuation-assessment-implementation.md §4, docs/valuation-methodology-optimization.md
 * §2–§6). Every amount a report shows comes from here; the model supplies inputs and reasons. Nothing is rounded until it
 * is displayed. Invalid inputs are rejected with a `ValuationCalcError` rather than producing NaN, Infinity or a made-up figure.
 */
export const CALCULATOR_VERSION = "valuation.calc.v3";
/** The default horizon; an fcff path may run `MIN_FORECAST_YEARS`–`MAX_FORECAST_YEARS` years (docs/valuation-v2-SPEC.md §1). */
export const FORECAST_YEARS = 5;
export const MIN_FORECAST_YEARS = 5, MAX_FORECAST_YEARS = 10;
/** Terminal growth above this is flagged; above the risk-free rate it is rejected. */
const TERMINAL_GROWTH_FLAG = 0.03;
/** Method bases further apart than this ratio are flagged; a base further than this share from the consensus mean is flagged. */
const DISPERSION_LIMIT = 2, CONSENSUS_DIVERGENCE_LIMIT = 0.5;
/** Terminal value above this share of operating value is a gap the report must name as its first invalidation condition. */
const TERMINAL_SHARE_LIMIT = 0.8;

export type ValuationCalcErrorCode = "invalid_input" | "rate_order" | "shares" | "multiple" | "scenario_order" | "unsupported_model";
export class ValuationCalcError extends Error {
  readonly code: ValuationCalcErrorCode;
  constructor(code: ValuationCalcErrorCode, message: string) { super(message); this.name = "ValuationCalcError"; this.code = code; }
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const requireFinite = (value: unknown, name: string): number => { if (!finite(value)) throw new ValuationCalcError("invalid_input", `${name} must be a finite number`); return value; };
/** Reject nonfinite numeric results before they can be serialized to null or used in ratios. */
function finiteResult<T>(value: T, name: string): T {
  if (typeof value === "number") requireFinite(value, name);
  else if (Array.isArray(value)) value.forEach((v, i) => finiteResult(v, `${name}[${i}]`));
  else if (value && typeof value === "object") for (const [key, v] of Object.entries(value)) finiteResult(v, `${name}.${key}`);
  return value;
}
const requireDiscountRate = (value: unknown): number => {
  const rate = requireFinite(value, "discount rate");
  if (rate <= 0) throw new ValuationCalcError("invalid_input", "discount rate must be positive");
  return rate;
};
const interpolate = (low: number, high: number, weight: number): number => {
  requireFinite(low, "low"); requireFinite(high, "high"); requireFinite(weight, "weight");
  if (weight < 0 || weight > 1) throw new ValuationCalcError("invalid_input", "weight must be between 0 and 1");
  if (low > high) throw new ValuationCalcError("invalid_input", "low must not exceed high");
  return (1 - weight) * low + weight * high;
};
const requireYears = (values: unknown, name: string, years = FORECAST_YEARS): number[] => {
  if (!Array.isArray(values) || values.length !== years) throw new ValuationCalcError("invalid_input", `${name} must list ${years} yearly values`);
  return values.map((v, i) => requireFinite(v, `${name}[${i + 1}]`));
};
const requireRates = (r: number, g: number) => {
  requireDiscountRate(r); requireFinite(g, "terminal growth");
  if (r <= g) throw new ValuationCalcError("rate_order", "terminal growth must be below the discount rate");
};

/** The forecast horizon an fcff path declares: its revenue-growth length, within the allowed range. */
export function horizonOf(path: { revenueGrowth: unknown }): number {
  const n = Array.isArray(path.revenueGrowth) ? path.revenueGrowth.length : 0;
  if (n < MIN_FORECAST_YEARS || n > MAX_FORECAST_YEARS) throw new ValuationCalcError("invalid_input", `the driver path must list ${MIN_FORECAST_YEARS} to ${MAX_FORECAST_YEARS} yearly values`);
  return n;
}

/** What the calculator may compare the model against; every piece optional, none of it changes a scenario's value. */
export type CalcContext = {
  /** Registered facts by id, for the cited-input verification. */
  facts?: Array<{ id: string; value: number; unit: string }>;
  riskFree?: number | null;
  /** Contracted revenue by forecast year from the RPO disclosure. */
  anchor?: RevenueAnchor | null;
  peers?: PeerMultiples | null;
  consensus?: ConsensusTarget | null;
  /** The company's own trailing EV/EBITDA history, for the implied-multiple gate. */
  multipleHistory?: FactorDistribution | null;
  /** Trailing EBITDA and D&A, and interest expense, for the implied multiple and the forward metrics. */
  trailing?: { ebitda: number | null; da: number | null; interestExpense: number | null };
  /** Years ahead the forward multiples are applied (default 3) and the method weights (default by life cycle). */
  forwardYears?: number;
  methodWeights?: Partial<Record<ValuationMethodKey, number>> | null;
  lifecycle?: Lifecycle | null;
  /** Management's cited targets and the period end the forecast years count from: the management reference case and its gate. */
  management?: ManagementTargetSet | null;
  periodEnd?: string | null;
};
export type Lifecycle = "build" | "growth" | "mature";

export type CalcRequest = {
  modelType: ValuationModelType;
  currency: string;
  discountRate: DiscountRate;
  shares: { base: number; dilutionReserve: number; basis: string };
  bridge: EquityBridge;
  scenarios: Record<ScenarioKey, ScenarioAssumptions>;
  price: number | null;
  /** Mid-year convention: cash flows at t − 0.5, the terminal at n − 0.5. Default off (year end). */
  midYear?: boolean;
  context?: CalcContext;
};

/** Discounts a cash-flow path and a terminal value at year `n`: the common kernel every cash-flow model shares. */
export function discountPath(cashFlows: number[], terminalValue: number, r: number, rows: Array<Partial<YearRow>> = [], midYear = false): { pvExplicit: number; pvTerminal: number; yearly: YearRow[] } {
  requireDiscountRate(r);
  finiteResult({ cashFlows, terminalValue, rows }, "discount inputs");
  const shift = midYear ? 0.5 : 0;
  const yearly = cashFlows.map((cashFlow, i) => {
    const discountFactor = 1 / requireFinite((1 + r) ** (i + 1 - shift), "discount divisor");
    const row: YearRow = { year: i + 1, revenue: rows[i]?.revenue ?? null, nopat: rows[i]?.nopat ?? null, reinvestment: rows[i]?.reinvestment ?? null, cashFlow, discountFactor, presentValue: cashFlow * discountFactor };
    if (rows[i]?.buildCapex != null) row.buildCapex = rows[i]!.buildCapex;
    return row;
  });
  const pvExplicit = yearly.reduce((sum, row) => sum + row.presentValue, 0);
  const pvTerminal = terminalValue / requireFinite((1 + r) ** (cashFlows.length - shift), "terminal discount divisor");
  return finiteResult({ pvExplicit, pvTerminal, yearly }, "discount result");
}

/** Gordon terminal value on the year after the last forecast year. */
export const gordonTerminal = (lastCashFlow: number, r: number, g: number) => requireFinite(requireFinite(lastCashFlow * (1 + g), "terminal cash flow") / (r - g), "terminal value");

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
  return finiteResult({ terminalValue: lastNopat * (1 + g) * (1 - reinvestmentRate) / (r - g), reinvestmentRate }, "value driver terminal");
}

const shareValue = (equity: number, shares: number) => requireFinite(requireFinite(equity, "equity value") / shares, "per-share value");
const terminalShareOf = (pvExplicit: number, pvTerminal: number) => { const total = pvExplicit + pvTerminal; return total > 0 ? pvTerminal / total : null; };

/** One scenario of one model: the equity value and per-share value from its drivers, the shared rate, shares and bridge. */
export function scenarioValue(drivers: ModelDrivers, r: number, shares: number, bridge: EquityBridge, options: { midYear?: boolean } = {}): ScenarioResult {
  requireFinite(shares, "shares");
  finiteResult(bridge, "bridge");
  return finiteResult(evaluateScenario(drivers, r, shares, bridge, options), "scenario result");
}

function evaluateScenario(drivers: ModelDrivers, r: number, shares: number, bridge: EquityBridge, options: { midYear?: boolean }): ScenarioResult {
  requireDiscountRate(r);
  if (!(shares > 0)) throw new ValuationCalcError("shares", "shares must be positive");
  const notes: string[] = [];
  const midYear = options.midYear === true;
  switch (drivers.modelType) {
    case "fcff": {
      const revenue0 = requireFinite(drivers.revenue0, "revenue0");
      const path = drivers.path;
      const years = horizonOf(path);
      const growth = requireYears(path.revenueGrowth, "revenueGrowth", years), margin = requireYears(path.operatingMargin, "operatingMargin", years);
      const tax = requireYears(path.taxRate, "taxRate", years), s2c = requireYears(path.salesToCapital, "salesToCapital", years);
      const normalization = path.normalization ? requireYears(path.normalization, "normalization", years) : new Array<number>(years).fill(0);
      const buildCapex = path.buildCapex ? requireYears(path.buildCapex, "buildCapex", years) : null;
      if (buildCapex?.some(v => v < 0)) throw new ValuationCalcError("invalid_input", "buildCapex cannot be negative");
      // The build may peak in any year, but it has to end inside the horizon: a terminal that still carries it would be a steady state misread.
      if (buildCapex && buildCapex[years - 1]! > 0) throw new ValuationCalcError("invalid_input", `buildCapex must end inside the horizon: year ${years} still carries ${buildCapex[years - 1]}; extend the horizon or let the build taper to 0`);
      requireRates(r, drivers.terminalGrowth);
      let revenue = revenue0;
      const rows: Array<Partial<YearRow>> = [], cashFlows: number[] = [];
      let depreciationCap = 0;
      for (let i = 0; i < years; i++) {
        const previous = revenue;
        revenue = previous * (1 + growth[i]!);
        if (s2c[i]! <= 0) throw new ValuationCalcError("invalid_input", "salesToCapital must be positive");
        const nopat = revenue * margin[i]! * (1 - tax[i]!);
        let reinvestment = (revenue - previous) / s2c[i]!;
        // Shrinking revenue releases capital, but never more than a year's worth of depreciation can plausibly return.
        depreciationCap = Math.abs(nopat) * 0.25;
        if (reinvestment < 0 && -reinvestment > depreciationCap) { reinvestment = -depreciationCap; notes.push(`year ${i + 1}: negative reinvestment capped`); }
        // Capacity built ahead of revenue is reinvestment too; it ends when the build does, so it never reaches the terminal.
        const build = buildCapex?.[i] ?? 0;
        reinvestment += build;
        cashFlows.push(nopat - reinvestment + normalization[i]!);
        rows.push({ revenue, nopat, reinvestment, ...(buildCapex ? { buildCapex: build } : {}) });
      }
      if (buildCapex) notes.push(`build capex ${buildCapex.reduce((a, b) => a + b, 0)} over ${years} years, outside the sales-to-capital reinvestment`);
      const last = rows[years - 1]!;
      let terminalNopat = last.nopat!;
      if (drivers.terminalOperatingMargin != null) {
        requireFinite(drivers.terminalOperatingMargin, "terminalOperatingMargin");
        terminalNopat = last.revenue! * drivers.terminalOperatingMargin * (1 - tax[years - 1]!);
        notes.push(`terminal NOPAT from a normalized ${(drivers.terminalOperatingMargin * 100).toFixed(1)}% margin (year ${years} margin ${(margin[years - 1]! * 100).toFixed(1)}%)`);
      }
      const { terminalValue, reinvestmentRate } = valueDriverTerminal(terminalNopat, r, drivers.terminalGrowth, drivers.terminalRoic);
      notes.push(`terminal reinvestment rate ${(reinvestmentRate * 100).toFixed(1)}% of NOPAT`);
      if (drivers.terminalRoic < r) notes.push("terminal ROIC below the discount rate: terminal growth destroys value");
      const { pvExplicit, pvTerminal, yearly } = discountPath(cashFlows, terminalValue, r, rows, midYear);
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
      const { pvExplicit, pvTerminal, yearly } = discountPath(cashFlows, gordonTerminal(cf, r, drivers.terminalGrowth), r, [], midYear);
      const equityValue = pvExplicit + pvTerminal + bridge.nonOperatingEquityAdjustment;
      return { perShare: shareValue(equityValue, shares), equityValue, enterpriseValue: null, pvExplicit, pvTerminal, terminalShare: terminalShareOf(pvExplicit, pvTerminal), yearly, notes: [`FCFE[0] = ${cf0}`] };
    }
    case "revenue_fcfe": {
      const growth = requireYears(drivers.growth, "growth"), margins = requireYears(drivers.afterSbcEquityCashMargin, "afterSbcEquityCashMargin");
      requireRates(r, drivers.terminalGrowth);
      let revenue = requireFinite(drivers.revenue0, "revenue0");
      const rows: Array<Partial<YearRow>> = [], cashFlows: number[] = [];
      for (let i = 0; i < FORECAST_YEARS; i++) { revenue = revenue * (1 + growth[i]!); cashFlows.push(revenue * margins[i]!); rows.push({ revenue }); }
      const { pvExplicit, pvTerminal, yearly } = discountPath(cashFlows, gordonTerminal(cashFlows[FORECAST_YEARS - 1]!, r, drivers.terminalGrowth), r, rows, midYear);
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
      const { pvExplicit, pvTerminal, yearly } = discountPath(residuals, terminalValue, r, rows, midYear);
      const equityValue = b0 + pvExplicit + pvTerminal;
      notes.push(`implied terminal payout ${((1 - g / terminalRoe) * 100).toFixed(1)}%`, `book equity after year ${FORECAST_YEARS}: ${book}`);
      return { perShare: shareValue(equityValue, shares), equityValue, enterpriseValue: null, pvExplicit, pvTerminal, terminalShare: null, yearly, notes };
    }
    case "earnings_multiple": {
      const eps = interpolate(drivers.epsLow, drivers.epsHigh, drivers.weight);
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
      const perShare = interpolate(drivers.affoLow, drivers.affoHigh, drivers.weight) - requireFinite(drivers.recurringCostPerShare, "recurringCostPerShare");
      return multipleValue(perShare, drivers.multiple, drivers.horizonYears, r, shares, notes);
    }
    case "affo_dcf": {
      const cf0 = requireFinite(drivers.annualAffo, "annualAffo") - requireFinite(drivers.recurringCost, "recurringCost");
      const growth = requireYears(drivers.growth, "growth");
      requireRates(r, drivers.terminalGrowth);
      const cashFlows: number[] = []; let cf = cf0;
      for (const g of growth) { cf = cf * (1 + g); cashFlows.push(cf); }
      const { pvExplicit, pvTerminal, yearly } = discountPath(cashFlows, gordonTerminal(cf, r, drivers.terminalGrowth), r, [], midYear);
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
  const perShare = requireFinite(perShareBasis * multiple, "multiple terminal value") / requireFinite((1 + r) ** horizonYears, "multiple discount divisor");
  notes.push(`per-share basis ${perShareBasis}`);
  return { perShare, equityValue: perShare * shares, enterpriseValue: null, pvExplicit: null, pvTerminal: null, terminalShare: null, yearly: [], notes };
}

/** The whole model: three scenarios, the range, the sensitivities on the base case, the market-implied path, and with a context the cross-checks and gates. */
export function calculateValuation(request: CalcRequest): ValuationModelResult {
  const r = requireDiscountRate(request.discountRate.value);
  const base = requireFinite(request.shares.base, "shares.base"), dilution = requireFinite(request.shares.dilutionReserve, "shares.dilutionReserve");
  const shares: ShareCount = { base, dilutionReserve: dilution, economic: requireFinite(base + dilution, "economic shares"), basis: request.shares.basis };
  if (shares.economic <= 0) throw new ValuationCalcError("shares", "economic shares must be positive");
  for (const key of ["nonOperatingAssets", "debtAndClaims", "nonOperatingEquityAdjustment"] as const) requireFinite(request.bridge[key], `bridge.${key}`);
  const expectedBasis = request.discountRate.basis;
  if ((request.modelType === "fcff" && expectedBasis !== "wacc") || (request.modelType !== "fcff" && request.modelType !== "asset_nav" && expectedBasis !== "cost_of_equity")) {
    throw new ValuationCalcError("invalid_input", `${request.modelType} discounts at ${request.modelType === "fcff" ? "wacc" : "cost_of_equity"}, not ${expectedBasis}`);
  }
  const midYear = request.midYear === true;
  const results = {} as Record<ScenarioKey, ScenarioAssumptions & { result: ScenarioResult }>;
  for (const key of SCENARIO_KEYS) {
    const scenario = request.scenarios[key];
    if (!scenario || scenario.drivers.modelType !== request.modelType) throw new ValuationCalcError("invalid_input", `scenario ${key} is missing or uses another model`);
    results[key] = { ...scenario, result: scenarioValue(scenario.drivers, r, shares.economic, request.bridge, { midYear }) };
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
  const baseDrivers = request.scenarios.base.drivers;
  const horizonYears = baseDrivers.modelType === "fcff" ? horizonOf(baseDrivers.path) : FORECAST_YEARS;
  const limitations: string[] = [midYear ? "Cash flows are discounted mid-year; no stub period." : "Cash flows are discounted at year end; no mid-year convention and no stub period."];
  const terminalShare = results.base.result.terminalShare;
  if (terminalShare != null && terminalShare > TERMINAL_SHARE_LIMIT) limitations.push(`Terminal value is ${(terminalShare * 100).toFixed(0)}% of the base operating value.`);
  const result: ValuationModelResult = { calculatorVersion: CALCULATOR_VERSION, modelType: request.modelType, currency: request.currency, discountRate: request.discountRate, shares, bridge: request.bridge, scenarios: results, range, sensitivities, implied, limitations, horizonYears, midYear };
  if (!request.context) return finiteResult(result, "valuation result");
  // The cross-checks: the DCF beside the forward multiples, the anchors, the verification and the gates over all of it.
  const c = request.context;
  const dcf: MethodValuation = { method: "dcf", label: "Discounted cash flow", low: values.bear, base: values.base, high: values.bull, weight: 0, basis: `${request.modelType}, ${horizonYears} years`, notes: [] };
  const forward = request.modelType === "fcff" ? forwardMethods(request, results.base.result, r, shares.economic, c) : [];
  const weights = methodWeightsOf(c.methodWeights ?? null, c.lifecycle ?? null);
  const methods = [dcf, ...forward].map(m => ({ ...m, weight: weights[m.method] }));
  const triangulation = triangulate(methods);
  const verification = c.facts ? verifyCitedInputs(request, c.facts) : null;
  const multipleHistory = c.multipleHistory ?? null, trailingEbitda = c.trailing?.ebitda ?? null;
  const impliedMultiple = results.base.result.enterpriseValue != null && trailingEbitda != null && trailingEbitda > 0 ? results.base.result.enterpriseValue / trailingEbitda : null;
  const references = managementReferences(request, r, shares.economic, c);
  const management = c.management && c.periodEnd && baseDrivers.modelType === "fcff" ? managementGate(baseDrivers, c.management, c.periodEnd) : null;
  const gates = sanityGates({ result, riskFree: c.riskFree ?? null, anchor: c.anchor ?? null, consensus: c.consensus ?? null, triangulation, verification, impliedMultiple, multipleHistory, peers: c.peers ?? null, management });
  if (methods.length === 1) limitations.push("No forward-multiple cross-check: the ranking peers' multiples were not available.");
  return finiteResult({ ...result, methods, triangulation, gates, anchors: { revenue: c.anchor ?? null }, verification, peers: c.peers ?? null, consensus: c.consensus ?? null, ...(references.length ? { references } : {}) }, "valuation result");
}

/** The management case beside the model: the cited targets on the model's own rate, shares, bridge, horizon, tax and sales-to-capital; empty without targets inside the horizon. */
function managementReferences(request: CalcRequest, r: number, shares: number, c: CalcContext): ReferenceScenario[] {
  const base = request.scenarios.base.drivers;
  if (!c.management || !c.periodEnd || base.modelType !== "fcff") return [];
  const built = managementDrivers(base, c.management, c.periodEnd, managementFactsOf(c.facts ?? [], base.revenue0));
  if (!built) return [];
  try {
    const result = scenarioValue(built.drivers, r, shares, request.bridge, { midYear: request.midYear === true });
    const sub = calculateValuation(managementRequest(request, built.drivers));
    return [{ key: "management", label: "Management case (cited targets)", drivers: built.drivers, result, triangulation: sub.triangulation ?? null, methods: sub.methods ?? [], anchors: built.anchors, sources: c.management.sources, notes: built.notes }];
  } catch (error) {
    if (error instanceof ValuationCalcError && !/finite number/.test(error.message)) return [];
    throw error;
  }
}

/** The forward EV/EBITDA and P/E methods on the base path, `forwardYears` ahead, at the ranking peers' quartiles. */
function forwardMethods(request: CalcRequest, base: ScenarioResult, r: number, shares: number, c: CalcContext): MethodValuation[] {
  const peers = c.peers ?? null;
  const drivers = request.scenarios.base.drivers;
  if (drivers.modelType !== "fcff") return [];
  const h = Math.min(Math.max(Math.round(c.forwardYears ?? 3), 1), base.yearly.length);
  const metrics = forwardFundamentals(drivers, h, { da0: c.trailing?.da ?? null, interestExpense0: c.trailing?.interestExpense ?? null, shares });
  const cumulativeCashFlow = base.yearly.slice(0, h).reduce((sum, y) => sum + y.cashFlow, 0);
  const out: MethodValuation[] = [];
  const unavailable = (method: ValuationMethodKey, label: string, basis: string, why: string): MethodValuation => ({ method, label, low: null, base: null, high: null, weight: 0, basis, notes: [why] });
  if (peers?.evToEbitda && metrics.ebitda != null && metrics.ebitda > 0) {
    const v = forwardMultipleValue({ metric: metrics.ebitda, multiples: peers.evToEbitda, horizonYears: h, r, kind: "ev", bridge: request.bridge, shares, cumulativeCashFlow });
    out.push({ method: "ev_ebitda_forward", label: `EV/EBITDA on year ${h}`, ...v, weight: 0, basis: `year ${h} EBITDA ${metrics.ebitda.toExponential(3)} × peers p25/median/p75 ${peers.evToEbitda.p25.toFixed(1)}/${peers.evToEbitda.median.toFixed(1)}/${peers.evToEbitda.p75.toFixed(1)} (${peers.evToEbitda.count} peers), discounted ${h} years; net claims rolled forward by the base cash flows`, notes: metrics.notes });
  } else out.push(unavailable("ev_ebitda_forward", `EV/EBITDA on year ${h}`, "not applied", peers?.evToEbitda ? "forward EBITDA is not positive" : "no peer EV/EBITDA"));
  if (peers?.peRatio && metrics.eps != null && metrics.eps > 0) {
    const v = forwardMultipleValue({ metric: metrics.eps, multiples: peers.peRatio, horizonYears: h, r, kind: "equity", bridge: request.bridge, shares, cumulativeCashFlow });
    out.push({ method: "pe_forward", label: `P/E on year ${h}`, ...v, weight: 0, basis: `year ${h} core EPS ${metrics.eps.toFixed(2)} × peers p25/median/p75 ${peers.peRatio.p25.toFixed(1)}/${peers.peRatio.median.toFixed(1)}/${peers.peRatio.p75.toFixed(1)} (${peers.peRatio.count} peers), discounted ${h} years`, notes: metrics.notes });
  } else out.push(unavailable("pe_forward", `P/E on year ${h}`, "not applied", metrics.epsStatus === "insufficient_data" ? "Insufficient data: trailing interest expense is unknown; forward EPS and P/E are unavailable" : peers?.peRatio ? "forward core EPS is not positive" : "no peer P/E"));
  return out;
}

/** Year-`h` EBITDA and core EPS of an fcff path: EBIT from the path, D&A scaled with revenue, interest held at its trailing level. */
export function forwardFundamentals(drivers: Extract<ModelDrivers, { modelType: "fcff" }>, h: number, input: { da0: number | null; interestExpense0: number | null; shares: number }): { revenue: number; ebit: number; ebitda: number | null; eps: number | null; epsStatus: "ready" | "insufficient_data"; notes: string[] } {
  const years = horizonOf(drivers.path);
  const n = Math.min(Math.max(h, 1), years);
  let revenue = drivers.revenue0;
  for (let i = 0; i < n; i++) revenue *= 1 + drivers.path.revenueGrowth[i]!;
  const ebit = revenue * drivers.path.operatingMargin[n - 1]!;
  const notes: string[] = [];
  const da = input.da0 != null && drivers.revenue0 > 0 ? input.da0 * revenue / drivers.revenue0 : null;
  if (da == null) notes.push("no trailing D&A: EBITDA not projected");
  const interest = input.interestExpense0;
  if (interest != null) requireFinite(interest, "interest expense");
  const eps = interest != null && input.shares > 0 ? (ebit - interest) * (1 - drivers.path.taxRate[n - 1]!) / input.shares : null;
  if (interest == null) notes.push("Insufficient data: trailing interest expense is unknown; EPS not projected");
  else notes.push(`core EPS excludes securities gains: (EBIT − interest ${interest.toExponential(2)}) × (1 − tax)`);
  return finiteResult({ revenue, ebit, ebitda: da != null ? ebit + da : null, eps, epsStatus: eps == null ? "insufficient_data" as const : "ready" as const, notes }, "forward fundamentals");
}

/**
 * A forward multiple brought back to today: an enterprise multiple less the net claims as the base cash flows leave them
 * at the horizon (a build phase adds debt before it adds EBITDA), or an equity multiple on the per-share metric.
 */
export function forwardMultipleValue(input: { metric: number; multiples: MultipleQuartiles; horizonYears: number; r: number; kind: "ev" | "equity"; bridge: EquityBridge; shares: number; cumulativeCashFlow: number }): { low: number; base: number; high: number } {
  const { metric, multiples, horizonYears: h, r, bridge, shares } = input;
  requireFinite(metric, "forward metric"); requireFinite(r, "discount rate");
  requireDiscountRate(r);
  if (!(shares > 0)) throw new ValuationCalcError("shares", "shares must be positive");
  if (h < 0) throw new ValuationCalcError("invalid_input", "horizonYears cannot be negative");
  const discount = requireFinite((1 + r) ** h, "forward discount divisor");
  const value = (multiple: number) => {
    if (multiple < 0) throw new ValuationCalcError("multiple", "multiple cannot be negative");
    if (input.kind === "equity") return requireFinite(metric * multiple, "forward terminal value") / discount;
    const netClaimsAtHorizon = bridge.debtAndClaims - bridge.nonOperatingAssets - input.cumulativeCashFlow;
    return requireFinite(requireFinite(metric * multiple, "forward terminal value") - netClaimsAtHorizon, "forward equity value") / discount / shares;
  };
  return finiteResult({ low: value(multiples.p25), base: value(multiples.median), high: value(multiples.p75) }, "forward multiple result");
}

/** Default method weights by life cycle; explicit weights are normalized over the methods given. */
export function methodWeightsOf(explicit: Partial<Record<ValuationMethodKey, number>> | null, lifecycle: Lifecycle | null): Record<ValuationMethodKey, number> {
  const defaults: Record<Lifecycle, Record<ValuationMethodKey, number>> = {
    build: { dcf: 0.5, ev_ebitda_forward: 0.3, pe_forward: 0.2 }, growth: { dcf: 0.6, ev_ebitda_forward: 0.25, pe_forward: 0.15 }, mature: { dcf: 0.7, ev_ebitda_forward: 0.15, pe_forward: 0.15 },
  };
  const chosen = { ...defaults[lifecycle ?? "mature"] };
  if (explicit) for (const key of VALUATION_METHODS) { const w = explicit[key]; if (finite(w) && w >= 0) chosen[key] = w; }
  const total = VALUATION_METHODS.reduce((sum, k) => sum + chosen[k], 0);
  if (!(total > 0)) throw new ValuationCalcError("invalid_input", "method weights must sum to a positive number");
  for (const key of VALUATION_METHODS) chosen[key] = chosen[key] / total;
  return chosen;
}

/** The football field: method weights renormalized over the methods that applied; dispersion is max/min of the bases. */
export function triangulate(methods: MethodValuation[]): Triangulation | null {
  const applied = methods.filter(m => m.base != null && m.low != null && m.high != null && m.weight > 0);
  if (!applied.length) return null;
  const total = applied.reduce((sum, m) => sum + m.weight, 0);
  const weighted = (pick: (m: MethodValuation) => number) => applied.reduce((sum, m) => sum + m.weight / total * pick(m), 0);
  const bases = applied.map(m => m.base!);
  const min = Math.min(...bases), max = Math.max(...bases);
  const weights = Object.fromEntries(VALUATION_METHODS.map(k => [k, applied.find(m => m.method === k) ? applied.find(m => m.method === k)!.weight / total : 0])) as Record<ValuationMethodKey, number>;
  return { low: weighted(m => m.low!), base: weighted(m => m.base!), high: weighted(m => m.high!), dispersion: min > 0 ? max / min : null, weights };
}

/**
 * Quartiles of the peers' trailing EV/EBITDA and core P/E at their reference closes; peers without a figure are left out.
 * A peer's `weight` (default equal) is its share of the weighted quartiles; weights are renormalized over the peers that answer.
 */
export function peerMultiplesOf(peers: Array<{ ticker: string; price: number | null; shares: number | null; ebitda: number | null; coreEarnings: number | null; netDebt: number | null; weight?: number | null }>, asOf: string, basis?: PeerSelectionBasis): PeerMultiples | null {
  const ev: Array<{ value: number; weight: number }> = [], pe: Array<{ value: number; weight: number }> = [], answered: string[] = [], notes: string[] = [], weights: Record<string, number> = {};
  for (const p of peers) {
    if (!finite(p.price) || !finite(p.shares) || !(p.price! > 0) || !(p.shares! > 0)) { notes.push(`${p.ticker}: no quote or share count`); continue; }
    const marketCap = p.price! * p.shares!, weight = finite(p.weight) && p.weight! > 0 ? p.weight! : 1;
    let used = false;
    if (finite(p.ebitda) && p.ebitda! > 0 && finite(p.netDebt)) { ev.push({ value: (marketCap + p.netDebt!) / p.ebitda!, weight }); used = true; }
    if (finite(p.coreEarnings) && p.coreEarnings! > 0) { pe.push({ value: marketCap / p.coreEarnings!, weight }); used = true; }
    if (used) { answered.push(p.ticker); weights[p.ticker] = weight; } else notes.push(`${p.ticker}: no positive EBITDA or core earnings`);
  }
  if (!answered.length) return null;
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  for (const t of answered) weights[t] = weights[t]! / total;
  const quartiles = (list: Array<{ value: number; weight: number }>): MultipleQuartiles | null => list.length < 2 ? null : { p25: weightedQuantile(list, 0.25), median: weightedQuantile(list, 0.5), p75: weightedQuantile(list, 0.75), count: list.length };
  return { peers: answered, asOf, evToEbitda: quartiles(ev), peRatio: quartiles(pe), notes, weights, ...(basis ? { basis } : {}) };
}

/**
 * Contracted revenue by forecast year from the RPO buckets. A bucket of `months` starting `startMonths` after the period
 * end is spread evenly over the months it covers; a bucket without a length runs to the next bucket's start, or, when it
 * is the only or the last one, over `openMonths` (default 24, the usual "over the next 24 months" wording).
 */
export function rpoRevenueFloor(input: { asOf: string; total: number; buckets: Array<{ startMonths: number; months: number | null; share: number }>; years: number; revenue0: number; openMonths?: number }): RevenueAnchor {
  const { total, years, revenue0 } = input;
  requireFinite(total, "rpo total"); requireFinite(revenue0, "revenue0");
  const floor = new Array<number>(years).fill(0);
  const notes: string[] = [];
  const buckets = [...input.buckets].sort((a, b) => a.startMonths - b.startMonths);
  const shareSum = buckets.reduce((sum, b) => sum + b.share, 0);
  if (shareSum > 1.001) throw new ValuationCalcError("invalid_input", "RPO bucket shares exceed 100%");
  if (shareSum < 0.999) notes.push(`${((1 - shareSum) * 100).toFixed(0)}% of the RPO has no stated timing and is left out of the floor`);
  buckets.forEach((b, i) => {
    const next = buckets[i + 1];
    let months = b.months;
    if (months == null) { months = next ? next.startMonths - b.startMonths : (input.openMonths ?? 24); notes.push(`bucket from month ${b.startMonths} has no stated length; spread over ${months} months`); }
    if (!(months > 0)) return;
    const amount = total * b.share, perMonth = amount / months;
    for (let m = b.startMonths; m < b.startMonths + months; m++) { const year = Math.floor(m / 12); if (year < years) floor[year]! += perMonth; }
    if (b.startMonths + months > years * 12) notes.push(`part of the bucket from month ${b.startMonths} falls beyond the ${years}-year horizon`);
  });
  return { source: "rpo", asOf: input.asOf, total, floor, floorToRevenue0: floor.map(f => revenue0 > 0 ? f / revenue0 : 0), notes };
}

/** The base revenue path against the contracted floor: years whose revenue falls under what is already contracted. */
export function floorBreaches(drivers: Extract<ModelDrivers, { modelType: "fcff" }>, anchor: RevenueAnchor): Array<{ year: number; revenue: number; floor: number }> {
  const out: Array<{ year: number; revenue: number; floor: number }> = [];
  let revenue = drivers.revenue0;
  drivers.path.revenueGrowth.forEach((g, i) => { revenue *= 1 + g; const f = anchor.floor[i]; if (f != null && revenue < f) out.push({ year: i + 1, revenue, floor: f }); });
  return out;
}

/** The cited inputs against the registered facts; the bridge may carry more claims than the facts name, never fewer. */
export function verifyCitedInputs(request: CalcRequest, facts: Array<{ id: string; value: number; unit: string }>): InputVerification {
  const fact = (id: string) => facts.find(f => f.id === id)?.value ?? null;
  const checks: InputCheck[] = [];
  const check = (field: string, cited: number, expected: number | null, factIds: string[], tolerance: number, mode: "both" | "at_least" | "at_most", severity: "fail" | "flag" = "fail") => {
    if (expected == null) { checks.push({ field, cited, expected: null, factIds, tolerance, status: "pass", detail: `${field}: no fact to check against` }); return; }
    const scale = Math.max(Math.abs(expected), 1);
    const deviation = (cited - expected) / scale;
    const ok = mode === "both" ? Math.abs(deviation) <= tolerance : mode === "at_least" ? deviation >= -tolerance : deviation <= tolerance;
    checks.push({ field, cited, expected, factIds, tolerance, status: ok ? "pass" : severity, detail: ok ? `${field} matches the facts` : `${field} ${cited} vs facts ${expected} (${mode === "both" ? "±" : mode === "at_least" ? "at least" : "at most"} ${(tolerance * 100).toFixed(1)}%)` });
  };
  const base = request.scenarios.base.drivers;
  if (base.modelType === "fcff") check("revenue0", base.revenue0, fact("revenue_ttm"), ["revenue_ttm"], 0.005, "both");
  const shareFacts = facts.filter(f => f.unit === "shares");
  if (shareFacts.length) {
    const nearest = shareFacts.reduce((best, f) => Math.abs(f.value - request.shares.base) < Math.abs(best.value - request.shares.base) ? f : best);
    check("shares.base", request.shares.base, nearest.value, [nearest.id], 0.001, "both");
  }
  const debt = fact("debt"), leases = fact("leases"), preferred = fact("preferred_stock"), minority = fact("minority_interest");
  if (debt != null) check("bridge.debtAndClaims (debt + leases)", request.bridge.debtAndClaims, debt + (leases ?? 0), ["debt", ...(leases != null ? ["leases"] : [])], 0.02, "at_least");
  const seniorClaims = (preferred ?? 0) + (minority ?? 0);
  if (debt != null && seniorClaims > 0) check("bridge.debtAndClaims (incl. preferred and minority)", request.bridge.debtAndClaims, debt + (leases ?? 0) + seniorClaims, ["debt", ...(leases != null ? ["leases"] : []), ...(preferred ? ["preferred_stock"] : []), ...(minority ? ["minority_interest"] : [])], 0.02, "at_least", "flag");
  const cash = fact("cash"), investments = fact("investments");
  if (cash != null) check("bridge.nonOperatingAssets (cash + investments)", request.bridge.nonOperatingAssets, cash + (investments ?? 0), ["cash", ...(investments != null ? ["investments"] : [])], 0.02, "at_most");
  return { checks, ok: !checks.some(c => c.status === "fail") };
}

/** The gates (docs/valuation-v2-SPEC.md §5): fails reject the calculation inside the tool, flags annotate the report. */
export function sanityGates(input: { result: ValuationModelResult; riskFree: number | null; anchor: RevenueAnchor | null; consensus: ConsensusTarget | null; triangulation: Triangulation | null; verification: InputVerification | null; impliedMultiple: number | null; multipleHistory: FactorDistribution | null; peers: PeerMultiples | null; management?: SanityGate | null }): SanityGate[] {
  const { result } = input;
  const gates: SanityGate[] = [];
  const gate = (key: string, status: SanityGate["status"], detail: string, value: number | null = null, limit: number | null = null) => gates.push({ key, status, detail, value, limit });
  const terminalShare = result.scenarios.base.result.terminalShare;
  if (terminalShare != null) gate("terminal_share", terminalShare > 1 ? "fail" : terminalShare > TERMINAL_SHARE_LIMIT ? "flag" : "pass", `terminal value is ${(terminalShare * 100).toFixed(0)}% of the base operating value${terminalShare > 1 ? ": the explicit period is worth less than nothing; extend the horizon or normalize the build phase" : ""}`, terminalShare, TERMINAL_SHARE_LIMIT);
  const negative = SCENARIO_KEYS.filter(k => result.scenarios[k].result.perShare < 0);
  gate("non_negative_scenarios", negative.length ? "fail" : "pass", negative.length ? `${negative.join(", ")} per-share value is negative: equity cannot be worth less than zero; revise the path` : "every scenario is non-negative", negative.length ? result.scenarios[negative[0]!].result.perShare : null, 0);
  const g = "terminalGrowth" in result.scenarios.base.drivers ? result.scenarios.base.drivers.terminalGrowth : null;
  if (g != null) {
    const aboveRf = input.riskFree != null && g > input.riskFree + 1e-9;
    gate("terminal_growth", aboveRf ? "fail" : g > TERMINAL_GROWTH_FLAG + 1e-9 ? "flag" : "pass", aboveRf ? `terminal growth ${(g * 100).toFixed(1)}% exceeds the risk-free rate ${(input.riskFree! * 100).toFixed(1)}%` : g > TERMINAL_GROWTH_FLAG ? `terminal growth ${(g * 100).toFixed(1)}% is above the usual 2–3%; the narrative must say why` : `terminal growth ${(g * 100).toFixed(1)}%`, g, aboveRf ? input.riskFree : TERMINAL_GROWTH_FLAG);
  }
  if (input.verification) gate("cited_inputs", input.verification.ok ? (input.verification.checks.some(c => c.status === "flag") ? "flag" : "pass") : "fail", input.verification.checks.filter(c => c.status !== "pass").map(c => c.detail).join("; ") || "cited inputs match the registered facts");
  if (input.anchor) {
    const base = result.scenarios.base.drivers;
    const breaches = base.modelType === "fcff" ? floorBreaches(base, input.anchor) : [];
    gate("rpo_floor", breaches.length ? "flag" : "pass", breaches.length ? `base revenue falls under contracted revenue in year ${breaches.map(b => `${b.year} (${b.revenue.toExponential(3)} < ${b.floor.toExponential(3)})`).join(", ")}` : `base revenue stays above the contracted floor (${input.anchor.floor.map(f => f.toExponential(2)).join(", ")})`, breaches.length ? breaches[0]!.revenue : null, breaches.length ? breaches[0]!.floor : null);
  }
  if (input.multipleHistory && input.impliedMultiple != null) {
    const h = input.multipleHistory;
    const outside = input.impliedMultiple < h.min || input.impliedMultiple > h.max;
    gate("implied_multiple_vs_history", outside ? "flag" : "pass", `base value implies ${input.impliedMultiple.toFixed(1)}x trailing EBITDA; the company traded at ${h.min.toFixed(1)}–${h.max.toFixed(1)}x (median ${h.median.toFixed(1)}x) over ${h.periods.length} weeks`, input.impliedMultiple, outside ? (input.impliedMultiple < h.min ? h.min : h.max) : null);
  }
  if (input.triangulation?.dispersion != null) gate("method_dispersion", input.triangulation.dispersion > DISPERSION_LIMIT ? "flag" : "pass", `method bases span ${input.triangulation.dispersion.toFixed(2)}x`, input.triangulation.dispersion, DISPERSION_LIMIT);
  else if (input.peers == null) gate("method_dispersion", "flag", "single method: no peer multiples to cross-check against");
  if (input.management) gates.push(input.management);
  if (input.consensus && input.consensus.mean > 0) {
    const divergence = result.range.base / input.consensus.mean - 1;
    gate("consensus_divergence", Math.abs(divergence) > CONSENSUS_DIVERGENCE_LIMIT ? "flag" : "pass", `base ${result.range.base.toFixed(2)} is ${(divergence * 100).toFixed(0)}% from the consensus mean ${input.consensus.mean.toFixed(2)}${input.consensus.low != null && input.consensus.high != null ? ` (range ${input.consensus.low}–${input.consensus.high})` : ""}${Math.abs(divergence) > CONSENSUS_DIVERGENCE_LIMIT ? "; the expectations-gap section must quantify why" : ""}`, divergence, CONSENSUS_DIVERGENCE_LIMIT);
  }
  return gates;
}

/** EV/EBITDA week by week from closes, a share count and the trailing EBITDA and net debt of the newest quarter on or before each date. */
export function multipleHistoryOf(closes: Array<{ date: string; close: number }>, shares: number, quarters: Array<{ periodEnd: string; ebitdaTtm: number; netDebt: number }>): FactorDistribution | null {
  if (!(shares > 0) || !quarters.length) return null;
  const sorted = [...quarters].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const points = closes.flatMap(c => {
    const q = [...sorted].reverse().find(q => q.periodEnd <= c.date);
    return q && q.ebitdaTtm > 0 ? [{ periodEnd: c.date, value: (c.close * shares + q.netDebt) / q.ebitdaTtm }] : [];
  });
  return distributionOf("evToEbitda", points);
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
  const ratio = (numerator: number | null, denominator: number | null) => numerator != null && denominator != null && denominator > 0 && numerator >= 0 ? numerator / denominator - 1 : null;
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
  const options = { midYear: request.midYear === true };
  const baseValue = scenarioValue(base, r, shares, request.bridge, options).perShare;
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
      const value = scenarioValue(move.apply(base), move.rate ?? r, shares, request.bridge, options).perShare;
      out.push({ factor: move.factor, step: move.step, perShare: value, changePercent: baseValue !== 0 ? (value / baseValue - 1) * 100 : 0 });
    } catch (error) {
      if (!(error instanceof ValuationCalcError) || /finite number/.test(error.message)) throw error;
      // A sensitivity outside a model constraint (such as r <= g) is not defined.
    }
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
  const years = horizonOf(base.path);
  const valueAt = (g: number) => scenarioValue({ ...base, path: { ...base.path, revenueGrowth: new Array<number>(years).fill(g) } }, r, shares, request.bridge, { midYear: request.midYear === true }).perShare;
  const baseAverage = base.path.revenueGrowth.reduce((a, b) => a + b, 0) / years;
  let low = -0.5, high = 1.0;
  let fLow: number, fHigh: number;
  try { fLow = valueAt(low) - price; fHigh = valueAt(high) - price; } catch (error) {
    if (!(error instanceof ValuationCalcError) || /finite number/.test(error.message)) throw error;
    return null;
  }
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
