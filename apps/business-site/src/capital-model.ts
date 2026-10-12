import type { BalanceSheet, CapitalLine, CashFlowSection, CashFlowStatement } from "@/shared/analysis-contract/capital-structure";

/** What role money plays in the pool; each tone has one color across both views. */
export type PoolTone = "own" | "debt" | "lease" | "customer" | "payable" | "equity" | "deficit" | "returned" | "productive" | "cash" | "invest" | "other";
export type PoolItem = { key: string; label: string; value: number; tone: PoolTone; lines: Array<{ label: string; value: number }> };
/** Sources and uses of one pool always sum to the same total, so every band is a real amount. */
export type Pool = { title: string; total: number; sources: PoolItem[]; uses: PoolItem[] };

const sum = (lines: Array<{ value: string | number }>) => lines.reduce((total, line) => total + Number(line.value), 0);
const detail = (lines: CapitalLine<string>[]) => lines.map(line => ({ label: line.label, value: Number(line.value) }));

/** Lines of one group, split by sign: a group's positive part and negative part sit on opposite sides of the pool. */
function split<G extends string>(lines: CapitalLine<G>[], group: G | G[]) {
  const groups = Array.isArray(group) ? group : [group], picked = lines.filter(line => groups.includes(line.group));
  return { plus: picked.filter(line => Number(line.value) > 0), minus: picked.filter(line => Number(line.value) < 0), all: picked };
}

function item(key: string, label: string, tone: PoolTone, lines: CapitalLine<string>[], value = sum(lines)): PoolItem | null {
  return Math.abs(value) > 0 ? { key, label, tone, value: Math.abs(value), lines: detail(lines) } : null;
}
const present = (items: Array<PoolItem | null>) => items.filter((i): i is PoolItem => i !== null);

/**
 * Where the balance sheet's money came from and what it became. Liabilities and the capital shareholders put in
 * fund the assets; an accumulated deficit, treasury stock and other negative equity are money already spent,
 * so they sit beside the assets rather than shrinking a source.
 */
export function balancePool(b: BalanceSheet): Pool {
  const L = b.liabilities, E = b.equity, A = b.assets;
  const positiveEquity = E.filter(line => Number(line.value) > 0), negativeEquity = E.filter(line => Number(line.value) < 0);
  const sources = present([
    item("debt", "Debt", "debt", split(L, "debt").all),
    item("leases", "Lease liabilities", "lease", split(L, "leases").all),
    item("customer", "Customer prepayments", "customer", split(L, "customerAdvances").all),
    item("payables", "Payables and accruals", "payable", split(L, "payables").all),
    item("liabilities-other", "Other liabilities", "other", split(L, ["deferredTax", "other"]).all),
    item("paid-in", "Paid-in capital", "equity", positiveEquity.filter(l => l.group === "paidIn")),
    item("retained", "Retained earnings", "own", positiveEquity.filter(l => l.group === "retained")),
    item("equity-other", "Other equity", "equity", positiveEquity.filter(l => !["paidIn", "retained"].includes(l.group))),
  ]);
  const uses = present([
    item("productive", "Property and equipment", "productive", split(A, "productive").all),
    item("lease-assets", "Right-of-use lease assets", "productive", split(A, "leaseAssets").all),
    item("cash", "Cash and short-term investments", "cash", split(A, "cash").all),
    item("receivables", "Accounts receivable", "other", split(A, "receivables").all),
    item("inventory", "Inventory", "other", split(A, "inventory").all),
    item("intangibles", "Goodwill and intangibles", "other", split(A, "intangibles").all),
    item("investments", "Long-term investments", "invest", split(A, "investments").all),
    item("assets-other", "Other assets", "other", split(A, "other").all),
    item("deficit", "Accumulated deficit", "deficit", negativeEquity.filter(l => l.group === "retained")),
    item("returned", "Treasury stock", "returned", negativeEquity.filter(l => l.group === "paidIn")),
    item("equity-loss", "Other equity losses", "other", negativeEquity.filter(l => !["paidIn", "retained"].includes(l.group))),
  ]);
  return { title: "Cumulative funding", total: sum(sources), sources, uses };
}

