import assert from "node:assert/strict";
import { test } from "node:test";
import { VALUATION_DIMENSIONS, VALUATION_MODEL_TYPES, type ModelDrivers, type ValuationPublication } from "../../../shared/analysis-contract/valuation.ts";
import { readValuationPublication } from "../../../shared/analysis-runtime/valuation/read.ts";

// Synthetic contract examples; reading a report validates its shape without recalculating it.
const examples: ModelDrivers[] = [
  { modelType: "fcff", revenue0: 100, path: { revenueGrowth: [0.05], operatingMargin: [0.2], taxRate: [0.21], salesToCapital: [2] }, terminalGrowth: 0.02, terminalRoic: 0.1 },
  { modelType: "fcfe", cfo: 20, capex: 5, sbc: 1, normalization: 0, netBorrowing: 0, growth: [0.05], terminalGrowth: 0.02 },
  { modelType: "revenue_fcfe", revenue0: 100, growth: [0.05], afterSbcEquityCashMargin: [0.1], terminalGrowth: 0.02 },
  { modelType: "residual_income", bookEquity0: 100, roe: [0.1], payout: [0.5], terminalRoe: 0.1, terminalGrowth: 0.02 },
  { modelType: "earnings_multiple", epsLow: 2, epsHigh: 3, weight: 0.5, multiple: 15, horizonYears: 5 },
  { modelType: "reported_earnings_multiple", commonEarnings: 20, earningsScale: 1, multiple: 15, horizonYears: 5 },
  { modelType: "proforma_earnings_multiple", commonEarnings: 20, earningsScale: 1, multiple: 15, horizonYears: 5 },
  { modelType: "asset_nav", assets: [{ units: 10, price: 5, costBasis: 2, taxRate: 0.21 }], otherNetAssets: 5, debtClaims: 2, preferredClaims: 0, operatingReserve: 1 },
  { modelType: "affo_multiple", affoLow: 2, affoHigh: 3, weight: 0.5, recurringCostPerShare: 0.1, multiple: 15, horizonYears: 5 },
  { modelType: "affo_dcf", annualAffo: 20, recurringCost: 1, growth: [0.05], terminalGrowth: 0.02 },
];

function publication(drivers: ModelDrivers): ValuationPublication {
  const result = { perShare: 10, equityValue: 100, enterpriseValue: null, pvExplicit: null, pvTerminal: null, terminalShare: null, yearly: [], notes: [] };
  const scenario = { narrative: "Synthetic", probability: null, triggers: [], invalidation: [], evidenceIds: [], drivers, result };
  return {
    schemaVersion: "valuation.v1", ticker: "ACME", cik: null, companyName: "Acme", currency: "USD", researchAsOf: "2026-01-01", financialPeriodEnd: "2025-12-31", generatedAt: "2026-01-01",
    methodVersion: "test", calculatorVersion: "test", baseInputFingerprint: "test", evidenceSetHash: "test", reportStatus: "ready", verdict: "pending", weightedScore: null, confidence: "medium",
    dimensions: VALUATION_DIMENSIONS.map(key => ({ key, score: null, confidence: "medium", rationale: "", supportingEvidenceIds: [], counterEvidenceIds: [], gaps: [], nextCheck: "" })),
    quote: null,
    model: {
      calculatorVersion: "test", modelType: drivers.modelType, currency: "USD",
      discountRate: { value: 0.1, basis: "wacc", components: { riskFree: null, beta: null, equityRiskPremium: null, costOfEquity: null, costOfDebt: null, taxRate: null, equityWeight: null }, rationale: "", sourceRefs: [] },
      shares: { base: 10, dilutionReserve: 0, economic: 10, basis: "test" }, bridge: { nonOperatingAssets: 0, debtAndClaims: 0, nonOperatingEquityAdjustment: 0, notes: [] },
      scenarios: { bear: scenario, base: scenario, bull: scenario },
      range: { low: 10, high: 10, base: 10, expected: null, price: null, marginOfSafety: null, downsideCoverage: null, expectedUpside: null, baseUpside: null },
      sensitivities: [], implied: null, limitations: [],
      references: [{ key: "management", label: "Management", drivers, result, triangulation: null, methods: [], anchors: [], sources: [], notes: [] }],
    },
    facts: [], diagnostics: [], distributions: [], sections: { summary: "", thesis: "", expectationsGap: "", catalysts: [], counterEvidence: [], nextChecks: [], modelNotes: "" }, evidence: [], gaps: [], versionId: "test",
  };
}

