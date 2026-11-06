import { test } from "node:test";
import assert from "node:assert/strict";
import { coreSlots } from "../src/company-meta.ts";
import { sideScroll } from "../src/side-scroll.ts";
import type { FlowMetric } from "../../../shared/analysis-contract/business-flow.ts";

const figures = (values: Partial<Record<FlowMetric, number>>) => (key: FlowMetric) => values[key] ?? null;

test("U21: the headline figures are always four cells, a missing one with its reason", () => {
  // An operating company: revenue, gross profit, operating income, net income.
  assert.deepEqual(coreSlots(figures({ revenue: 100, gross: 60, operating: 30, pretax: 28, net: 22 })).map(s => [s.key, s.value, s.missing]),
    [["revenue", 100, null], ["gross", 60, null], ["operating", 30, null], ["net", 22, null]]);
  // A bank: no gross profit or operating income, but income before taxes; the operating cell is not part of its model.
  assert.deepEqual(coreSlots(figures({ revenue: 100, pretax: 40, net: 31 })).map(s => [s.key, s.value, s.missing]),
    [["revenue", 100, null], ["pretax", 40, null], ["operating", null, "model"], ["net", 31, null]]);
  // A company whose filing leaves out gross profit and pretax income: the cells stay, as not disclosed.
  assert.deepEqual(coreSlots(figures({ revenue: 100, operating: 10, net: 8 })).map(s => [s.key, s.missing]),
    [["revenue", null], ["gross", "undisclosed"], ["operating", null], ["net", null]]);
  // No operating line but a pretax one beside gross profit: pretax takes the operating cell, as the wide header always showed.
  assert.deepEqual(coreSlots(figures({ revenue: 100, gross: 50, pretax: 20, net: 15 })).map(s => s.key), ["revenue", "gross", "pretax", "net"]);
  // A direct-operating statement keeps its gross profit out of the header.
  assert.deepEqual(coreSlots(figures({ revenue: 100, gross: 50, operating: 20, pretax: 18, net: 15 }), { hideGross: true }).map(s => [s.key, s.missing]),
    [["revenue", null], ["pretax", null], ["operating", null], ["net", null]]);
  for (const slots of [coreSlots(figures({})), coreSlots(figures({ revenue: 1 }))]) assert.equal(slots.length, 4);
});

test("U21: the chart scroller knows when more lies to the right and when the reader reached the edge", () => {
  assert.deepEqual(sideScroll({ scrollLeft: 0, scrollWidth: 358, clientWidth: 358 }), { overflow: false, atEnd: true });
  assert.deepEqual(sideScroll({ scrollLeft: 0, scrollWidth: 780, clientWidth: 358 }), { overflow: true, atEnd: false });
  assert.deepEqual(sideScroll({ scrollLeft: 200, scrollWidth: 780, clientWidth: 358 }), { overflow: true, atEnd: false });
  assert.deepEqual(sideScroll({ scrollLeft: 421.5, scrollWidth: 780, clientWidth: 358 }), { overflow: true, atEnd: true });
});
