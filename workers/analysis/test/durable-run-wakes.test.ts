import { test } from "node:test";
import assert from "node:assert/strict";
import { BUSY_STALE_MS, isBusy, lostWake } from "../src/durable-runs/wakes.ts";
import { within } from "../src/pi/within.ts";

test("a busy mark from a cancelled invocation stops counting, so the run is not held by it", () => {
  assert.equal(isBusy(0, 1000), false);
  assert.equal(isBusy(1000, 1000 + BUSY_STALE_MS - 1), true);
  assert.equal(isBusy(1000, 1000 + BUSY_STALE_MS), false);
});

test("a run with no wake pending, or one that never fired, has lost its wake", () => {
  assert.equal(lostWake(null, 1000), true);
  assert.equal(lostWake(5000, 1000), false, "a future wake stands");
  assert.equal(lostWake(1000, 30_000), false, "a wake just due is left to fire");
  assert.equal(lostWake(1000, 120_000), true);
});

test("a wait returns on time even when the awaited promise never settles and ignores its signal", async () => {
  assert.equal(await within(5, () => new Promise<string>(() => undefined)), null);
  assert.equal(await within(1000, async () => "done"), "done");
  assert.equal(await within(5, (signal) => new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))))), null);
  await assert.rejects(within(1000, async () => { throw new Error("real"); }), /real/);
});
