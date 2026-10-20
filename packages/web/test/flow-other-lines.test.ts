import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlowQuarter, FlowAmount } from "@/shared/analysis-contract/business-flow";
import { deficitFinancialGraph, financialGraph, validateGraph } from "@/packages/web/src/model/business-flow-sankey";
import { reconcileQuarter } from "@/packages/web/src/model/business-flow-model";

const amount = (value: number, key: string): FlowAmount => ({ value: String(value), basis: "reported", definition: key, comparabilityKey: key, sourceIds: ["s"] });
const quarter = (operating: number, lines: Array<[string, number]>, tax: number): BusinessFlowQuarter => {
  const other = lines.reduce((n, [, v]) => n + v, 0), pretax = operating + other, revenue = 1000, cost = 400, opex = revenue - cost - operating;
  return {
    id: "q", label: "q", periodStart: "2026-04-01", periodEnd: "2026-06-30", periodType: "3M", currency: "USD", scale: 1, basisLabel: "", reportedAt: null, incomeModel: "standard",
    figures: { revenue: amount(revenue, "revenue"), cost: amount(cost, "cost"), gross: amount(revenue - cost, "gross"), operatingExpenses: amount(opex, "opex"), operating: amount(operating, "operating"),
      other: amount(other, "other"), pretax: amount(pretax, "pretax"), tax: amount(tax, "tax"), net: amount(pretax - tax, "net") },
    segments: [{ id: "all", name: "All", revenue: amount(revenue, "segment"), description: "", products: [], customers: null, monetization: null, disclosure: "", sourceIds: ["s"] }], segmentsComplete: true,
    expenseComponents: [{ id: "opex", name: "Operating expenses", group: "other", amount: amount(opex, "opex") }],
    otherComponents: lines.map(([name, v]) => ({ id: name, name, amount: amount(v, name) })), sources: [{ id: "s", title: "s", url: "https://www.sec.gov/x", publishedAt: null }],
  } as BusinessFlowQuarter;
};
const flows = (g: ReturnType<typeof financialGraph>, name: string) => ({ into: g.links.filter(l => l.target === name).map(l => [l.source, l.value]), out: g.links.filter(l => l.source === name).map(l => [l.target, l.value]) });

test("a profitable quarter draws each other line: gains join pretax income, charges leave operating income", () => {
  const q = quarter(200, [["Interest income", 30], ["Interest expense", -50], ["Gain on investments", 120]], 60);
  const g = financialGraph(q);
  assert.ok(validateGraph(g.nodes, g.links));
  assert.deepEqual(flows(g, "other:Interest expense"), { into: [["operating", 50]], out: [] });
  assert.deepEqual(flows(g, "other:Gain on investments"), { into: [], out: [["pretax", 120]] });
  assert.deepEqual(flows(g, "operating").out, [["pretax", 150], ["other:Interest expense", 50]]);
  assert.equal(g.nodes.find(n => n.name === "pretax")!.value, 300);
  assert.equal(g.nodes.some(n => n.name === "other"), false);
  // The compact chart keeps the single total.
  assert.ok(financialGraph(q, true).nodes.some(n => n.name === "other"));
});

test("charges larger than operating income leave the profitable chart to the single total", () => {
  const g = financialGraph(quarter(40, [["Interest expense", -50], ["Gain on investments", 120]], 20));
  assert.ok(validateGraph(g.nodes, g.links));
  assert.ok(g.nodes.some(n => n.name === "other"));
});

test("a loss quarter carries every other line, mixed signs included, through the signed chart", () => {
  // Nebius, three months ended June 30, 2026 ($ millions).
  const q = quarter(-175.9, [["Interest income", 24.1], ["Interest expense", -119.1], ["Income / (loss) from equity method investments", 12.7], ["Other income, net", 81.5]], 13.7);
  for (const g of [financialGraph(q), deficitFinancialGraph(q)!]) {
    assert.ok(g.nodes.length && validateGraph(g.nodes, g.links));
    for (const name of ["Interest income", "Interest expense", "Income / (loss) from equity method investments", "Other income, net"]) assert.ok(g.nodes.some(n => n.name === "other:" + name), name);
  }
});

test("the other lines are checked against other income, net", () => {
  const checks = reconcileQuarter(quarter(200, [["Interest income", 30], ["Interest expense", -50]], 60));
  assert.equal(checks.at(-1)!.status, "balanced");
  const wrong = quarter(200, [["Interest income", 30], ["Interest expense", -50]], 60);
  wrong.otherComponents![0]!.amount = amount(31, "x");
  assert.equal(reconcileQuarter(wrong).at(-1)!.status, "mismatch");
});
