import test from "node:test";
import assert from "node:assert/strict";
import { mergeHistory, readHistory, validHistoryQuarter } from "../shared/analysis-runtime/financial-data/history";
import type { RevenueHistory, RevenueHistoryQuarter } from "../shared/analysis-contract/revenue-history";
import { buildBridge, buildColumns, buildSlots, columnIndex, growthSeries, layerOrder, rateTicks, niceTicks, type TrendItem } from "../apps/business-site/src/trend-model";

const quarter = (periodEnd: string, segments: Array<[string, string, number]>, extra: Partial<RevenueHistoryQuarter> = {}): RevenueHistoryQuarter => {
  const start = new Date(Date.parse(periodEnd) - 91 * 86400000).toISOString().slice(0, 10);
  return { periodStart: start, periodEnd, currency: "USD", scale: 1, revenue: String(segments.reduce((s, [, , v]) => s + v, 0)), basis: "reported",
    segments: segments.map(([id, name, value]) => ({ id, name, value: String(value) })),
    source: { accession: "0000000001-26-000001", url: "https://www.sec.gov/Archives/edgar/data/1/a.htm", filedAt: "2026-01-01", form: "10-Q" }, ...extra };
};

test("history keeps only reconciling three-month quarters; reported beats derived and newer filings win", () => {
  const a = quarter("2026-03-31", [["a", "A", 60], ["b", "B", 40]]);
  assert.ok(validHistoryQuarter(a));
  assert.equal(validHistoryQuarter({ ...a, revenue: "105" }), false);
  assert.equal(validHistoryQuarter({ ...a, periodStart: "2025-04-01" }), false);
  const derived = { ...a, basis: "derived" as const, revenue: "90", segments: [{ id: "a", name: "A", value: "50" }, { id: "b", name: "B", value: "40" }], source: { ...a.source, filedAt: "2026-09-01" } };
  assert.equal(mergeHistory("X", [a], [derived], "now").quarters[0].revenue, "100");
  const newer = { ...a, segments: [{ id: "a2", name: "A", value: "60" }, { id: "b", name: "B", value: "40" }], source: { ...a.source, filedAt: "2026-05-01" } };
  assert.equal(mergeHistory("X", [a], [newer], "now").quarters[0].segments[0].id, "a2");
});

test("public history projection strips unknown fields, rejects other tickers and keeps twelve quarters including the prior-year baselines", () => {
  const quarters = Array.from({ length: 14 }, (_, i) => quarter(new Date(Date.UTC(2024, 3 * i + 3, 0)).toISOString().slice(0, 10), [["a", "A", 10 + i]]));
  const raw = { schemaVersion: "revenue-history.v1", ticker: "X", updatedAt: "now", quarters: [...quarters].reverse().map(q => ({ ...q, privateNote: "PRIVATE" })), secret: "PRIVATE" };
  const history = readHistory(raw, "X")!;
  assert.equal(history.quarters.length, 12);
  assert.deepEqual(history.quarters.map(q => q.periodEnd), quarters.slice(-12).map(q => q.periodEnd));
  assert.ok(!JSON.stringify(history).includes("PRIVATE"));
  assert.equal(readHistory(raw, "Y"), null);
  assert.equal(readHistory({ ...raw, quarters: [{ ...quarters[0], source: { ...quarters[0].source, url: "https://evil.example/a" } }] }, "X"), null);
});

const items: TrendItem[] = [
  { key: "cloud", id: "cloud", parent: null, name: "云服务", slot: 1 },
  { key: "apps", id: "apps", parent: "cloud", name: "云应用", slot: 1 },
  { key: "infra", id: "infra", parent: "cloud", name: "云基础设施", slot: 1 },
  { key: "hw", id: "HardwareRevenues", parent: null, name: "硬件", slot: 2 },
];
const withChildren = (end: string, apps: number, infra: number, hw: number, hwId = "HardwareRevenues"): RevenueHistoryQuarter => {
  const q = quarter(end, [["cloud", "云服务", apps + infra], [hwId, "硬件", hw]]);
  q.segments[0].children = [{ id: "apps", name: "云应用", value: String(apps) }, { id: "infra", name: "云基础设施", value: String(infra) }];
  return q;
};
const history: RevenueHistory = { schemaVersion: "revenue-history.v1", ticker: "X", updatedAt: "now", quarters: [
  quarter("2025-11-30", [["old", "CloudAndSoftwareBusiness", 9], ["HardwareBusiness", "HardwareBusiness", 1]]),
  withChildren("2026-05-31", 3, 5, 1, "hardware"),
  withChildren("2026-08-31", 4, 7, 1),
] };

