import assert from "node:assert/strict";
import test from "node:test";
import { readTourDone, reduceTour, shouldAutoOpen, tourKey, writeTourDone, type TourStep } from "../src/tour.ts";

test("a first visit auto-opens and a finished or webdriver visit does not", () => {
  assert.equal(shouldAutoOpen({ done: false, webdriver: false, force: false }), true);
  assert.equal(shouldAutoOpen({ done: true, webdriver: false, force: false }), false);
  assert.equal(shouldAutoOpen({ done: true, webdriver: false, force: true }), false);
  assert.equal(shouldAutoOpen({ done: false, webdriver: true, force: false }), false);
  assert.equal(shouldAutoOpen({ done: false, webdriver: true, force: true }), true);
});

test("done is stored as bv-tour-done and a broken store stays closed", () => {
  const storage = new Map<string, string>();
  const box = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) };
  assert.equal(readTourDone(box), false);
  writeTourDone(box);
  assert.equal(storage.get("bv-tour-done"), "1");
  assert.equal(readTourDone(box), true);
  assert.equal(readTourDone({ getItem: () => { throw new Error("blocked"); } }), false);
  assert.doesNotThrow(() => writeTourDone({ setItem: () => { throw new Error("blocked"); } }));
});

test("keyboard and buttons walk three steps, then finish or skip", () => {
  assert.equal(tourKey("ArrowRight"), "next");
  assert.equal(tourKey("Enter"), "next");
  assert.equal(tourKey("ArrowLeft"), "back");
  assert.equal(tourKey("Escape"), "skip");
  assert.equal(tourKey("Tab"), null);
  let step: TourStep = 0;
  assert.deepEqual(reduceTour(step, "back"), { type: "stay" });
  const forward = reduceTour(step, "next");
  assert.deepEqual(forward, { type: "step", step: 1 });
  step = 1;
  assert.deepEqual(reduceTour(step, "back"), { type: "step", step: 0 });
  step = 2;
  assert.deepEqual(reduceTour(step, "next"), { type: "done" });
  assert.deepEqual(reduceTour(1, "skip"), { type: "skip" });
});
