import assert from "node:assert/strict";
import test from "node:test";
import { enrichDisclosedRevenue } from "../packages/web/src/model/company-revenue-disclosures";
import { financialGraph } from "../packages/web/src/model/business-flow-sankey";
import { compactFlowValue, estimateTextWidth, INFOGRAPHIC, layoutInfographic, type InfographicLayout, type PlacedNode } from "../packages/web/src/model/business-flow-layout";
import { businessFlowFixture } from "./fixtures/business-flow-fixture";

const latest = [...businessFlowFixture.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
function nvdaLayout() {
  const base = { ...structuredClone(latest), periodStart: null, periodEnd: "2026-07-26", segments: [], segmentsComplete: false, figures: { revenue: { ...latest.figures.revenue!, value: "96221000000" } }, sources: [], scale: 1 };
  return layoutInfographic(financialGraph(enrichDisclosedRevenue("NVDA", base)))!;
}
const node = (layout: InfographicLayout, name: string) => layout.nodes.find(n => n.name === name)!;
const extent = (n: PlacedNode): [number, number] => n.side === "top" ? [n.y - INFOGRAPHIC.labelHeight, n.y + n.h] : n.side === "bottom" ? [n.y, n.y + n.h + INFOGRAPHIC.labelHeight] : [n.y, n.y + Math.max(n.h, INFOGRAPHIC.sideLabelHeight)];

for (const [name, build] of [["fixture", () => layoutInfographic(financialGraph(latest))!], ["NVDA", nvdaLayout]] as const) {
  test(`${name}: profit rises, costs sink and labels never overlap`, () => {
    const layout = build();
    const revenue = node(layout, "revenue"), gross = node(layout, "gross"), cost = node(layout, "cost"), net = node(layout, "net");
    assert.ok(gross.y < revenue.y, "gross profit starts above revenue");
    assert.ok(cost.y > gross.y + gross.h, "cost of revenue sits below gross profit");
    assert.ok(net.y < node(layout, "tax").y, "net profit sits above tax");
    assert.equal(net.side, "right");
    for (const n of layout.nodes) assert.equal(n.tone === "expense", n.expense, n.name);
    for (const n of layout.nodes) {
      const [top, bottom] = extent(n);
      assert.ok(top >= 0 && bottom <= layout.height, `${n.name} inside canvas`);
      assert.ok(n.x >= 0 && n.x + layout.nodeWidth <= layout.width, `${n.name} inside width`);
    }
    const columns = new Map<number, PlacedNode[]>();
    for (const n of layout.nodes) columns.set(n.column, [...(columns.get(n.column) ?? []), n]);
    for (const column of columns.values()) {
      const sorted = column.slice().sort((a, b) => a.y - b.y);
      for (let i = 1; i < sorted.length; i++) assert.ok(extent(sorted[i - 1])[1] <= extent(sorted[i])[0] + 1e-6, `${sorted[i - 1].name} / ${sorted[i].name} labels overlap`);
    }
  });

  test(`${name}: bands keep amounts proportional and fill every bar exactly`, () => {
    const layout = build();
    const scale = node(layout, "revenue").h / node(layout, "revenue").value;
    for (const l of layout.links) assert.ok(Math.abs(l.h - l.value * scale) < 1e-6);
    for (const n of layout.nodes) {
      const into = layout.links.filter(l => l.target === n.name), out = layout.links.filter(l => l.source === n.name);
      for (const group of [into, out]) {
        if (!group.length) continue;
        const starts = group.map(l => l === into[0] || into.includes(l) ? l.ty : l.sy).sort((a, b) => a - b);
        assert.ok(Math.abs(starts[0] - n.y) < 1e-6, `${n.name} bands start at the bar top`);
        assert.ok(group.reduce((s, l) => s + l.h, 0) <= n.h + 1e-6);
      }
    }
  });
}

test("other income sits above operating profit so its band never crosses the column's outflows", () => {
  // ORCL shape: revenue → operating, other income feeds pretax while interest expense leaves operating.
  const quarter = structuredClone(latest), at = (value: number) => ({ ...quarter.figures.other!, value: String(value) });
  quarter.incomeModel = "direct_operating";
  quarter.figures = { revenue: at(19300), operatingExpenses: at(12600), operating: at(6700), other: at(-1093), pretax: at(5607), tax: at(847), net: at(4760) };
  quarter.expenseComponents = [{ id: "direct", name: "产品与服务费用", group: "direct", amount: at(7700) }, { id: "sales", name: "销售营销", group: "sales", amount: at(2500) }, { id: "research", name: "研发", group: "research", amount: at(2400) }];
  quarter.otherComponents = [{ id: "income", name: "其他非营业损益", amount: at(307) }, { id: "interest", name: "利息费用", amount: at(-1400) }];
  const layout = layoutInfographic(financialGraph(quarter))!;
  const income = node(layout, "other:income"), operating = node(layout, "operating");
  assert.equal(income.column, operating.column);
  assert.ok(income.y + income.h < operating.y, "inputless gain is stacked above operating profit");
  const columnOf = (name: string) => node(layout, name).column;
  for (const a of layout.links) for (const b of layout.links) {
    if (a === b || columnOf(a.source) !== columnOf(b.source) || columnOf(a.target) !== columnOf(b.target)) continue;
    assert.equal(a.sy < b.sy, a.ty < b.ty, `${a.source}>${a.target} crosses ${b.source}>${b.target}`);
  }
});

test("NVDA business tree flows from the left with labels on the outside", () => {
  const layout = nvdaLayout();
  const hyperscale = layout.nodes.find(n => n.label === "超大规模云客户")!;
  assert.equal(hyperscale.side, "left");
  assert.equal(hyperscale.tone, "source");
  assert.ok(hyperscale.x < node(layout, "revenue").x);
});

test("compact amounts keep currency, sign and magnitude", () => {
  assert.equal(compactFlowValue(96221, latest), "$96.2B");
  assert.equal(compactFlowValue(-8.4, { ...latest, scale: 1_000_000 }), "−$8.4M");
  assert.equal(compactFlowValue(1500, { ...latest, currency: "SEK", scale: 1_000_000 }), "1.5B SEK");
  assert.equal(compactFlowValue(null, latest), "未披露");
});

test("columns are spaced so labels never collide with another column's label or bar", () => {
  for (const layout of [nvdaLayout(), layoutInfographic(financialGraph(latest))!]) {
    const width = (n: PlacedNode) => Math.max(estimateTextWidth(n.label, 15, true) + 8 + estimateTextWidth("$000.0B", 22, true), estimateTextWidth("占收入 00.0% · 环比 +00.0%", 13));
    const box = (n: PlacedNode) => {
      const w = width(n), [top, bottom] = extent(n);
      const [l, r] = n.side === "left" ? [n.x - INFOGRAPHIC.labelOffset - w, n.x] : n.side === "right" ? [n.x, n.x + layout.nodeWidth + INFOGRAPHIC.labelOffset + w] : [n.x + layout.nodeWidth / 2 - w / 2, n.x + layout.nodeWidth / 2 + w / 2];
      return { n, l, r, top: n.side === "top" ? top : n.side === "bottom" ? n.y + n.h : n.y, bottom: n.side === "top" ? n.y : bottom };
    };
    const boxes = layout.nodes.map(box);
    for (const a of boxes) {
      assert.ok(a.l >= 0 && a.r <= layout.width, `${a.n.name} label inside width`);
      for (const b of boxes) if (b.n.column !== a.n.column && a.top < b.bottom && b.top < a.bottom) assert.ok(a.r <= b.l || b.r <= a.l, `${a.n.name} / ${b.n.name} labels collide`);
    }
  }
});
