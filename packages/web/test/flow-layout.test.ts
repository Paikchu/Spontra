import { test } from "node:test";
import assert from "node:assert/strict";
import type { FinancialGraph, SankeyNode } from "@/packages/web/src/model/business-flow-sankey";
import { layoutInfographic } from "@/packages/web/src/model/business-flow-layout";

const node = (name: string, depth: number, value: number, extra: Partial<SankeyNode> = {}): SankeyNode => ({ name, label: name, depth, value, expense: false, ...extra });
const move = (graph: FinancialGraph, source: string, target: string) => {
  const link = layoutInfographic(graph)!.links.find(l => l.source === source && l.target === target)!;
  return Math.abs(link.ty - link.sy);
};

// A loss quarter shaped like NBIS's: three businesses, a segment total less a small elimination, revenue and the net loss paying costs.
const loss: FinancialGraph = {
  deficit: true,
  nodes: [
    node("revenue", 0, 582), node("net", 0, 190, { loss: true }), node("operatingExpenses", 1, 758, { expense: true }), node("tax", 1, 14, { expense: true }),
    node("segment-total", -1, 586), node("revenue-adjustment:eliminations", 0, 4, { expense: true }),
    node("segment:cloud", -2, 575, { segmentId: "cloud" }), node("segment:a", -2, 1, { segmentId: "a" }), node("segment:b", -2, 10, { segmentId: "b" }),
  ],
  links: [
    { source: "revenue", target: "operatingExpenses", value: 582 }, { source: "net", target: "operatingExpenses", value: 176 }, { source: "net", target: "tax", value: 14 },
    { source: "segment:cloud", target: "segment-total", value: 575 }, { source: "segment:a", target: "segment-total", value: 1 }, { source: "segment:b", target: "segment-total", value: 10 },
    // The elimination is listed first, as the revenue tree emits it.
    { source: "segment-total", target: "revenue-adjustment:eliminations", value: 4 }, { source: "segment-total", target: "revenue", value: 582 },
  ],
};

test("the segment total lines up with revenue, not with the elimination it also feeds", () => {
  assert.ok(move(loss, "segment-total", "revenue") < 1);
  assert.ok(move(loss, "segment:cloud", "segment-total") < 5);
});

test("the elimination sits right under revenue, above the net loss", () => {
  const layout = layoutInfographic(loss)!, y = (name: string) => layout.nodes.find(n => n.name === name)!.y;
  assert.ok(y("revenue") < y("revenue-adjustment:eliminations") && y("revenue-adjustment:eliminations") < y("net"));
});

test("a signed statement hangs its business tree left of revenue the same way", () => {
  const signed: FinancialGraph = {
    signed: true,
    nodes: [node("revenue", 0, 300), node("operating", 1, 100), node("operatingExpenses", 1, 200, { expense: true }),
      node("segment:a", -1, 150, { segmentId: "a" }), node("segment:b", -1, 100, { segmentId: "b" }), node("segment:c", -1, 50, { segmentId: "c" })],
    links: [{ source: "revenue", target: "operating", value: 100 }, { source: "revenue", target: "operatingExpenses", value: 200 },
      { source: "segment:a", target: "revenue", value: 150 }, { source: "segment:b", target: "revenue", value: 100 }, { source: "segment:c", target: "revenue", value: 50 }],
  };
  assert.ok(move(signed, "segment:a", "revenue") < 20);
  assert.equal(layoutInfographic(signed)!.nodes.find(n => n.name === "segment:a")!.side, "left");
});
