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
    item("debt", "有息债务", "debt", split(L, "debt").all),
    item("leases", "租赁负债", "lease", split(L, "leases").all),
    item("customer", "客户预付", "customer", split(L, "customerAdvances").all),
    item("payables", "应付与应计", "payable", split(L, "payables").all),
    item("liabilities-other", "其他负债", "other", split(L, ["deferredTax", "other"]).all),
    item("paid-in", "股东投入", "equity", positiveEquity.filter(l => l.group === "paidIn")),
    item("retained", "留存收益", "own", positiveEquity.filter(l => l.group === "retained")),
    item("equity-other", "其他权益", "equity", positiveEquity.filter(l => !["paidIn", "retained"].includes(l.group))),
  ]);
  const uses = present([
    item("productive", "物业与设备", "productive", split(A, "productive").all),
    item("lease-assets", "租赁使用权资产", "productive", split(A, "leaseAssets").all),
    item("cash", "现金与短期投资", "cash", split(A, "cash").all),
    item("receivables", "应收账款", "other", split(A, "receivables").all),
    item("inventory", "存货", "other", split(A, "inventory").all),
    item("intangibles", "商誉与无形资产", "other", split(A, "intangibles").all),
    item("investments", "长期投资", "invest", split(A, "investments").all),
    item("assets-other", "其他资产", "other", split(A, "other").all),
    item("deficit", "累计亏损", "deficit", negativeEquity.filter(l => l.group === "retained")),
    item("returned", "库存股", "returned", negativeEquity.filter(l => l.group === "paidIn")),
    item("equity-loss", "其他权益损失", "other", negativeEquity.filter(l => !["paidIn", "retained"].includes(l.group))),
  ]);
  return { title: "累计资金", total: sum(sources), sources, uses };
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
  if (rest.length) (net > 0 ? sources : uses).push(item(key + "-other", net > 0 ? `其他${label}流入` : `其他${label}支出`, "other", rest, net));
  return { sources, uses };
}

