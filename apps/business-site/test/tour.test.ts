import assert from "node:assert/strict";
import test from "node:test";
import { tourLayout, readTourDone, reduceTour, shouldAutoOpen, tourKey, writeTourDone, type TourStep } from "../src/tour.ts";

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

test("spotlight and measured coach fit desktops, short laptops, and narrow phones", () => {
  for (const [width, height, mobile] of [[1440, 900, false], [1024, 600, false], [960, 640, true], [390, 600, true], [320, 480, true]] as const) {
    for (const rect of [{ top: 40, left: 20, width: width - 40, height: 1200 }, { top: -90, left: 0, width, height: 300 }, { top: height - 80, left: 20, width: width - 40, height: 60 }]) {
      const { hole, card } = tourLayout(rect, width, height, 190, mobile);
      assert.ok(card.top >= 12 && card.top + card.height <= height - 12);
      if (hole) {
        assert.ok(hole.top >= 8 && hole.top + hole.height <= height - 8);
        assert.ok(hole.top + hole.height <= card.top || hole.top >= card.top + card.height);
      }
    }
  }
  assert.equal(tourLayout({ top: 2000, left: 0, width: 400, height: 100 }, 1024, 600, 190, false).hole, null);
});