/** A section without reconciled lines is shown as its net total, on whichever side its sign puts it. */
function sectionItems<G extends string>(section: CashFlowSection<G>, key: string, label: string, groups: Array<[G | G[], string, string, PoolTone, string, PoolTone]>) {
  const sources: Array<PoolItem | null> = [], uses: Array<PoolItem | null> = [];
  if (!section.lines) {
    const total = Number(section.total);
    (total >= 0 ? sources : uses).push(item(key, label, total >= 0 ? "other" : "invest", [], total));
    return { sources, uses };
  }
  const covered = new Set<string>();
  for (const [group, plusLabel, plusKey, plusTone, minusLabel, minusTone] of groups) {
    const parts = split(section.lines, group);
    parts.all.forEach(line => covered.add(line.id));
    // A group whose rows are all one kind (borrowing, repayment) nets to one side; mixed rows (buying and selling securities) net too.
    const net = sum(parts.all);
    if (net > 0) sources.push(item(plusKey, plusLabel, plusTone, parts.all, net));
    else uses.push(item(plusKey + "-out", minusLabel, minusTone, parts.all, net));
  }
  const rest = section.lines.filter(line => !covered.has(line.id)), net = sum(rest);
  if (rest.length) (net > 0 ? sources : uses).push(item(key + "-other", net > 0 ? `Other ${label.toLowerCase()} inflows` : `Other ${label.toLowerCase()} outflows`, "other", rest, net));
  return { sources, uses };
}

/** One period's cash: what came in and where it went, with the change in cash closing the pool. */
export function cashPool(c: CashFlowStatement): Pool {
  const operating = Number(c.operating.total), change = Number(c.netChange), fx = Number(c.fxEffect ?? 0);
  const investing = sectionItems(c.investing, "investing", "Investing", [
    ["capex", "Equipment sales", "capex", "invest", "Capital expenditures", "productive"],
    ["acquisitions", "Business sales", "acquisitions", "invest", "Acquisitions", "invest"],
    ["investments", "Investment proceeds", "investments", "invest", "Financial and strategic investments", "invest"],
  ]);
  const financing = sectionItems(c.financing, "financing", "Financing", [
    ["debtIssued", "New borrowing", "debt-issued", "debt", "Debt repayment", "debt"],
    ["debtRepaid", "New borrowing", "debt-repaid", "debt", "Debt repayment", "debt"],
    ["equityIssued", "Stock issued", "equity", "equity", "Stock-related payments", "returned"],
    ["buybacks", "Buyback inflows", "buybacks", "equity", "Share buybacks", "returned"],
    ["dividends", "Dividend inflows", "dividends", "equity", "Dividends", "returned"],
    ["leasePrincipal", "Lease financing inflows", "lease", "lease", "Finance lease payments", "lease"],
  ]);
  const sources = present([
    operating > 0 ? item("operating", "Operating cash flow", "own", [], operating) : null,
    ...financing.sources, ...investing.sources,
    fx > 0 ? item("fx", "Exchange rate effect", "other", [], fx) : null,
    change < 0 ? item("cash-used", "Drawn from cash reserves", "cash", [], change) : null,
  ]);
  const uses = present([
    operating < 0 ? item("operating-burn", "Operating cash burn", "deficit", [], operating) : null,
    ...investing.uses, ...financing.uses,
    fx < 0 ? item("fx-out", "Exchange rate effect", "other", [], fx) : null,
    change > 0 ? item("cash-added", "Cash added", "cash", [], change) : null,
  ]);
  return { title: "Funding this period", total: sum(sources), sources, uses };
}

export type CashMetrics = { operating: number; capex: number | null; free: number | null; selfFunding: number | null; financing: number; debtNet: number | null; equityIssued: number | null; returned: number | null };

export function cashMetrics(c: CashFlowStatement): CashMetrics {
  const operating = Number(c.operating.total), financing = Number(c.financing.total);
  const investingLines = c.investing.lines, financingLines = c.financing.lines;
  const capex = investingLines ? -sum(investingLines.filter(l => l.group === "capex")) : null;
  const pick = (groups: string[]) => financingLines ? sum(financingLines.filter(l => groups.includes(l.group))) : null;
  return {
    operating, financing, capex,
    free: capex == null ? null : operating - capex,
    selfFunding: capex && capex > 0 ? operating / capex : null,
    debtNet: pick(["debtIssued", "debtRepaid"]), equityIssued: pick(["equityIssued"]),
    returned: pick(["buybacks", "dividends"]),
  };
}

export type BalanceMetrics = { assets: number; debt: number; leases: number; customer: number; equity: number; paidIn: number; deficit: number; leverage: number };
export function balanceMetrics(b: BalanceSheet): BalanceMetrics {
  const group = (lines: CapitalLine<string>[], g: string) => sum(lines.filter(l => l.group === g));
  const assets = Number(b.totals.assets), debt = group(b.liabilities, "debt"), leases = group(b.liabilities, "leases");
  const paidIn = sum(b.equity.filter(l => l.group === "paidIn" && Number(l.value) > 0));
  const retained = group(b.equity, "retained");
  return { assets, debt, leases, customer: group(b.liabilities, "customerAdvances"), equity: Number(b.totals.equity), paidIn, deficit: retained < 0 ? -retained : 0, leverage: assets ? (debt + leases) / assets : 0 };
}
