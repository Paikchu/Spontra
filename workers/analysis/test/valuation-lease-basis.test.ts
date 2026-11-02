import assert from "node:assert/strict";
import { test } from "node:test";
import type { BalanceSheet } from "../../../shared/analysis-contract/capital-structure.ts";
import type { PeersPublication } from "../../../shared/analysis-contract/peers.ts";
import type { CalcRequest } from "../../../shared/analysis-runtime/valuation/calculator.ts";
import { calculateValuation, verifyCitedInputs } from "../../../shared/analysis-runtime/valuation/calculator.ts";
import { financeLeaseAmount, operatingExpenseNetDebt } from "../../../shared/analysis-runtime/valuation/lease-basis.ts";
import { priorRequest } from "../../../shared/analysis-runtime/valuation/prior.ts";
import type { FindingData } from "../../../shared/analysis-runtime/findings.ts";
import { buildFacts, buildPeerFundamentals, leaseFactsOf } from "../src/valuation/input.ts";

const sheet = (): BalanceSheet => ({ asOf: "2026-09-30", currency: "USD", source: { accession: "accession", url: "https://example.test/filing", filedAt: "2026-10-15", form: "10-Q" },
  assets: [{ id: "cash", concept: "CashAndCashEquivalents", label: "Cash", group: "cash", value: "10" }, { id: "investments", concept: "LongTermInvestments", label: "Investments", group: "investments", value: "4" }],
  liabilities: [{ id: "debt", concept: "LongTermDebt", label: "Debt", group: "debt", value: "100" }, { id: "op-current", concept: "OperatingLeaseLiabilityCurrent", label: "Current operating leases", group: "leases", value: "5" }, { id: "op-long", concept: "OperatingLeaseLiabilityNoncurrent", label: "Noncurrent operating leases", group: "leases", value: "20" }, { id: "fin-current", concept: "FinanceLeaseLiabilityCurrent", label: "Current finance leases", group: "leases", value: "1" }, { id: "fin-long", concept: "FinanceLeaseLiabilityNoncurrent", label: "Noncurrent finance leases", group: "leases", value: "4" }],
  equity: [{ id: "preferred", concept: "PreferredStockValue", label: "Preferred", group: "paidIn", value: "2" }, { id: "minority", concept: "NoncontrollingInterest", label: "Noncontrolling", group: "noncontrolling", value: "1" }], totals: { assets: "200", liabilities: "130", equity: "70", currentAssets: null, currentLiabilities: null } });
const finding = (balanceSheet: BalanceSheet): FindingData => ({ quarters: [], capital: { schemaVersion: "capital-structure.v1", ticker: "TST", quarters: [{ periodEnd: "2026-09-30", balanceSheet, cashFlow: null, yearToDate: null }] }, fundamentals: null, guidance: null, history: null });
const facts = () => [{ id: "revenue_ttm", value: 1000, unit: "USD" }, { id: "shares_outstanding", value: 100, unit: "shares" }, { id: "debt", value: 100, unit: "USD" }, { id: "leases", value: 30, unit: "USD" }, { id: "finance_leases", value: 5, unit: "USD" }, { id: "operating_leases", value: 25, unit: "USD" }, { id: "preferred_stock", value: 2, unit: "USD" }, { id: "minority_interest", value: 1, unit: "USD" }, { id: "cash", value: 10, unit: "USD" }, { id: "investments", value: 4, unit: "USD" }];
const request = (): CalcRequest => { const scenario = { narrative: "Synthetic stable operations.", probability: null, triggers: [], invalidation: [], evidenceIds: ["source"], drivers: { modelType: "fcff" as const, revenue0: 1000, path: { revenueGrowth: Array(5).fill(0.05), operatingMargin: Array(5).fill(0.25), taxRate: Array(5).fill(0.2), salesToCapital: Array(5).fill(2) }, terminalGrowth: 0.02, terminalRoic: 0.15 } }; return { modelType: "fcff", currency: "USD", discountRate: { value: 0.1, basis: "wacc", components: { riskFree: 0.04, beta: 1, equityRiskPremium: 0.06, costOfEquity: 0.1, costOfDebt: 0.05, taxRate: 0.2, equityWeight: 0.9 }, rationale: "Synthetic components.", sourceRefs: [] }, shares: { base: 100, dilutionReserve: 0, basis: "shares_outstanding" }, bridge: { leaseTreatment: "operating_expense", debtAndClaims: 108, nonOperatingAssets: 14, nonOperatingEquityAdjustment: 0, notes: ["Rent stays in operating earnings."] }, price: 30, scenarios: { bear: scenario, base: scenario, bull: scenario }, context: { facts: facts(), riskFree: 0.04, methodWeights: { dcf: 1, ev_ebitda_forward: 0, pe_forward: 0 } } }; };

