import { test } from "node:test";
import assert from "node:assert/strict";
import type { RevenueHistory, RevenueHistoryQuarter } from "../../../shared/analysis-contract/revenue-history.ts";
import { basisChangedAt, basisRuns, businessValue, sameBasis, segmentBasis, yearAgoOnBasis } from "../../../shared/analysis-runtime/segment-basis.ts";
import { buildBridge, buildColumns, buildSlots, growthSeries, type TrendItem } from "../src/trend-model.ts";

/** Microsoft's revenue history as served for 2026-10-31 (USD): three segments, then from the quarter to 2026-09-30 two, the year-ago quarter restated in that 10-Q. */
const NEW = "0001193125-26-436133";
const q = (periodEnd: string, accession: string, segments: Array<[string, string, number]>): RevenueHistoryQuarter => ({
  periodStart: "", periodEnd, currency: "USD", scale: 1, revenue: String(segments.reduce((s, x) => s + x[2], 0)), basis: "reported",
  segments: segments.map(([id, name, value]) => ({ id, name, value: String(value) })), source: { accession, url: "", filedAt: "", form: "10-Q" } });
const OLD = (pbp: number, ic: number, mpc: number): Array<[string, string, number]> => [["msft:ProductivityAndBusinessProcessesMember", "Productivity and Business Processes", pbp], ["msft:IntelligentCloudMember", "Intelligent Cloud", ic], ["msft:MorePersonalComputingMember", "More Personal Computing", mpc]];
const MSFT: RevenueHistory = { schemaVersion: "revenue-history.v1", ticker: "MSFT", updatedAt: "", quarters: [
  q("2025-03-31", "0001193125-26-191507", OLD(29_944e6, 26_751e6, 13_371e6)),
  q("2025-06-30", "0001193125-26-323632", [["reported-company-total", "Total company (segment split not yet verified)", 76_441e6]]),
  q("2025-09-30", NEW, [["msft:AgentsAndInfraMember", "Agents and Infra", 61_672e6], ["msft:DevicesAndConsumerMember", "Devices and Consumer", 16_001e6]]),
  q("2025-12-31", "0001193125-26-027207", OLD(34_116e6, 32_907e6, 14_250e6)),
  q("2026-03-31", "0001193125-26-191507", OLD(35_013e6, 34_681e6, 13_192e6)),
  q("2026-06-30", "0001193125-26-323632", [["reported-company-total", "Total company (segment split not yet verified)", 90_007e6]]),
  q("2026-09-30", NEW, [["filing-agents-and-infra", "Agents and Infra", 76_795e6], ["filing-devices-and-consumer", "Devices and Consumer", 15_484e6]]),
] };
const NOW = MSFT.quarters.at(-1)!.segments;

test("B6: Microsoft's quarter to 2026-09 is re-based; the year-ago quarter restated in its own 10-Q is on the new basis", () => {
  assert.equal(segmentBasis(NOW), "agentsandinfra|devicesandconsumer");
  assert.equal(segmentBasis(MSFT.quarters[1]!.segments), null);
  // Member ids and filing ids name the same business.
  assert.equal(sameBasis(NOW, MSFT.quarters[2]!.segments), true);
  assert.equal(sameBasis(NOW, MSFT.quarters[4]!.segments), false);
  assert.equal(basisChangedAt(MSFT, "2026-09-30"), true);
  assert.equal(basisChangedAt(MSFT, "2026-03-31"), false);
  const base = yearAgoOnBasis(MSFT, "2026-09-30", NOW, "USD")!;
  assert.deepEqual([base.quarter.periodEnd, base.restatedInFiling], ["2025-09-30", true]);
  assert.equal(businessValue(base.quarter, NOW[0]!), 61_672e6);
  // Agents and Infra +24.5%, Devices and Consumer −3.2%, on the restated basis.
  assert.deepEqual(NOW.map(s => Number((Number(s.value) / businessValue(base.quarter, s)! * 100 - 100).toFixed(1))), [24.5, -3.2]);
  // On the earlier basis the year-ago quarter is that 10-Q's own comparative.
  const old = yearAgoOnBasis(MSFT, "2026-03-31", MSFT.quarters[4]!.segments, "USD")!;
  assert.deepEqual([old.quarter.periodEnd, old.restatedInFiling], ["2025-03-31", true]);
  assert.equal(yearAgoOnBasis({ ...MSFT, quarters: MSFT.quarters.map(x => x.periodEnd === "2025-03-31" ? { ...x, source: { ...x.source, accession: "0000950170-25-061046" } } : x) }, "2026-03-31", MSFT.quarters[4]!.segments, "USD")!.restatedInFiling, false);
  // A year-ago quarter on another basis is no base at all.
  assert.equal(yearAgoOnBasis(MSFT, "2026-09-30", MSFT.quarters[4]!.segments, "USD"), null);
  assert.equal(yearAgoOnBasis(MSFT, "2026-09-30", NOW, "EUR"), null);
  assert.deepEqual(basisRuns(MSFT).filter(r => r.starts).map(r => r.periodEnd), ["2025-09-30", "2025-12-31", "2026-09-30"]);
});

test("B6: the trend never computes a business's growth across a change of basis, and marks the bars on the earlier basis", () => {
  const items: TrendItem[] = NOW.map((s, i) => ({ key: s.id, id: s.id, parent: null, name: s.name, slot: i + 1 }));
  const slots = buildSlots(MSFT, 9);
  const all = buildColumns(slots, items, null);
  assert.deepEqual(all.slice(-5).map(c => [c.slot.periodEnd, c.segmentBasis]), [
    ["2025-09-30", "current"], ["2025-12-31", "earlier"], ["2026-03-31", "earlier"], ["2026-06-30", null], ["2026-09-30", "current"]]);
  // Total revenue grows across any basis: 92.3B on 77.7B.
  assert.equal(Number(growthSeries(all, 4).at(-1)!.toFixed(1)), 18.8);
  const agents = buildColumns(slots, items, items[0]!);
  // Agents and Infra year over year is +24.5% against the restated quarter; quarter over quarter it would cross bases.
  assert.equal(Number(growthSeries(agents, 4, true).at(-1)!.toFixed(1)), 24.5);
  assert.equal(growthSeries(agents, 1, true).at(-1), null);
  // A business named the same on two bases (SpaceX's Space before and after SI replaced AI) is not compared across them.
  const space = (periodEnd: string, third: string, v: number) => q(periodEnd, "a", [["spcx:SpaceMember", "Space", v], ["spcx:ConnectivityMember", "Connectivity", 1], [`spcx:${third}Member`, third, 1]]);
  const spcx: RevenueHistory = { ...MSFT, ticker: "SPCX", quarters: [space("2026-06-30", "AI", 962e6), space("2026-09-30", "SI", 1_767e6)] };
  const spaceItems: TrendItem[] = [{ key: "s", id: "spcx:SpaceMember", parent: null, name: "Space", slot: 1 }, { key: "c", id: "spcx:ConnectivityMember", parent: null, name: "Connectivity", slot: 2 }, { key: "i", id: "spcx:SIMember", parent: null, name: "SI", slot: 3 }];
  const spaceColumns = buildColumns(buildSlots(spcx, 2), spaceItems, spaceItems[0]!);
  assert.equal(growthSeries(spaceColumns, 1, true).at(-1), null);
  assert.equal(buildBridge(spaceColumns, 1, 1), null);
  assert.ok(growthSeries(spaceColumns, 1).at(-1)! > 0);
});
