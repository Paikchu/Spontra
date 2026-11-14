import type { BalanceSheet, CapitalLine } from "../../analysis-contract/capital-structure.ts";
import type { ValuationFact } from "../../analysis-contract/valuation.ts";

type Fact = { id: string; value: number };
const valueOf = (facts: readonly Fact[], id: string) => facts.find(f => f.id === id)?.value ?? null;

export const NET_DEBT_LABEL = ["Net debt excluding operating leases", "净债务（不含经营租赁）"] satisfies [string, string];
export const NET_DEBT_FORMULA = "debt + finance leases + preferred stock + minority interests + other senior claims − cash − investments; operating leases excluded";

/** Financing inputs from one reconciled balance sheet, shared by findings and valuation. */
export function balanceSheetFinancingFacts(sheet: BalanceSheet | null): ValuationFact[] {
  if (!sheet) return [];
  const fact = (id: string, label: string, value: number, lines: CapitalLine<string>[], basis: ValuationFact["basis"] = "derived", rationale: string | null = null): ValuationFact => ({ id, label, value, unit: sheet.currency, currency: sheet.currency, periodType: "instant", periodStart: null, periodEnd: sheet.asOf, basis, formula: `sum(${lines.map(l => l.concept).join(", ")})`, sourceRefs: [...lines.map(l => l.concept), sheet.source.accession], rationale });
  const groupFact = (id: string, label: string, lines: CapitalLine<string>[]) => fact(id, label, lines.reduce((sum, l) => sum + Number(l.value), 0), lines, "reported");
  const rows = sheet.liabilities.filter(l => l.group === "leases");
  const out = [
    groupFact("debt", "Debt, newest balance sheet", sheet.liabilities.filter(l => l.group === "debt")),
    groupFact("cash", "Cash and equivalents, newest balance sheet", sheet.assets.filter(l => l.group === "cash")),
    groupFact("investments", "Investments, newest balance sheet", sheet.assets.filter(l => l.group === "investments")),
    groupFact("leases", "Total operating and finance lease liabilities", rows),
  ];
  const classified = rows.map(l => {
    const text = `${l.concept} ${l.label}`;
    const kind = /Debt.*(?:Finance|Capital)Lease|debt.*(?:finance|capital) lease/i.test(text) ? null : /OperatingLease|operating lease/i.test(text) ? "operating" : /FinanceLease|CapitalLease|financ(?:e|ing) lease|capital lease/i.test(text) ? "finance" : null;
    return { line: l, kind, value: Number(l.value) };
  });
  if (classified.length && classified.every(l => l.kind && Number.isFinite(l.value))) {
    for (const kind of ["operating", "finance"] as const) {
      const matching = classified.filter(l => l.kind === kind);
      const totals = matching.filter(l => /(?:Operating|Finance)LeaseLiability$|CapitalLeaseObligations?$/i.test(l.line.concept.split(":").at(-1)!));
      const current = matching.filter(l => /Current$/i.test(l.line.concept) && !/Noncurrent$/i.test(l.line.concept));
      const noncurrent = matching.filter(l => /Noncurrent$/i.test(l.line.concept));
      const complete = totals.length ? totals : current.length && noncurrent.length ? [...current, ...noncurrent] : [];
      if (complete.length) out.push(fact(`${kind}_leases`, `${kind === "operating" ? "Operating" : "Finance"} lease liabilities, newest balance sheet`, complete.reduce((sum, l) => sum + l.value, 0), complete.map(l => l.line)));
    }
  }
  const overlap = sheet.liabilities.filter(l => l.group === "debt" && /Debt.*(?:Finance|Capital)Lease|debt.*(?:finance|capital) lease/i.test(`${l.concept} ${l.label}`));
  if (overlap.length) out.push({ ...fact("finance_lease_debt_overlap", "Debt may already include finance leases", 1, overlap, "derived", "The debt rows combine debt and finance leases; their overlapping amount must be reconciled before adding finance leases."), unit: "ratio", currency: null });
  const senior = (id: string, label: string, test: RegExp) => {
    const lines = sheet.equity.filter(l => test.test(l.concept) || test.test(l.id));
    const value = lines.reduce((sum, l) => sum + Number(l.value), 0);
    if (lines.length && value > 0) out.push(fact(id, label, value, lines, "reported"));
  };
  senior("preferred_stock", "Preferred stock, newest balance sheet", /Preferred/i);
  senior("minority_interest", "Noncontrolling interests, newest balance sheet", /MinorityInterest|Noncontrolling/i);
  return out;
}

/** Zero requires a disclosed zero total; absent classification is not zero finance leases. */
export function financeLeaseAmount(facts: readonly Fact[]): number | null {
  return valueOf(facts, "finance_leases") ?? (valueOf(facts, "leases") === 0 ? 0 : null);
}

/** Exact missing or unreconciled inputs for an operating-expense financing bridge. */
export function missingFinancingFactIds(facts: readonly Fact[]): string[] {
  return [...["debt", "cash"].filter(id => valueOf(facts, id) == null), ...(financeLeaseAmount(facts) == null ? ["finance_leases"] : []), ...(valueOf(facts, "finance_lease_debt_overlap") === 1 ? ["finance_lease_debt_overlap"] : [])];
}

/** Operating rent stays in operating earnings; only financing leases join debt and other senior claims. */
export function operatingExpenseNetDebt(facts: readonly Fact[]): number | null {
  const debt = valueOf(facts, "debt"), cash = valueOf(facts, "cash"), finance = financeLeaseAmount(facts);
  if (debt == null || cash == null || finance == null || valueOf(facts, "finance_lease_debt_overlap") === 1) return null;
  return debt + finance + (valueOf(facts, "preferred_stock") ?? 0) + (valueOf(facts, "minority_interest") ?? 0) + (valueOf(facts, "other_senior_claims") ?? 0) - cash - (valueOf(facts, "investments") ?? 0);
}