// All amounts below are synthetic, chosen to separate operating and financing leases.
test("lease facts split current/noncurrent liabilities with sources; unknown rows never become zero finance leases", () => {
  const split = leaseFactsOf(sheet());
  assert.equal(split.find(f => f.id === "operating_leases")?.value, 25);
  assert.equal(split.find(f => f.id === "finance_leases")?.value, 5);
  assert.ok(split.every(f => f.sourceRefs.includes("accession")));
  const unknown = sheet(); unknown.liabilities.push({ id: "unknown", concept: "LeaseLiabilities", label: "Other lease liabilities", group: "leases", value: "10" });
  assert.equal(financeLeaseAmount(leaseFactsOf(unknown)), null);
  assert.equal(financeLeaseAmount(leaseFactsOf(null)), null);
  const noLeaseRows = sheet(); noLeaseRows.liabilities = noLeaseRows.liabilities.filter(l => l.group !== "leases");
  assert.equal(financeLeaseAmount(leaseFactsOf(noLeaseRows)), null);
  const allOperating = sheet(); allOperating.liabilities = allOperating.liabilities.filter(l => !l.id.startsWith("fin"));
  assert.equal(financeLeaseAmount(leaseFactsOf(allOperating)), null, "absence of finance rows is not evidence of zero");
  allOperating.liabilities.push({ id: "zero", concept: "FinanceLeaseLiability", label: "Finance leases", group: "leases", value: "0" });
  assert.equal(financeLeaseAmount(leaseFactsOf(allOperating)), 0, "a disclosed zero is usable");
  assert.equal(financeLeaseAmount([{ id: "leases", value: 0 }]), 0);
});

test("new bridges deduct finance leases only and reject double counting operating leases; legacy bridge checks stay unchanged", () => {
  const r = request(); assert.ok(verifyCitedInputs(r, facts()).ok);
  assert.equal(operatingExpenseNetDebt(facts()), 94);
  r.bridge.debtAndClaims = 133;
  assert.equal(verifyCitedInputs(r, facts()).ok, false, "the operating leases cannot be added as a conservative extra deduction");
  delete r.bridge.leaseTreatment;
  assert.equal(verifyCitedInputs(r, facts()).ok, true, "legacy debt + total leases remains readable and reproducible");
  const overlap = sheet(); overlap.liabilities[0]!.concept = "LongTermDebtAndFinanceLeaseObligations";
  assert.equal(operatingExpenseNetDebt([...facts(), ...leaseFactsOf(overlap)]), null);
});

test("the live material pack and peer EV use the same financing-lease and nonoperating-asset basis", async () => {
  const built = buildFacts(finding(sheet()), null, "2026-09-30", "USD");
  assert.equal(built.facts.find(f => f.id === "finance_leases")?.value, 5);
  assert.equal(built.facts.find(f => f.id === "net_debt")?.value, 94);
  assert.equal(built.facts.find(f => f.id === "invested_capital")?.value, 161);
  const periods = ["2026-09-30", "2026-06-30", "2026-03-31", "2025-12-31"];
  const projection: PeersPublication = { schemaVersion: "peers.v1", generatedAt: "2026-10-20", companies: ["TST", "P1", "P2"].map(ticker => ({ ticker, categories: ["test"], newestQuarter: periods[0]!, quarters: periods.map(periodEnd => ({ periodEnd, accessions: ["accession"], figures: { operatingIncome: "100", depreciation: "20", debt: "100", cash: "10", leases: "30" } })) })) };
  const db: D1Database = { prepare() { throw new Error("Unexpected query"); }, batch() { throw new Error("Unexpected query"); }, exec() { throw new Error("Unexpected query"); }, dump() { throw new Error("Unexpected query"); }, withSession() { throw new Error("Unexpected query"); } };
  const peers = await buildPeerFundamentals(db, "TST", projection, ["P1", "P2"], async () => 100, async () => sheet());
  assert.deepEqual(peers.peers.map(p => p.netDebt), [94, 94]);
  const unavailable = await buildPeerFundamentals(db, "TST", projection, ["P1", "P2"], async () => 100, async () => null);
  assert.deepEqual(unavailable.peers, []); assert.ok(unavailable.notes.some(n => n.includes("lease classification")));
});

test("missing lease classification keeps the normal range unavailable and stops a new prior instead of assuming zero", () => {
  const r = request(); r.context!.facts = facts().filter(f => f.id !== "finance_leases");
  const assumptions = { revenue: { rationale: "Synthetic evidence.", evidenceIds: ["source"] }, margin: { rationale: "Synthetic evidence.", evidenceIds: ["source"] }, capex: { rationale: "Synthetic evidence.", evidenceIds: ["source"] } };
  r.fairValueBasis = { status: "available", kind: "normal_cases", lower: { ...r.scenarios.base, assumptions }, upper: { ...r.scenarios.base, assumptions }, rationale: "The operating bounds are evidenced but financing claims remain unresolved.", evidenceIds: ["source"] };
  assert.throws(() => calculateValuation(r), /unresolved inputs: finance_leases/);
  r.fairValueBasis = { status: "unavailable", reason: "Finance lease classification has not been resolved.", evidenceIds: [] };
  const incomplete = calculateValuation(r);
  assert.ok(incomplete.gates?.some(g => g.key === "lease_classification" && g.status === "flag"));
  const distribution = (factor: string) => ({ factor, periods: [{ periodEnd: "2025-09-30", value: 0.05 }, { periodEnd: "2024-09-30", value: 0.1 }, { periodEnd: "2023-09-30", value: 0.15 }], min: 0.05, p25: 0.075, median: 0.1, p75: 0.125, max: 0.15 });
  const input = { currency: "USD", facts: facts(), distributions: [distribution("revenueGrowth"), distribution("operatingMargin")], diagnostics: [], rpo: null, riskFree: 0.04, beta: 1, price: 30 };
  const prior = priorRequest(input)!;
  assert.equal(prior.bridge.leaseTreatment, "operating_expense"); assert.equal(prior.bridge.debtAndClaims, 108); assert.equal(prior.bridge.nonOperatingAssets, 14);
  assert.equal(priorRequest({ ...input, facts: input.facts.filter(f => f.id !== "finance_leases") }), null);
});
