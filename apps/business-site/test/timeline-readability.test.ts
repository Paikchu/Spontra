import { test } from "node:test";
import assert from "node:assert/strict";
import { readableTicks } from "../src/timeline-model.ts";
test("mobile dates leave room for 12px text while wider timelines retain more dates", () => {
  const ticks = Array.from({ length: 9 }, (_, index) => ({ at: 5 + index * 11 }));
  const mobile = readableTicks(ticks, 358), desktop = readableTicks(ticks, 1000);
  assert(mobile.length >= 3); assert(desktop.length > mobile.length);
  for (const [i, tick] of mobile.entries()) {
    const x = tick.at * 3.58;
    assert(x >= 28 && x <= 330);
    if (i) assert(x - mobile[i - 1].at * 3.58 >= 64);
  }
  assert.deepEqual(readableTicks(ticks, 0), []);
});
