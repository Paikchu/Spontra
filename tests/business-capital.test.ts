import test from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlowQuarter, FlowMetric } from "../shared/analysis-contract/business-flow";
import type { BalanceSheet, CashFlowStatement, PublicCapitalStructure } from "../shared/analysis-contract/capital-structure";
import { deficitFinancialGraph, validateGraph } from "../packages/web/src/model/business-flow-sankey";
import { layoutInfographic } from "../packages/web/src/model/business-flow-layout";
import { balancePool, balanceVerdict, cashPool, fundingVerdict } from "../apps/business-site/src/capital-model";
import { handle, loadCapital, type SiteEnv } from "../apps/business-site/worker/index";

const amount = (value: number) => ({ value: String(value), basis: "reported" as const, definition: "test", comparabilityKey: null, sourceIds: [] });
function quarter(figures: Partial<Record<FlowMetric, number>>, extra: Partial<BusinessFlowQuarter> = {}): BusinessFlowQuarter {
  return { id: "2026-06-30", incomeModel: "standard", label: "", periodStart: "2026-04-01", periodEnd: "2026-06-30", periodType: "3M", currency: "USD", scale: 1, basisLabel: "", reportedAt: null,
    figures: Object.fromEntries(Object.entries(figures).map(([k, v]) => [k, amount(v!)])), segments: [], segmentsComplete: false, sources: [], ...extra };
}
const into = (graph: NonNullable<ReturnType<typeof deficitFinancialGraph>>, target: string) => Object.fromEntries(graph.links.filter(l => l.target === target).map(l => [l.source, l.value]));

test("a loss is drawn as funding: revenue pays costs in order, the net loss enters where revenue runs out", () => {
  // CoreWeave, quarter ended 2026-06-30 ($M): operating loss 49, net interest and other 515, tax 62.
  const graph = deficitFinancialGraph(quarter({ revenue: 2575, cost: 879, gross: 1696, operatingExpenses: 1745, operating: -49, other: -515, pretax: -564, tax: 62, net: -626 }))!;
  assert.ok(graph.deficit && validateGraph(graph.nodes, graph.links));
  assert.deepEqual(into(graph, "cost"), { revenue: 879 });
  assert.deepEqual(into(graph, "operatingExpenses"), { gross: 1696, net: 49 });
  assert.deepEqual(into(graph, "other"), { net: 515 });
  assert.deepEqual(into(graph, "tax"), { net: 62 });
  assert.equal(graph.nodes.find(n => n.name === "other")!.label, "非营业净支出");
  // Four columns, not a seven-step chain of shrinking losses; costs only the deficit pays sit beside the operating costs.
  assert.deepEqual([...new Set(graph.nodes.map(n => n.depth))].sort(), [0, 1, 2]);
  const layout = layoutInfographic(graph)!, net = layout.nodes.find(n => n.name === "net")!, gross = layout.nodes.find(n => n.name === "gross")!;
  assert.equal(net.side, "bottom");
  assert.ok(net.y > gross.y + gross.h, "the deficit enters from below its column");
});

test("operating profit carries forward until interest and tax exhaust it", () => {
  const graph = deficitFinancialGraph(quarter({ revenue: 1000, cost: 400, gross: 600, operatingExpenses: 500, operating: 100, other: -150, pretax: -50, tax: 10, net: -60 }))!;
  assert.deepEqual(into(graph, "operating"), { gross: 100 });
  assert.deepEqual(into(graph, "other"), { operating: 100, net: 50 });
  assert.deepEqual(into(graph, "tax"), { net: 10 });
  const depth = (name: string) => graph.nodes.find(n => n.name === name)!.depth;
  assert.ok(depth("tax") > depth("operating") && depth("net") < depth("other"));
});

