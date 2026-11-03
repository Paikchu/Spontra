import assert from "node:assert/strict";
import { test } from "node:test";
import type { PeersPublication } from "../../../shared/analysis-contract/peers.ts";
import type { BalanceSheet } from "../../../shared/analysis-contract/capital-structure.ts";
import { readCapitalStructure } from "../../../shared/analysis-runtime/financial-data/capital-structure.ts";
import type { FindingData } from "../../../shared/analysis-runtime/findings.ts";
import { financeLeaseAmount, missingFinancingFactIds, operatingExpenseNetDebt } from "../../../shared/analysis-runtime/valuation/lease-basis.ts";
import { filingLeaseFacts } from "../src/valuation/filing-lease-facts.ts";
import { buildFacts, buildPeerFundamentals, leaseFactsOf } from "../src/valuation/input.ts";
import fixture from "./fixtures/orcl-lease-disclosure-20260831.json" with { type: "json" };

const query = { ticker: "ORCL", periodEnd: "2026-08-31", currency: "USD", researchAsOf: "2026-09-14T20:00:00Z" };
const concept = (name: string) => name.split(":").at(-1);
const data = (balanceSheet: BalanceSheet): FindingData => ({ quarters: [], capital: { schemaVersion: "capital-structure.v1", ticker: "ORCL", quarters: [{ periodEnd: query.periodEnd, balanceSheet, cashFlow: null, yearToDate: null }] }, fundamentals: null, guidance: null, history: null });
// The JSON contains exact facts from the production R2 inventory and the same filing's partial balance-sheet projection.
const capital = readCapitalStructure({ schemaVersion: "capital-structure.v1", ticker: "ORCL", quarters: [{ periodEnd: query.periodEnd, balanceSheet: fixture.balanceSheet, cashFlow: null, yearToDate: null }] }, "ORCL");
assert.ok(capital?.quarters[0]?.balanceSheet);
const balanceSheet = capital.quarters[0].balanceSheet;

test("actual ORCL filing supplies complete finance and operating leases that the balance-sheet projection omits", () => {
  assert.equal(financeLeaseAmount(leaseFactsOf(balanceSheet)), null);
  assert.equal(leaseFactsOf(balanceSheet).some(f => f.id === "operating_leases"), false, "noncurrent alone is not a total");
  const result = filingLeaseFacts(fixture, query);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.facts.find(f => f.id === "finance_leases")?.value, 9_185_000_000);
  assert.equal(result.facts.find(f => f.id === "operating_leases")?.value, 34_621_000_000);
  assert.equal(result.facts.find(f => f.id === "leases")?.value, 43_806_000_000);
  assert.ok(result.facts.every(f => f.sourceRefs.includes("0001193125-26-389274") && f.sourceRefs.includes(fixture.source.documentUrl)));
  const built = buildFacts(data(balanceSheet), null, query.periodEnd, query.currency, result.facts);
  assert.equal(built.missing.includes("finance_leases"), false);
  assert.equal(operatingExpenseNetDebt(built.facts), 102_823_000_000);
  assert.equal(built.facts.find(f => f.id === "net_debt")?.value, 102_823_000_000);
  assert.equal(built.facts.find(f => f.id === "invested_capital")?.value, 164_641_000_000);
  assert.match(built.facts.find(f => f.id === "net_debt")!.formula!, /finance_leases/);
});

test("a total is read once despite repeated tags; current and noncurrent are summed only when both exist in one filing", () => {
  const componentsOnly = structuredClone(fixture);
  componentsOnly.facts = componentsOnly.facts.filter(f => !["FinanceLeaseLiability", "OperatingLeaseLiability"].includes(concept(f.concept.name)!));
  const result = filingLeaseFacts(componentsOnly, query);
  const finance = result.facts.find(f => f.id === "finance_leases")!;
  assert.equal(finance.value, 749_000_000 + 8_436_000_000);
  assert.equal(finance.basis, "derived"); assert.match(finance.formula!, /Current \+ FinanceLeaseLiabilityNoncurrent/);
  const incomplete = structuredClone(componentsOnly);
  incomplete.facts = incomplete.facts.filter(f => concept(f.concept.name) !== "FinanceLeaseLiabilityNoncurrent");
  const missing = filingLeaseFacts(incomplete, query);
  assert.equal(financeLeaseAmount(missing.facts), null);
  assert.equal(missing.facts.some(f => f.id === "leases"), false);
  assert.ok(missing.unresolved.some(s => s.startsWith("finance_leases:")));
});