/** One period's cash: what came in and where it went, with the change in cash closing the pool. */
export function cashPool(c: CashFlowStatement): Pool {
  const operating = Number(c.operating.total), change = Number(c.netChange), fx = Number(c.fxEffect ?? 0);
  const investing = sectionItems(c.investing, "investing", "投资", [
    ["capex", "出售设备", "capex", "invest", "资本开支", "productive"],
    ["acquisitions", "出售业务", "acquisitions", "invest", "收购", "invest"],
    ["investments", "投资回收", "investments", "invest", "金融与战略投资", "invest"],
  ]);
  const financing = sectionItems(c.financing, "financing", "融资", [
    ["debtIssued", "新增借款", "debt-issued", "debt", "偿还借款", "debt"],
    ["debtRepaid", "新增借款", "debt-repaid", "debt", "偿还借款", "debt"],
    ["equityIssued", "发行股票", "equity", "equity", "股票相关支出", "returned"],
    ["buybacks", "股票回购流入", "buybacks", "equity", "股票回购", "returned"],
    ["dividends", "分红流入", "dividends", "equity", "分红", "returned"],
    ["leasePrincipal", "租赁融资流入", "lease", "lease", "融资租赁还款", "lease"],
  ]);
  const sources = present([
    operating > 0 ? item("operating", "经营现金流", "own", [], operating) : null,
    ...financing.sources, ...investing.sources,
    fx > 0 ? item("fx", "汇率影响", "other", [], fx) : null,
    change < 0 ? item("cash-used", "动用现金储备", "cash", [], change) : null,
  ]);
  const uses = present([
    operating < 0 ? item("operating-burn", "经营现金消耗", "deficit", [], operating) : null,
    ...investing.uses, ...financing.uses,
    fx < 0 ? item("fx-out", "汇率影响", "other", [], fx) : null,
    change > 0 ? item("cash-added", "现金增加", "cash", [], change) : null,
  ]);
  return { title: "本期资金", total: sum(sources), sources, uses };
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

export type FundingKind = "survival" | "expansion" | "self";
const share = (part: number, whole: number) => `${Math.round(part / whole * 100)}%`;

/**
 * One factual sentence on how the period was funded, from reported totals and reconciled lines only.
 * Operating cash below zero means the business consumed cash; above zero but short of capital spending
 * means outside money paid for expansion; otherwise operations funded it.
 */
export function fundingVerdict(c: CashFlowStatement, b: BalanceSheet | null, money: (v: number) => string): { kind: FundingKind; label: string; text: string } {
  const m = cashMetrics(c);
  const outside = [
    m.debtNet != null && m.debtNet > 0 ? `净借款 ${money(m.debtNet)}` : null,
    m.equityIssued != null && m.equityIssued > 0 ? `发股 ${money(m.equityIssued)}` : null,
  ].filter(Boolean).join("、");
  if (m.operating < 0) {
    const cash = b ? sum(b.assets.filter(l => l.group === "cash")) : null;
    // Runway is stated only for a single quarter's burn; a cumulative period would understate the pace.
    const quarters = cash != null && daysOf(c) <= 110 ? cash / -m.operating : null;
    return { kind: "survival", label: "经营耗现金", text: `经营现金流 ${money(m.operating)}，业务本身在消耗现金${m.financing > 0 ? `；本期外部融资 ${money(m.financing)}${outside ? `（${outside}）` : ""}` : ""}${quarters != null && Number.isFinite(quarters) ? `。期末现金与短期投资按本季消耗速度约可支撑 ${quarters.toFixed(1)} 个季度` : ""}。` };
  }
  if (m.capex != null && m.capex > m.operating) {
    return { kind: "expansion", label: "扩张靠外部资金", text: `经营现金流 ${money(m.operating)}，只覆盖资本开支 ${money(m.capex)} 的 ${share(m.operating, m.capex)}${m.financing > 0 ? `；缺口由外部融资 ${money(m.financing)}${outside ? `（${outside}）` : ""}补足` : "；缺口动用现金储备"}。` };
  }
  return { kind: "self", label: "经营自给", text: `经营现金流 ${money(m.operating)}${m.capex != null ? `覆盖资本开支 ${money(m.capex)}，自由现金流 ${money(m.free!)}` : ""}${m.financing < 0 ? `；向债权人和股东净回流 ${money(-m.financing)}` : ""}。` };
}
const daysOf = (c: CashFlowStatement) => (Date.parse(c.periodEnd) - Date.parse(c.periodStart)) / 86400000;

export type BalanceMetrics = { assets: number; debt: number; leases: number; customer: number; equity: number; paidIn: number; deficit: number; leverage: number };
export function balanceMetrics(b: BalanceSheet): BalanceMetrics {
  const group = (lines: CapitalLine<string>[], g: string) => sum(lines.filter(l => l.group === g));
  const assets = Number(b.totals.assets), debt = group(b.liabilities, "debt"), leases = group(b.liabilities, "leases");
  const paidIn = sum(b.equity.filter(l => l.group === "paidIn" && Number(l.value) > 0));
  const retained = group(b.equity, "retained");
  return { assets, debt, leases, customer: group(b.liabilities, "customerAdvances"), equity: Number(b.totals.equity), paidIn, deficit: retained < 0 ? -retained : 0, leverage: assets ? (debt + leases) / assets : 0 };
}

export function balanceVerdict(b: BalanceSheet): string {
  const m = balanceMetrics(b), pct = (v: number) => `${Math.round(v * 100)}%`;
  const parts = [`资产的 ${pct(m.leverage)} 由借款和租赁支撑`, `股东权益占 ${pct(m.equity / m.assets)}`];
  if (m.customer > 0 && m.customer / m.assets >= 0.05) parts.push(`客户预付占 ${pct(m.customer / m.assets)}`);
  if (m.deficit > 0 && m.paidIn > 0) parts.push(`累计亏损已消耗股东投入的 ${pct(m.deficit / m.paidIn)}`);
  return parts.join("；") + "。";
}