test("own credits cover a shortfall before the deficit; a gross loss is funded from the revenue column", () => {
  const credit = deficitFinancialGraph(quarter({ revenue: 1000, cost: 300, gross: 700, operatingExpenses: 900, operating: -200, other: 50, pretax: -150, tax: -10, net: -140 }))!;
  assert.deepEqual(into(credit, "operatingExpenses"), { gross: 700, other: 50, tax: 10, net: 140 });
  assert.equal(credit.nodes.find(n => n.name === "tax")!.label, "所得税收益");
  const gross = deficitFinancialGraph(quarter({ revenue: 100, cost: 130, gross: -30, operatingExpenses: 20, operating: -50, other: 0, pretax: -50, tax: 0, net: -50 }))!;
  assert.deepEqual(into(gross, "cost"), { revenue: 100, net: 30 });
  const layout = layoutInfographic(gross)!, revenue = layout.nodes.find(n => n.name === "revenue")!, net = layout.nodes.find(n => n.name === "net")!;
  assert.equal(net.column, revenue.column);
  assert.ok(net.y >= revenue.y + revenue.h);
});

test("profitable, unbalanced or financial quarters are not redrawn", () => {
  assert.equal(deficitFinancialGraph(quarter({ revenue: 100, cost: 40, gross: 60, operatingExpenses: 30, operating: 30, other: 0, pretax: 30, tax: 5, net: 25 })), null);
  assert.equal(deficitFinancialGraph(quarter({ revenue: 100, cost: 40, gross: 60, operatingExpenses: 90, operating: -30, other: 0, pretax: -30, tax: 0, net: -31 })), null);
  assert.equal(deficitFinancialGraph(quarter({ revenue: 100, operatingExpenses: 130, pretax: -30, tax: 0, net: -30 }, { incomeModel: "financial" })), null);
});

const source = { accession: "0001769628-26-000366", url: "https://www.sec.gov/Archives/edgar/data/1769628/000176962826000366/crwv-20260630.htm", filedAt: "2026-08-12", form: "10-Q" };
const line = <G extends string>(group: G, value: number, label = group as string) => ({ id: label, label, concept: "us-gaap:" + label, group, value: String(value * 1e6) });
// CoreWeave balance sheet at 2026-06-30 ($M), grouped as extracted.
const balance: BalanceSheet = {
  asOf: "2026-06-30", currency: "USD", source,
  assets: [line("cash", 6919, "cash"), line("receivables", 2541), line("other", 2933), line("productive", 46736), line("leaseAssets", 16595), line("intangibles", 1346)],
  liabilities: [line("payables", 10057), line("debt", 35068), line("customerAdvances", 9692), line("leases", 16540), line("deferredTax", 256), line("other", 433)],
  equity: [line("paidIn", -34, "treasury"), line("paidIn", 9085, "apic"), line("otherEquity", -18), line("retained", -4009)],
  totals: { assets: String(77070e6), liabilities: String(72046e6), equity: String(5024e6), currentAssets: null, currentLiabilities: null },
};
// Quarter ended 2026-06-30, derived from six months less three months ($M).
const cash: CashFlowStatement = {
  periodStart: "2026-04-01", periodEnd: "2026-06-30", currency: "USD", basis: "derived", formula: "test", sources: [source],
  operating: { total: String(679e6), lines: null },
  investing: { total: String(-7166e6), lines: [line("capex", -6422), line("investments", -682), line("other", -62)] },
  financing: { total: String(10071e6), lines: [line("debtIssued", 13457), line("debtRepaid", -3884), line("other", -499), line("equityIssued", 997)] },
  fxEffect: null, netChange: String(3584e6), supplemental: [],
};
const money = (v: number) => `$${(v / 1e9).toFixed(1)}B`;

test("balance pool: liabilities and paid-in capital fund the assets and the accumulated deficit", () => {
  const pool = balancePool(balance);
  const total = (items: typeof pool.sources) => items.reduce((s, i) => s + i.value, 0);
  assert.ok(Math.abs(total(pool.sources) - total(pool.uses)) < 1);
  assert.equal(pool.total, 81131e6);
  assert.equal(pool.uses.find(i => i.key === "deficit")?.value, 4009e6);
  assert.equal(pool.sources.find(i => i.key === "paid-in")?.value, 9085e6);
  assert.equal(balanceVerdict(balance), "资产的 67% 由借款和租赁支撑；股东权益占 7%；客户预付占 13%；累计亏损已消耗股东投入的 44%。");
});