test("trend slots step by calendar quarter and keep uncollected periods as explicit gaps", () => {
  const slots = buildSlots(history);
  assert.equal(slots.length, 8);
  assert.deepEqual(slots.map(s => s.periodEnd.slice(0, 7)), ["2024-11", "2025-02", "2025-05", "2025-08", "2025-11", "2026-02", "2026-05", "2026-08"]);
  assert.deepEqual(slots.map(s => s.quarter ? 1 : 0), [0, 0, 0, 0, 1, 0, 1, 1]);
});

test("trends normalize mixed disclosure scales for totals, children and growth without changing source data", () => {
  const prior = { ...withChildren("2026-05-31", 3000, 5000, 1000), scale: 1000 };
  const current = { ...withChildren("2026-08-31", 4, 7, 1), scale: 1_000_000 };
  const mixed = { ...history, quarters: [current, prior] };
  const original = structuredClone(mixed);
  const slots = buildSlots(mixed);
  const columns = buildColumns(slots, items, null);
  assert.deepEqual(columns.slice(-2).map(c => c.total), [9e6, 12e6]);
  assert.deepEqual(buildColumns(slots, items, items[1]).slice(-2).map(c => c.total), [3e6, 4e6]);
  assert.equal(buildBridge(columns, 7, 1)!.change, 3e6);
  assert.equal(growthSeries(columns, 1).at(-1), (12 / 9 - 1) * 100);
  assert.deepEqual(mixed, original);
});

test("different reporting currencies leave a labelled gap instead of a false growth comparison", () => {
  const slots = buildSlots({ ...history, quarters: [{ ...withChildren("2026-05-31", 3, 5, 1), currency: "EUR" }, withChildren("2026-08-31", 4, 7, 1)] });
  assert.equal(slots.at(-2)!.missingReason, "currency");
  const columns = buildColumns(slots, items, null);
  assert.equal(columns.at(-2)!.total, null);
  assert.equal(growthSeries(columns, 1).at(-1), null);
  assert.equal(buildBridge(columns, 7, 1), null);
});

test("columns retain original disclosed businesses across presentations without inventing a current business split", () => {
  const slots = buildSlots(history);
  const all = buildColumns(slots, items, null);
  assert.equal(all[4].state, "basis");
  assert.deepEqual(all[4].layers.map(l => l.key), ["disclosed:old", "hw"]);
  assert.deepEqual(all[4].layers.map(l => l.value), [9, 1]);
  assert.ok(layerOrder(items, all).includes("disclosed:old"));
  // A renamed member with the same disclosed business name still lines up.
  assert.deepEqual(all[6].layers.map(l => [l.key, l.value]), [["cloud", 8], ["hw", 1]]);
  const cloud = buildColumns(slots, items, items[0]);
  assert.deepEqual(cloud[7].layers.map(l => [l.key, l.value]), [["apps", 4], ["infra", 7]]);
  assert.equal(cloud[4].layers.length, 0);
  assert.deepEqual(buildColumns(slots, items, items[2])[7].layers.map(l => l.value), [7]);
  assert.deepEqual(layerOrder(items), ["cloud", "apps", "infra", "hw", "__total"]);
  assert.deepEqual(niceTicks(11), [0, 5, 10, 15]);
});

test("growth bridge splits a change only between quarters stacked from the same businesses", () => {
  const slots = buildSlots(history);
  const all = buildColumns(slots, items, null);
  const latest = columnIndex(all, "2026-08-31");
  assert.equal(latest, 7);
  assert.equal(columnIndex(all, "2020-01-31"), 7);
  // Quarter over quarter: cloud 8 → 11, hardware 1 → 1; steps are sorted by change and chain from the base level.
  const qoq = buildBridge(all, latest, 1)!;
  assert.equal(qoq.reason, "split");
  assert.equal(qoq.change, 3);
  assert.equal(qoq.percent, 3 / 9 * 100);
  assert.deepEqual(qoq.steps.map(s => [s.key, s.base, s.value, s.delta, s.before, s.after]), [["cloud", 8, 11, 3, 9, 12], ["hw", 1, 1, 0, 12, 12]]);
  // Year over year lands on an uncollected quarter: no bridge rather than a zero base.
  assert.equal(buildBridge(all, latest, 4), null);
  // A quarter presented under other businesses keeps the total change as one neutral step.
  const presented = buildBridge(all.map((c, i) => i === 6 ? all[4] : c), latest, 1)!;
  assert.equal(presented.reason, "basis");
  assert.deepEqual(presented.steps.map(s => [s.key, s.delta, s.before, s.after]), [["__total", 2, 10, 12]]);
  // Inside a business the split follows its children; a leaf business is one step of its own colour.
  const cloud = buildBridge(buildColumns(slots, items, items[0]), latest, 1)!;
  assert.deepEqual(cloud.steps.map(s => [s.key, s.delta]), [["infra", 2], ["apps", 1]]);
  const infra = buildBridge(buildColumns(slots, items, items[2]), latest, 1)!;
  assert.equal(infra.reason, "single");
  assert.deepEqual(infra.steps.map(s => [s.key, s.delta, s.tone]), [["infra", 2, "child"]]);
});

