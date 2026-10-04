import test from "node:test";
import assert from "node:assert/strict";
import { mergeHistory, readHistory, validHistoryQuarter } from "../shared/analysis-runtime/financial-data/history";
import type { RevenueHistory, RevenueHistoryQuarter } from "../shared/analysis-contract/revenue-history";
import { buildColumns, buildSlots, layerOrder, niceTicks, type TrendItem } from "../apps/business-site/src/trend-model";

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

test("public history projection strips unknown fields, rejects other tickers and keeps the newest eight in time order", () => {
  const quarters = Array.from({ length: 10 }, (_, i) => quarter(new Date(Date.UTC(2024, 3 * i + 3, 0)).toISOString().slice(0, 10), [["a", "A", 10 + i]]));
  const raw = { schemaVersion: "revenue-history.v1", ticker: "X", updatedAt: "now", quarters: [...quarters].reverse().map(q => ({ ...q, privateNote: "PRIVATE" })), secret: "PRIVATE" };
  const history = readHistory(raw, "X")!;
  assert.equal(history.quarters.length, 8);
  assert.deepEqual(history.quarters.map(q => q.periodEnd), quarters.slice(-8).map(q => q.periodEnd));
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

test("columns stack by business, fall back to company revenue for other presentations, and morph into the selected business", () => {
  const slots = buildSlots(history);
  const all = buildColumns(slots, items, null);
  assert.equal(all[4].state, "basis");
  assert.deepEqual(all[4].layers.map(l => l.key), ["__total"]);
  // A renamed member with the same disclosed business name still lines up.
  assert.deepEqual(all[6].layers.map(l => [l.key, l.value]), [["cloud", 8], ["hw", 1]]);
  const cloud = buildColumns(slots, items, items[0]);
  assert.deepEqual(cloud[7].layers.map(l => [l.key, l.value]), [["apps", 4], ["infra", 7]]);
  assert.equal(cloud[4].layers.length, 0);
  assert.deepEqual(buildColumns(slots, items, items[2])[7].layers.map(l => l.value), [7]);
  assert.deepEqual(layerOrder(items), ["cloud", "apps", "infra", "hw", "__total"]);
  assert.deepEqual(niceTicks(11), [0, 5, 10, 15]);
});
