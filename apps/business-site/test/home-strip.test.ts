import assert from "node:assert/strict";
import { test } from "node:test";
import { stripBandPath, stripOf } from "../src/home-strip.ts";

test("a profitable quarter splits revenue into cost, other expenses and net income", () => {
  const strip = stripOf({ currency: "USD", revenue: "100", cost: "40", net: "25" }, 120, 40);
  assert.ok(strip);
  assert.deepEqual(strip.bands.map(b => [b.kind, b.sh]), [["cost", 16], ["other", 14], ["net", 10]]);
  assert.equal(strip.loss, null);
  assert.match(stripBandPath(strip.bands[0]!, strip), /^M5,0 C60,0 60,0 115,0 L115,16/);
});

test("a loss fills the right stack with expenses and hangs the loss below", () => {
  const strip = stripOf({ currency: "USD", revenue: "100", cost: "70", net: "-30" }, 120, 40);
  assert.ok(strip);
  assert.deepEqual(strip.bands.map(b => [b.kind, b.sh]), [["cost", 28], ["other", 12]]);
  assert.deepEqual(strip.loss, { y: 40, h: 12 });
});

test("no cost figure leaves everything but profit as other; no revenue draws nothing", () => {
  const strip = stripOf({ currency: "USD", revenue: "100", cost: null, net: "30" }, 120, 40);
  assert.deepEqual(strip?.bands.map(b => [b.kind, b.sh]), [["other", 28], ["net", 12]]);
  assert.equal(stripOf({ currency: "USD", revenue: "0", cost: null, net: "1" }), null);
});