test("cash pool balances and the verdict names how the gap was funded", () => {
  const pool = cashPool(cash);
  assert.ok(Math.abs(pool.sources.reduce((s, i) => s + i.value, 0) - pool.uses.reduce((s, i) => s + i.value, 0)) < 1);
  assert.deepEqual(pool.sources.map(i => [i.label, i.value / 1e6]), [["经营现金流", 679], ["新增借款", 13457], ["发行股票", 997]]);
  assert.deepEqual(pool.uses.map(i => i.label), ["资本开支", "金融与战略投资", "其他投资支出", "偿还借款", "其他融资支出", "现金增加"]);
  const expansion = fundingVerdict(cash, balance, money);
  assert.equal(expansion.kind, "expansion");
  assert.equal(expansion.text, "经营现金流 $0.7B，只覆盖资本开支 $6.4B 的 11%；缺口由外部融资 $10.1B（净借款 $9.6B、发股 $1.0B）补足。");
  const burning = { ...cash, operating: { total: String(-500e6), lines: null }, netChange: String(2405e6) };
  const survival = fundingVerdict(burning, balance, money);
  assert.equal(survival.kind, "survival");
  assert.match(survival.text, /约可支撑 13\.8 个季度/);
  assert.equal(fundingVerdict({ ...cash, operating: { total: String(9000e6), lines: null }, netChange: String(11905e6) }, balance, money).kind, "self");
});

test("the site serves capital on its own route, only after re-validating it, and never caches a non-ready answer", async () => {
  const capital: PublicCapitalStructure = { schemaVersion: "capital-structure.v1", ticker: "ORCL", quarters: [{ periodEnd: "2026-06-30", rpo: null, balanceSheet: balance, cashFlow: cash, yearToDate: null }] };
  const upstream = (value: unknown, status = "ready") => async (url: string | URL | Request) => {
    assert.match(String(url), /\/api\/v1\/companies\/ORCL\/capital$/);
    return Response.json({ schemaVersion: "capital-response.v1", status, capital: value });
  };
  assert.deepEqual(await loadCapital("ORCL", upstream(capital) as typeof fetch), capital);
  const tampered = structuredClone(capital);
  tampered.quarters[0].balanceSheet!.assets[0].value = "1";
  Object.assign(tampered.quarters[0], { privateNote: "PRIVATE" });
  const read = (await loadCapital("ORCL", upstream(tampered) as typeof fetch))!;
  assert.equal(read.quarters[0].balanceSheet, null);
  assert.ok(read.quarters[0].cashFlow);
  assert.ok(!JSON.stringify(read).includes("PRIVATE"));
  assert.equal(await loadCapital("ORCL", upstream({ ...capital, ticker: "MSFT" }) as typeof fetch), null);
  assert.equal(await loadCapital("ORCL", upstream(null, "unavailable") as typeof fetch), null);

  const stored: Request[] = [];
  const cache = { match: async () => undefined, put: async (request: Request) => { stored.push(request); } } as unknown as Cache;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
  const env: SiteEnv = { ASSETS: { fetch: async () => new Response("") }, PUBLIC_READ_LIMIT: { limit: async () => ({ success: true }) } };
  const site = (path: string, fetcher: typeof fetch) => handle(new Request("https://site.test" + path), env, ctx, fetcher, cache);
  const ok = await site("/api/business/v1/companies/ORCL/capital", upstream(capital) as typeof fetch);
  assert.deepEqual((await ok.json()).capital, capital);
  const missing = await site("/api/business/v1/companies/ORCL/capital", upstream(null, "unavailable") as typeof fetch);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  // A flow request whose upstream fails falls back to "preparing"; that answer must not be cached.
  const failing = (async (url: string | URL | Request) => String(url).endsWith("/business-flow") ? new Response("", { status: 503 }) : Response.json({})) as typeof fetch;
  const preparing = await site("/api/business/v1/companies/ORCL", failing);
  assert.equal((await preparing.json()).status, "preparing");
  assert.equal(preparing.headers.get("cache-control"), "no-store");
  await Promise.all(pending);
  assert.deepEqual(stored.map(r => new URL(r.url).pathname), ["/api/business/v1/companies/ORCL/capital"]);
  assert.equal(await site("/api/business/v1/companies/ORCL/capitals", upstream(capital) as typeof fetch).then(r => r.status), 404);
});
