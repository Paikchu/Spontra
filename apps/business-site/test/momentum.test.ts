import { test } from "node:test";
import assert from "node:assert/strict";
import { growthMomentum, momentumOf, yoyPoints } from "../src/momentum.ts";

/** NVIDIA's quarterly revenue as SEC reports it (USD millions). */
const NVDA: Array<[string, number]> = [["2024-04-28", 26044], ["2024-07-28", 30040], ["2024-10-27", 35082], ["2025-01-26", 39331], ["2025-04-27", 44062],
  ["2025-07-27", 46743], ["2025-10-26", 57006], ["2026-01-25", 68127], ["2026-04-26", 81615], ["2026-07-26", 96221]];
const values = (rows: Array<[string, number | null]>) => rows.map(([periodEnd, value]) => ({ periodEnd, value }));
const yoy = (rates: number[], from = 2025) => rates.map((r, i) => ({ periodEnd: `${from + Math.floor((i * 3 + 1) / 12)}-${String(((i * 3 + 1) % 12) + 1).padStart(2, "0")}-28`, yoy: r }));

test("R26: NVIDIA's revenue growth 55.6% → 62.5% → 85.2% → 105.9% reads as accelerating", () => {
  assert.equal(growthMomentum(yoy([55.6, 62.5, 85.2, 105.9]))?.kind, "accelerating");
  const points = yoyPoints(values(NVDA));
  assert.deepEqual(points.map(p => [p.periodEnd, Number(p.yoy!.toFixed(1))]),
    [["2025-04-27", 69.2], ["2025-07-27", 55.6], ["2025-10-26", 62.5], ["2026-01-25", 73.2], ["2026-04-26", 85.2], ["2026-07-26", 105.9]]);
  const m = momentumOf(values(NVDA))!;
  assert.equal(m.kind, "accelerating");
  assert.deepEqual(m.points.map(p => p.periodEnd), ["2025-07-27", "2025-10-26", "2026-01-25", "2026-04-26", "2026-07-26"]);
  // At an earlier quarter on the stage: 69.2% → 55.6% → 62.5% neither rises nor falls twice running.
  assert.equal(momentumOf(values(NVDA), "2025-10-26"), null);
});

test("R26: two falls in a row slow, a positive-to-negative turn is red and wins, flat or mixed growth carries no tag", () => {
  assert.equal(growthMomentum(yoy([30, 20, 10]))?.kind, "slowing");
  assert.equal(growthMomentum(yoy([30, 20, 10, -2]))?.kind, "turnedNegative");
  assert.equal(growthMomentum(yoy([5, 3]))?.kind, undefined);
  assert.equal(growthMomentum(yoy([10, 20, 15])), null);
  assert.equal(growthMomentum(yoy([10, 10.02, 10.04])), null);
});

test("R26: a missing quarter in the run gives no verdict", () => {
  const gap = NVDA.map(([d, v]): [string, number | null] => [d, d === "2026-01-25" ? null : v]);
  assert.equal(momentumOf(values(gap)), null);
  // Missing from the list altogether is the same gap.
  assert.equal(momentumOf(values(NVDA.filter(([d]) => d !== "2026-01-25"))), null);
  // A year-ago base at or below zero has no growth to compare.
  const loss = NVDA.map(([d, v]): [string, number] => [d, d === "2025-04-27" ? -5 : v]);
  assert.equal(yoyPoints(values(loss)).find(p => p.periodEnd === "2026-04-26")?.yoy, null);
});
