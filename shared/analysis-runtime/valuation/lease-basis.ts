type Fact = { id: string; value: number };
const valueOf = (facts: readonly Fact[], id: string) => facts.find(f => f.id === id)?.value ?? null;

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
