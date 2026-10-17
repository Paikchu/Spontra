import type { BalanceSheet, CapitalLine, CashFlowSection, CashFlowStatement } from "@/shared/analysis-contract/capital-structure";
import { messages } from "@/packages/web/src/i18n";

const m = messages({
  debt: "Debt", leases: "Lease liabilities", customer: "Customer prepayments", payables: "Payables and accruals", liabilitiesOther: "Other liabilities",
  paidIn: "Paid-in capital", retained: "Retained earnings", equityOther: "Other equity", productive: "Property and equipment", leaseAssets: "Right-of-use lease assets",
  cash: "Cash and short-term investments", receivables: "Accounts receivable", inventory: "Inventory", intangibles: "Goodwill and intangibles",
  investments: "Long-term investments", assetsOther: "Other assets", deficit: "Accumulated deficit", treasury: "Treasury stock", equityLoss: "Other equity losses",
  cumulative: "Cumulative funding", period: "Funding this period", investing: "Investing", financing: "Financing",
  otherInvestingIn: "Other investing inflows", otherInvestingOut: "Other investing outflows", otherFinancingIn: "Other financing inflows", otherFinancingOut: "Other financing outflows",
  equipmentSales: "Equipment sales", capex: "Capital expenditures", businessSales: "Business sales", acquisitions: "Acquisitions",
  investmentProceeds: "Investment proceeds", investmentsOut: "Financial and strategic investments", newBorrowing: "New borrowing", debtRepayment: "Debt repayment",
  stockIssued: "Stock issued", stockPayments: "Stock-related payments", buybackIn: "Buyback inflows", buybacks: "Share buybacks", dividendIn: "Dividend inflows",
  dividends: "Dividends", leaseIn: "Lease financing inflows", leaseOut: "Finance lease payments", operating: "Operating cash flow", fx: "Exchange rate effect",
  cashUsed: "Drawn from cash reserves", burn: "Operating cash burn", cashAdded: "Cash added",
}, {
  debt: "债务", leases: "租赁负债", customer: "客户预付款", payables: "应付账款及预提费用", liabilitiesOther: "其他负债",
  paidIn: "实收资本", retained: "留存收益", equityOther: "其他权益", productive: "固定资产", leaseAssets: "使用权资产",
  cash: "现金及短期投资", receivables: "应收账款", inventory: "存货", intangibles: "商誉及无形资产",
  investments: "长期投资", assetsOther: "其他资产", deficit: "累计亏损", treasury: "库存股", equityLoss: "其他权益损失",
  cumulative: "累计资金来源", period: "本期资金来源", investing: "投资活动", financing: "筹资活动",
  otherInvestingIn: "其他投资流入", otherInvestingOut: "其他投资流出", otherFinancingIn: "其他筹资流入", otherFinancingOut: "其他筹资流出",
  equipmentSales: "设备出售", capex: "资本开支", businessSales: "业务出售", acquisitions: "收购",
  investmentProceeds: "投资收回", investmentsOut: "金融及战略投资", newBorrowing: "新增借款", debtRepayment: "偿还债务",
  stockIssued: "股权融资", stockPayments: "股票相关支出", buybackIn: "回购流入", buybacks: "回购", dividendIn: "分红流入",
  dividends: "分红", leaseIn: "租赁融资流入", leaseOut: "融资租赁付款", operating: "经营现金流", fx: "汇率影响",
  cashUsed: "动用现金储备", burn: "经营现金消耗", cashAdded: "现金增加",
});

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
    item("debt", m.debt, "debt", split(L, "debt").all),
    item("leases", m.leases, "lease", split(L, "leases").all),
    item("customer", m.customer, "customer", split(L, "customerAdvances").all),
    item("payables", m.payables, "payable", split(L, "payables").all),
    item("liabilities-other", m.liabilitiesOther, "other", split(L, ["deferredTax", "other"]).all),
    item("paid-in", m.paidIn, "equity", positiveEquity.filter(l => l.group === "paidIn")),
    item("retained", m.retained, "own", positiveEquity.filter(l => l.group === "retained")),
    item("equity-other", m.equityOther, "equity", positiveEquity.filter(l => !["paidIn", "retained"].includes(l.group))),
  ]);
  const uses = present([
    item("productive", m.productive, "productive", split(A, "productive").all),
    item("lease-assets", m.leaseAssets, "productive", split(A, "leaseAssets").all),
    item("cash", m.cash, "cash", split(A, "cash").all),
    item("receivables", m.receivables, "other", split(A, "receivables").all),
    item("inventory", m.inventory, "other", split(A, "inventory").all),
    item("intangibles", m.intangibles, "other", split(A, "intangibles").all),
    item("investments", m.investments, "invest", split(A, "investments").all),
    item("assets-other", m.assetsOther, "other", split(A, "other").all),
    item("deficit", m.deficit, "deficit", negativeEquity.filter(l => l.group === "retained")),
    item("returned", m.treasury, "returned", negativeEquity.filter(l => l.group === "paidIn")),
    item("equity-loss", m.equityLoss, "other", negativeEquity.filter(l => !["paidIn", "retained"].includes(l.group))),
  ]);
  return { title: m.cumulative, total: sum(sources), sources, uses };
}

