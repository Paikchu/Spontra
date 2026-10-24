import { test } from "node:test";
import assert from "node:assert/strict";
import { outstandingAt, stakeChange } from "../../../shared/analysis-runtime/events.ts";
import type { InsiderTransaction } from "../../../shared/analysis-contract/events.ts";

const trade = (heldAfter: number | null, sold: number | null, bought: number | null) =>
  ({ heldAfter, sold: sold == null ? null : { shares: sold, proceeds: 0, averagePrice: 0 }, bought: bought == null ? null : { shares: bought, cost: 0, averagePrice: 0 } }) as InsiderTransaction;
const counts = [{ date: "2025-06-30", shares: 200_000 }, { date: "2025-03-31", shares: 100_000 }];

test("the share count in force is the latest reported on or before the date, else the earliest", () => {
  assert.deepEqual(outstandingAt(counts, "2025-05-01"), { date: "2025-03-31", shares: 100_000 });
  assert.deepEqual(outstandingAt(counts, "2025-06-30"), { date: "2025-06-30", shares: 200_000 });
  assert.deepEqual(outstandingAt(counts, "2024-01-01"), { date: "2025-03-31", shares: 100_000 });
  assert.equal(outstandingAt([], "2025-01-01"), null);
});

test("a sale reads the stake before and after over the share count in force", () => {
  assert.deepEqual(stakeChange(trade(1_500, 500, null), counts, "2025-08-01"), { before: 1, after: 0.75, outstanding: { date: "2025-06-30", shares: 200_000 } });
});

test("a purchase reads its stake before the shares were bought", () => {
  assert.deepEqual(stakeChange(trade(3_000, null, 1_000), counts, "2025-04-15"), { before: 2, after: 3, outstanding: { date: "2025-03-31", shares: 100_000 } });
});

test("no share count or no disclosed holding, no stake: a percent is never estimated", () => {
  assert.equal(stakeChange(trade(10, 1, null), [], "2025-01-01"), null);
  assert.equal(stakeChange(trade(10, 1, null), [{ date: "2025-01-01", shares: 0 }], "2025-01-01"), null);
  assert.equal(stakeChange(trade(null, 1, null), counts, "2025-08-01"), null);
});