test("growth series compares each quarter with the one a lag earlier and leaves gaps where either is missing", () => {
  const all = buildColumns(buildSlots(history), items, null);
  // Totals: slot 4 = 10, slot 6 = 9, slot 7 = 12; every other slot is uncollected.
  assert.deepEqual(growthSeries(all, 1), [null, null, null, null, null, null, null, (12 / 9 - 1) * 100]);
  assert.deepEqual(growthSeries(all, 4), Array(8).fill(null));
  const cloud = buildColumns(buildSlots(history), items, items[0]);
  assert.deepEqual(growthSeries(cloud, 1).slice(-1), [(11 / 8 - 1) * 100]);
});

test("growth axis puts 0% on one of the four shared gridlines and covers every rate", () => {
  assert.equal(rateTicks([null, null]), null);
  assert.deepEqual(rateTicks([null, 14.2, 21.7, 20.1, 29.6]), [0, 10, 20, 30]);
  const mixed = rateTicks([-12, 5, 18])!;
  assert.ok(mixed.includes(0) && mixed[0] <= -12 && mixed[3] >= 18);
  assert.deepEqual(rateTicks([-30, -5]), [-30, -20, -10, 0]);
  assert.deepEqual(rateTicks([0.4]), [0, 0.2, 0.4, 0.6]);
});

test("twelve-quarter history supplies all eight visible YoY and QoQ points, including the first bridge", () => {
  const quarters = Array.from({ length: 12 }, (_, i) => withChildren(new Date(Date.UTC(2023, 11 + i * 3, 0)).toISOString().slice(0, 10), 20 + i, 30 + 2 * i, 10));
  const full = { ...history, quarters };
  const columns = buildColumns(buildSlots(full, 12), items, null);
  const visible = columns.slice(-8);
  assert.deepEqual(visible.map(c => c.slot.periodEnd), buildSlots(full).map(s => s.periodEnd));
  for (const lag of [1, 4] as const) {
    const rates = growthSeries(columns, lag).slice(-8);
    assert.equal(rates.filter(v => v != null).length, 8);
    assert.equal(rates[0], (Number(quarters[4].revenue) / Number(quarters[4 - lag].revenue) - 1) * 100);
    const bridge = buildBridge(columns, 4, lag)!;
    assert.equal(bridge.base.slot.periodEnd, quarters[4 - lag].periodEnd);
    assert.equal(bridge.change, Number(quarters[4].revenue) - Number(quarters[4 - lag].revenue));
  }
  const cloud = buildColumns(buildSlots(full, 12), items, items[0]);
  assert.equal(growthSeries(cloud, 4).slice(-8)[0], (62 / 50 - 1) * 100);
  // A missing comparison must leave its corresponding point empty, not shift older data forward.
  const missing = buildColumns(buildSlots({ ...full, quarters: quarters.filter((_, i) => i !== 1) }, 12), items, null);
  const rates = growthSeries(missing, 4).slice(-8);
  assert.equal(rates[1], null);
  assert.equal(rates.filter(v => v != null).length, 7);
  const zero = buildColumns(buildSlots({ ...full, quarters: quarters.map((q, i) => i === 0 ? withChildren(q.periodEnd, 0, 0, 10) : q) }, 12), items, items[0]);
  assert.equal(growthSeries(zero, 4).slice(-8)[0], null);
});

test("a uniquely disclosed concept remains comparable when its parent category changes", () => {
  const old = quarter("2024-11-30", [["combined", "云服务与许可支持", 90], ["license", "许可", 10]]);
  old.segments[0].children = [{ id: "cloud", name: "云服务", value: "40" }, { id: "support", name: "软件支持", value: "50" }];
  const selected = [items[0], { key: "software", id: "software", name: "软件", parent: null, slot: 2 },
    { key: "support", id: "support", name: "软件支持", parent: "software", slot: 2 }];
  const slots = [{ periodEnd: old.periodEnd, quarter: old }];
  assert.equal(buildColumns(slots, selected, selected[0])[0].total, 40);
  assert.equal(buildColumns(slots, selected, selected[2])[0].total, 50);
  // No manufactured software total or missing cloud-applications split.
  assert.equal(buildColumns(slots, selected, selected[1])[0].total, null);
  assert.equal(buildColumns(slots, items, items[1])[0].total, null);
  old.segments[1].children = [{ id: "cloud", name: "云服务", value: "10" }];
  assert.equal(buildColumns(slots, selected, selected[0])[0].total, null);
});
