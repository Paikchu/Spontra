import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlowQuarter, FlowAmount } from "@/shared/analysis-contract/business-flow";
import { trunkGraph, validateGraph, type FinancialGraph, type SankeyNode } from "@/packages/web/src/model/business-flow-sankey";

const node = (name: string, depth: number, value: number, extra: Partial<SankeyNode> = {}): SankeyNode => ({ name, label: name, depth, value, expense: false, ...extra });
const amount = (value: number, key: string): FlowAmount => ({ value: String(value), basis: "reported", definition: key, comparabilityKey: key, sourceIds: ["s"] });
const quarter = { figures: {} } as unknown as BusinessFlowQuarter;

// Shaped like AMZN's: a business with a sub-business, gross profit split into operating income and five expense lines.
const full: FinancialGraph = {
  nodes: [
    node("segment:na", -2, 116, { segmentId: "na" }), node("segment:na/stores", -3, 80, { segmentId: "na/stores" }), node("segment:aws", -2, 42, { segmentId: "aws" }),
    node("revenue", 0, 158), node("gross", 1, 100), node("cost", 1, 58, { expense: true }), node("operating", 2, 30),
    node("expense:fulfillment", 2, 30, { expense: true, amount: amount(30, "f") }), node("expense:tech", 2, 25, { expense: true, amount: amount(25, "t") }),
    node("expense:sales", 2, 15, { expense: true, amount: amount(15, "s") }), node("pretax", 3, 30), node("net", 4, 24), node("tax", 4, 6, { expense: true }),
  ],
  links: [
    { source: "segment:na/stores", target: "segment:na", value: 80 }, { source: "segment:na", target: "revenue", value: 116 }, { source: "segment:aws", target: "revenue", value: 42 },
    { source: "revenue", target: "gross", value: 100 }, { source: "revenue", target: "cost", value: 58 },
    { source: "gross", target: "operating", value: 30 }, { source: "gross", target: "expense:fulfillment", value: 30 }, { source: "gross", target: "expense:tech", value: 25 }, { source: "gross", target: "expense:sales", value: 15 },
    { source: "operating", target: "pretax", value: 30 }, { source: "pretax", target: "net", value: 24 }, { source: "pretax", target: "tax", value: 6 },
  ],
};

test("the trunk keeps top-level businesses and folds the expense lines into one node", () => {
  const { graph, folded } = trunkGraph(full, quarter);
  const names = graph.nodes.map(n => n.name).sort();
  assert.deepEqual(names, ["cost", "expense:trunk", "gross", "net", "operating", "pretax", "revenue", "segment:aws", "segment:na", "tax"]);
  assert.ok(validateGraph(graph.nodes, graph.links));
  assert.equal(graph.nodes.find(n => n.name === "expense:trunk")!.value, 70);
  assert.equal(graph.links.find(l => l.target === "expense:trunk")!.value, 70);
  assert.equal(folded.get("segment:na/stores"), "segment:na");
  assert.equal(folded.get("expense:tech"), "expense:trunk");
});

test("the folded node compares only when every line it holds is comparable", () => {
  const trunk = trunkGraph(full, quarter).graph.nodes.find(n => n.name === "expense:trunk")!;
  assert.equal(trunk.amount!.comparabilityKey, "expense-trunk:f+s+t");
  const unkeyed = { ...full, nodes: full.nodes.map(n => n.name === "expense:tech" ? { ...n, amount: { ...n.amount!, comparabilityKey: null } } : n) };
  assert.equal(trunkGraph(unkeyed, quarter).graph.nodes.find(n => n.name === "expense:trunk")!.amount!.comparabilityKey, null);
});

test("a statement with nothing to fold comes back as it was", () => {
  const plain: FinancialGraph = { nodes: full.nodes.filter(n => !n.name.startsWith("segment:na/") && !n.name.startsWith("expense:")).concat(node("operatingExpenses", 2, 70, { expense: true })),
    links: full.links.filter(l => !l.source.startsWith("segment:na/") && !l.target.startsWith("expense:")).concat({ source: "gross", target: "operatingExpenses", value: 70 }) };
  const { graph, folded } = trunkGraph(plain, quarter);
  assert.equal(graph, plain);
  assert.equal(folded.size, 0);
});
