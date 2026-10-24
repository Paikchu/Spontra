import { test } from "node:test";
import assert from "node:assert/strict";
import { outstandingAt, ownershipPath, type HoldingPoint } from "../../../shared/analysis-runtime/events.ts";
import type { InsiderTransaction } from "../../../shared/analysis-contract/events.ts";

const filing = (id: string, date: string, held: number, trade: Partial<HoldingPoint> = {}): HoldingPoint =>
  ({ id, date, held, sold: 0, proceeds: 0, bought: 0, cost: 0, exercised: 0, planned: null, ...trade });
const focus = (date: string, heldAfter: number, sold: number | null, bought: number | null) =>
  ({ date, heldAfter, sold: sold == null ? null : { shares: sold, proceeds: 0, averagePrice: 0 }, bought: bought == null ? null : { shares: bought, cost: 0, averagePrice: 0 } }) as InsiderTransaction & { date: string };

test("the share count in force is the latest reported on or before the date, else the earliest", () => {
  const counts = [{ date: "2025-06-30", shares: 200 }, { date: "2025-03-31", shares: 100 }];
  assert.equal(outstandingAt(counts, "2025-05-01"), 100);
  assert.equal(outstandingAt(counts, "2025-06-30"), 200);
  assert.equal(outstandingAt(counts, "2024-01-01"), 100);
  assert.equal(outstandingAt([], "2025-01-01"), null);
});

test("the stake steps at each filing and at each share count between them", () => {
  const path = [filing("a", "2025-01-15", 1_000), filing("b", "2025-08-01", 900, { sold: 100 })];
  const counts = [{ date: "2024-12-31", shares: 100_000 }, { date: "2025-03-31", shares: 80_000 }, { date: "2025-09-30", shares: 50_000 }];
  const own = ownershipPath(path, counts, focus("2025-08-01", 900, 100, null))!;
  // The buyback at 2025-03-31 lifts the stake with no trade; the count after the last filing is outside the window.
  assert.deepEqual(own.path, [
    { date: "2025-01-15", percent: 1, filing: "a" },
    { date: "2025-03-31", percent: 1.25, filing: null },
    { date: "2025-08-01", percent: 1.125, filing: "b" },
  ]);
  assert.equal(own.before, 1.25);
  assert.equal(own.after, 1.125);
  assert.deepEqual(own.outstanding, { date: "2025-03-31", shares: 80_000 });
});

test("a purchase reads its stake before the shares were bought", () => {
  const own = ownershipPath([filing("a", "2025-02-01", 3_000, { bought: 1_000 })], [{ date: "2024-12-31", shares: 100_000 }], focus("2025-02-01", 3_000, null, 1_000))!;
  assert.equal(own.before, 2);
  assert.equal(own.after, 3);
});

test("no share count, no stake: a percent is never estimated", () => {
  assert.equal(ownershipPath([filing("a", "2025-01-01", 10)], [], focus("2025-01-01", 10, 1, null)), null);
  assert.equal(ownershipPath([filing("a", "2025-01-01", 10)], [{ date: "2025-01-01", shares: 0 }], focus("2025-01-01", 10, 1, null)), null);
});