/** A section without reconciled lines is shown as its net total, on whichever side its sign puts it. */
function sectionItems<G extends string>(section: CashFlowSection<G>, key: string, label: string, other: [string, string], groups: Array<[G | G[], string, string, PoolTone, string, PoolTone]>) {
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
  if (rest.length) (net > 0 ? sources : uses).push(item(key + "-other", net > 0 ? other[0] : other[1], "other", rest, net));
  return { sources, uses };
}

/** One period's cash: what came in and where it went, with the change in cash closing the pool. */
export function cashPool(c: CashFlowStatement): Pool {
  const operating = Number(c.operating.total), change = Number(c.netChange), fx = Number(c.fxEffect ?? 0);
  const investing = sectionItems(c.investing, "investing", m.investing, [m.otherInvestingIn, m.otherInvestingOut], [
    ["capex", m.equipmentSales, "capex", "invest", m.capex, "productive"],
    ["acquisitions", m.businessSales, "acquisitions", "invest", m.acquisitions, "invest"],
    ["investments", m.investmentProceeds, "investments", "invest", m.investmentsOut, "invest"],
  ]);
  const financing = sectionItems(c.financing, "financing", m.financing, [m.otherFinancingIn, m.otherFinancingOut], [
    ["debtIssued", m.newBorrowing, "debt-issued", "debt", m.debtRepayment, "debt"],
    ["debtRepaid", m.newBorrowing, "debt-repaid", "debt", m.debtRepayment, "debt"],
    ["equityIssued", m.stockIssued, "equity", "equity", m.stockPayments, "returned"],
    ["buybacks", m.buybackIn, "buybacks", "equity", m.buybacks, "returned"],
    ["dividends", m.dividendIn, "dividends", "equity", m.dividends, "returned"],
    ["leasePrincipal", m.leaseIn, "lease", "lease", m.leaseOut, "lease"],
  ]);
  const sources = present([
    operating > 0 ? item("operating", m.operating, "own", [], operating) : null,
    ...financing.sources, ...investing.sources,
    fx > 0 ? item("fx", m.fx, "other", [], fx) : null,
    change < 0 ? item("cash-used", m.cashUsed, "cash", [], change) : null,
  ]);
  const uses = present([
    operating < 0 ? item("operating-burn", m.burn, "deficit", [], operating) : null,
    ...investing.uses, ...financing.uses,
    fx < 0 ? item("fx-out", m.fx, "other", [], fx) : null,
    change > 0 ? item("cash-added", m.cashAdded, "cash", [], change) : null,
  ]);
  return { title: m.period, total: sum(sources), sources, uses };
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
