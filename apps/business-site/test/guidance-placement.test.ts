import assert from "node:assert/strict";
import { test } from "node:test";
import { placeGuidance } from "../src/FlowChart.tsx";

const bounds = { x0: 0, y0: 0, x1: 500, y1: 300 };
const beside = { x0: 150, y0: 50, x1: 350, y1: 110 };
const below = { x0: 120, y0: 150, x1: 320, y1: 210 };
test("guidance stays beside a clear node, moves below a label, and uses a marker when both collide", () => {
  assert.deepEqual(placeGuidance(beside, below, [], bounds), beside);
  const label = { x0: 130, y0: 40, x1: 400, y1: 70 };
  assert.deepEqual(placeGuidance(beside, below, [label], bounds), below);
  assert.equal(placeGuidance(beside, below, [label, below], bounds), null);
  assert.equal(placeGuidance({ ...beside, x1: 501 }, { ...below, y1: 301 }, [], bounds), null);
});