test("filing facts honor the research cutoff, issuer, currency, exact period and consolidated context", () => {
  assert.deepEqual(filingLeaseFacts(fixture, { ...query, researchAsOf: "2026-09-10T23:59:59Z" }).facts, []);
  assert.deepEqual(filingLeaseFacts(fixture, { ...query, researchAsOf: "2026-09-11T12:00:00Z" }).facts, [], "a date-only filing date does not prove midday availability");
  assert.equal(filingLeaseFacts(fixture, { ...query, researchAsOf: "2026-09-11T21:00:00Z", archivedAt: "2026-09-11T20:30:00Z" }).facts.length, 3);
  assert.deepEqual(filingLeaseFacts(fixture, { ...query, periodEnd: "2026-07-31" }).facts, []);
  assert.deepEqual(filingLeaseFacts(fixture, { ...query, ticker: "OTHER" }).facts, []);
  assert.deepEqual(filingLeaseFacts(fixture, { ...query, currency: "EUR" }).facts, []);
  const foreign = structuredClone(fixture);
  for (const f of foreign.facts) if (f.context?.entity) f.context.entity.identifier = "0000000001";
  assert.deepEqual(filingLeaseFacts(foreign, query).facts, []);
  const dimensional = structuredClone(fixture);
  for (const f of dimensional.facts) if (f.context) Object.assign(f.context, { dimensions: [{ kind: "explicit", value: "segment" }] });
  assert.deepEqual(filingLeaseFacts(dimensional, query).facts, []);
  const mixed = structuredClone(fixture);
  for (const f of mixed.facts) if (concept(f.concept.name) === "FinanceLeaseLiabilityNoncurrent" || concept(f.concept.name) === "FinanceLeaseLiability") f.source.accessionNumber = "another-filing";
  assert.equal(financeLeaseAmount(filingLeaseFacts(mixed, query).facts), null);
});

test("conflicting lease totals remain a source failure rather than selecting an attractive amount", () => {
  const bad = structuredClone(fixture);
  for (const f of bad.facts) if (concept(f.concept.name) === "FinanceLeaseLiability") f.numericValue = "10000000000";
  assert.throws(() => filingLeaseFacts(bad, query), /finance_leases total conflicts/);
  const duplicates = structuredClone(fixture);
  const total = duplicates.facts.find(f => concept(f.concept.name) === "FinanceLeaseLiability" && f.context?.period.end === query.periodEnd)!;
  total.numericValue = "10000000000";
  assert.throws(() => filingLeaseFacts(duplicates, query), /Conflicting or invalid finance_leases/);
});

test("financing errors name only the missing input IDs and preserve unresolved debt overlap", () => {
  assert.deepEqual(missingFinancingFactIds([{ id: "debt", value: 100 }, { id: "cash", value: 10 }]), ["finance_leases"]);
  assert.deepEqual(missingFinancingFactIds([{ id: "finance_leases", value: 5 }]), ["debt", "cash"]);
  assert.deepEqual(missingFinancingFactIds([{ id: "debt", value: 100 }, { id: "cash", value: 10 }, { id: "finance_leases", value: 5 }, { id: "finance_lease_debt_overlap", value: 1 }]), ["finance_lease_debt_overlap"]);
  const overlap = structuredClone(balanceSheet); overlap.liabilities.find(l => l.group === "debt")!.concept = "LongTermDebtAndFinanceLeaseObligations";
  const result = buildFacts(data(overlap), null, query.periodEnd, query.currency, filingLeaseFacts(fixture, query).facts);
  assert.equal(operatingExpenseNetDebt(result.facts), null, "supplementing finance leases cannot silently remove the overlap marker");
});


test("peer inputs use the same archived lease supplement and isolate an unavailable peer source", async () => {
  const periods = ["2026-08-31", "2026-05-31", "2026-02-28", "2025-11-30"];
  // Operating metrics are synthetic here; the financing bridge uses the actual ORCL source fixture.
  const projection: PeersPublication = { schemaVersion: "peers.v1", generatedAt: "2026-11-03", companies: ["SUBJ", "ORCL", "GAP"].map(ticker => ({ ticker, categories: ["test"], newestQuarter: periods[0]!, quarters: periods.map(periodEnd => ({ periodEnd, accessions: [], figures: { operatingIncome: "100", depreciation: "20", debt: "125337000000", cash: "37077000000" } })) })) };
  const db: D1Database = { prepare() { throw new Error("Unexpected query"); }, batch() { throw new Error("Unexpected query"); }, exec() { throw new Error("Unexpected query"); }, dump() { throw new Error("Unexpected query"); }, withSession() { throw new Error("Unexpected query"); } };
  const result = await buildPeerFundamentals(db, "SUBJ", projection, ["ORCL", "GAP"], async () => 100, async () => balanceSheet, async ticker => {
    if (ticker === "GAP") throw new Error("missing archived inventory");
    return filingLeaseFacts(fixture, query).facts;
  });
  assert.deepEqual(result.peers.map(p => p.ticker), ["ORCL"]);
  assert.equal(result.peers[0]!.netDebt, 102_823_000_000);
  assert.ok(result.notes.some(n => n.startsWith("GAP: archived lease disclosure unavailable")));
});
