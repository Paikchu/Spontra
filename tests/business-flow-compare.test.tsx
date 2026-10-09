import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FlowChart, layoutFor, priorLayoutFor, type NodeCopy } from "../apps/business-site/src/FlowChart";
import { alignedGraph, ghostFrames, morphLayout, priorRevenueHeight } from "../lib/earning-report/web/business-flow-compare";
import { INFOGRAPHIC, layoutInfographic, type PlacedNode } from "../lib/earning-report/web/business-flow-layout";
import { compareAmount, numeric } from "../lib/earning-report/web/business-flow-model";
import { financialGraph } from "../lib/earning-report/web/business-flow-sankey";
import { businessFlowFixture } from "./fixtures/business-flow-fixture";

const [q4, q3] = businessFlowFixture.quarters;
const current = financialGraph(q4), previous = financialGraph(q3);
const node = (nodes: PlacedNode[], name: string) => nodes.find(n => n.name === name)!;
const copy = (n: PlacedNode): NodeCopy => ({ name: n.label, value: String(Math.round(n.value)) });

test("the prior quarter is laid out at the current quarter's scale, so bar heights compare across quarters", () => {
  const now = layoutInfographic(current)!;
  const before = layoutInfographic(previous, undefined, { revenueHeight: priorRevenueHeight(current, previous, INFOGRAPHIC.revenueHeight) })!;
  const scale = (nodes: PlacedNode[]) => node(nodes, "revenue").h / node(nodes, "revenue").value;
  assert.ok(Math.abs(scale(now.nodes) - scale(before.nodes)) < 1e-9, "same money-per-pixel in both quarters");
  assert.equal(node(now.nodes, "revenue").h, INFOGRAPHIC.revenueHeight);
  assert.ok(node(before.nodes, "revenue").h !== INFOGRAPHIC.revenueHeight, "the prior quarter's revenue bar is no longer normalised to full height");
  const alone = layoutInfographic(previous)!;
  assert.equal(node(alone.nodes, "revenue").h, INFOGRAPHIC.revenueHeight, "without the override every quarter is normalised on its own");
});

test("ghost frames carry the comparable prior amount at the current scale and grow away from the label", () => {
  const layout = layoutInfographic(current)!;
  const scale = node(layout.nodes, "revenue").h / node(layout.nodes, "revenue").value;
  const priorOf = (n: PlacedNode) => n.metric ? compareAmount(q4, q3, n.metric).previous : null;
  const ghosts = ghostFrames(layout, priorOf);
  const revenue = node(layout.nodes, "revenue"), cost = node(layout.nodes, "cost");
  const prevRevenue = numeric(q3.figures.revenue)!, prevCost = numeric(q3.figures.cost)!;
  const gRevenue = ghosts.find(g => g.name === "revenue")!, gCost = ghosts.find(g => g.name === "cost")!;
  assert.ok(Math.abs(gRevenue.h - prevRevenue * scale) < 1e-6, "ghost height is the prior amount at this quarter's scale");
  assert.equal(gRevenue.y, revenue.y, "a top-labelled bar shares its top edge with its ghost");
  assert.equal(cost.side, "bottom");
  assert.ok(Math.abs(gCost.y + gCost.h - (cost.y + cost.h)) < 1e-6, "a bottom-labelled cost shares its bottom edge with its ghost");
  assert.ok(Math.abs(gCost.h - prevCost * scale) < 1e-6);
  assert.ok(!ghosts.some(g => g.name === "segment:" + q4.segments[0]?.id), "nodes without a comparable prior stay bare");
  assert.deepEqual(ghostFrames(layout, () => null), []);
  assert.deepEqual(ghostFrames(layout, n => n.value), [], "an unchanged amount draws no frame over its own bar");
});