function withDrivers(drivers: unknown, location: "bear" | "base" | "bull" | "reference") {
  const report = publication(examples[0]!);
  const model = report.model!;
  if (location === "reference") return { ...report, model: { ...model, references: [{ ...model.references![0], drivers }] } };
  return { ...report, model: { ...model, scenarios: { ...model.scenarios, [location]: { ...model.scenarios[location], drivers } } } };
}

test("valuation reader preserves every model's contracted drivers", () => {
  assert.deepEqual(examples.map(d => d.modelType), [...VALUATION_MODEL_TYPES]);
  for (const drivers of examples) {
    const parsed = readValuationPublication(publication(drivers), "ACME");
    assert.ok(parsed, drivers.modelType);
    assert.deepEqual(parsed.model?.scenarios.base.drivers, drivers);
    assert.deepEqual(parsed.model?.references?.[0]?.drivers, drivers);
  }
});

for (const drivers of examples) {
  for (const location of ["bear", "base", "bull", "reference"] as const) {
    test(`valuation reader rejects incomplete or mistyped ${drivers.modelType} drivers in ${location}`, () => {
      for (const field of Object.keys(drivers)) {
        const missing: Record<string, unknown> = { ...drivers };
        delete missing[field];
        assert.equal(readValuationPublication(withDrivers(missing, location), "ACME"), null, `missing ${field}`);
        assert.equal(readValuationPublication(withDrivers({ ...drivers, [field]: "invalid" }, location), "ACME"), null, `mistyped ${field}`);
      }
    });
  }
}

test("valuation reader preserves and validates optional FCFF path and terminal margin fields", () => {
  const basic = examples[0]!;
  assert.equal(basic.modelType, "fcff");
  const drivers = { ...basic, path: { ...basic.path, normalization: [0], buildCapex: [5] }, terminalOperatingMargin: 0.25 };
  const parsed = readValuationPublication(publication(drivers), "ACME");
  assert.ok(parsed);
  assert.deepEqual(parsed.model?.scenarios.base.drivers, drivers);
  assert.deepEqual(parsed.model?.references?.[0]?.drivers, drivers);
  for (const location of ["base", "reference"] as const) {
    for (const field of Object.keys(drivers.path)) {
      assert.equal(readValuationPublication(withDrivers({ ...drivers, path: { ...drivers.path, [field]: ["invalid"] } }, location), "ACME"), null, field);
    }
    assert.equal(readValuationPublication(withDrivers({ ...drivers, terminalOperatingMargin: "invalid" }, location), "ACME"), null);
    assert.equal(readValuationPublication(withDrivers({ ...drivers, terminalOperatingMargin: Infinity }, location), "ACME"), null);
  }
});

test("valuation reader validates numeric array elements and nested asset fields", () => {
  for (const drivers of examples) {
    for (const [field, value] of Object.entries(drivers)) {
      if (Array.isArray(value) && field !== "assets") {
        assert.equal(readValuationPublication(withDrivers({ ...drivers, [field]: ["invalid"] }, "base"), "ACME"), null, `${drivers.modelType}.${field}`);
      }
    }
  }
  const drivers = examples.find(d => d.modelType === "asset_nav")!;
  for (const field of ["units", "price", "costBasis", "taxRate"]) {
    const asset: Record<string, unknown> = { ...drivers.assets[0] };
    delete asset[field];
    assert.equal(readValuationPublication(withDrivers({ ...drivers, assets: [asset] }, "base"), "ACME"), null, `asset.${field}`);
    assert.equal(readValuationPublication(withDrivers({ ...drivers, assets: [{ ...drivers.assets[0], [field]: "invalid" }] }, "reference"), "ACME"), null, `asset.${field}`);
  }
});