test("morphing glides shared nodes and bands by name and fades the rest with their quarter", () => {
  const now = layoutInfographic(current)!;
  const before = layoutInfographic(previous, undefined, { revenueHeight: priorRevenueHeight(current, previous, INFOGRAPHIC.revenueHeight) })!;
  const extra: PlacedNode = { ...node(before.nodes, "net"), name: "only-prior", label: "仅上季" };
  const prior = { ...before, nodes: [...before.nodes, extra], links: [...before.links, { ...before.links[0], source: "only-prior", target: "net" }] };
  const start = morphLayout(now, prior, 0), half = morphLayout(now, prior, 0.5), end = morphLayout(now, prior, 1);
  assert.deepEqual(start.nodes.map(n => [n.name, n.y, n.h, n.fade]), now.nodes.map(n => [n.name, n.y, n.h, 1]));
  for (const n of now.nodes) {
    const o = node(before.nodes, n.name), m = node(half.nodes, n.name), e = node(end.nodes, n.name);
    assert.ok(Math.abs(m.y - (n.y + o.y) / 2) < 1e-9 && Math.abs(m.h - (n.h + o.h) / 2) < 1e-9, `${n.name} halfway`);
    assert.ok(Math.abs(e.y - o.y) < 1e-9 && Math.abs(e.h - o.h) < 1e-9 && Math.abs(e.x - o.x) < 1e-9, `${n.name} lands on the prior layout`);
  }
  assert.equal(node(half.nodes, "only-prior").fade, 0.5);
  assert.equal(node(end.nodes, "only-prior").fade, 1);
  assert.ok(!start.nodes.some(n => n.name === "only-prior"), "at t = 0 the chart is exactly this quarter");
  const onlyPriorBand = half.links.find(l => l.source === "only-prior")!;
  assert.equal(onlyPriorBand.fade, 0.5);
  assert.ok(half.links.filter(l => l.source !== "only-prior").every(l => l.fade === 1));
  const shared = now.links[0], mid = half.links.find(l => l.source === shared.source && l.target === shared.target)!, old = before.links.find(l => l.source === shared.source && l.target === shared.target)!;
  assert.ok(Math.abs(mid.h - (shared.h + old.h) / 2) < 1e-9, "band thickness interpolates");
  assert.deepEqual(morphLayout(now, null, 1).nodes.map(n => n.fade), now.nodes.map(() => 1), "no prior quarter: nothing to morph to");
});

test("the chart draws ghost frames, offers 对比上季 only with a prior quarter and keeps the prior at the current scale", () => {
  const priorOf = (n: PlacedNode) => n.metric ? compareAmount(q4, q3, n.metric).previous : null;
  const props = { graph: current, copy, money: (v: number) => String(v), colorOf: () => "#000", active: null, focusSlot: () => null, onHover: () => {}, onPick: () => {}, tipFor: (n: PlacedNode) => ({ title: n.label, color: "#000", rows: [] as Array<[string, string]> }), label: "test", revealKey: "q4" };
  const withPrior = renderToStaticMarkup(<FlowChart {...props} priorOf={priorOf} previous={{ graph: previous, copy, label: q3.label }} />);
  assert.ok(withPrior.includes("对比上季"), "the compare control is offered");
  assert.ok(withPrior.includes('aria-pressed="false"'));
  assert.ok((withPrior.match(/class="fc-ghost"/g) ?? []).length >= 2, "comparable bars carry ghost frames");
  assert.ok(!withPrior.includes("fc-period"), "the prior-quarter caption only shows while comparing");
  const alone = renderToStaticMarkup(<FlowChart {...props} />);
  assert.ok(!alone.includes("对比上季") && !alone.includes("fc-ghost"));
  const k = 1.1, now = layoutFor(current, copy, k)!, before = priorLayoutFor(current, previous, copy, k)!;
  assert.ok(Math.abs(node(now.nodes, "revenue").h / node(now.nodes, "revenue").value - node(before.nodes, "revenue").h / node(before.nodes, "revenue").value) < 1e-9);
});

test("the prior graph takes the current quarter's node and link order so bands keep their places while morphing", () => {
  const shuffled = { ...previous, nodes: [...previous.nodes].reverse(), links: [...previous.links].reverse() };
  const aligned = alignedGraph(shuffled, current);
  const shared = (names: string[]) => names.filter(n => current.nodes.some(c => c.name === n));
  assert.deepEqual(shared(aligned.nodes.map(n => n.name)), shared(current.nodes.map(n => n.name)));
  assert.deepEqual(aligned.links.map(l => `${l.source}>${l.target}`).filter(k => current.links.some(l => `${l.source}>${l.target}` === k)), current.links.map(l => `${l.source}>${l.target}`).filter(k => shuffled.links.some(l => `${l.source}>${l.target}` === k)));
  const extra = { ...shuffled, nodes: [{ ...shuffled.nodes[0], name: "z-only-prior" }, ...shuffled.nodes] };
  assert.equal(alignedGraph(extra, current).nodes.at(-1)!.name, "z-only-prior", "a node absent from this quarter goes last");
  assert.equal(aligned.nodes.length, previous.nodes.length);
  assert.equal(aligned.links.length, previous.links.length);
  const now = layoutInfographic(current)!, before = layoutInfographic(aligned, undefined, { revenueHeight: priorRevenueHeight(current, previous, INFOGRAPHIC.revenueHeight) })!;
  const order = (nodes: PlacedNode[]) => nodes.filter(n => n.segmentId && n.column === node(nodes, "revenue").column - 1).sort((a, b) => a.y - b.y).map(n => n.name);
  assert.deepEqual(order(before.nodes), order(now.nodes), "top-level businesses stack in the same order in both quarters");
});
