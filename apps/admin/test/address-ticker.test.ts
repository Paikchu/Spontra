import { test } from "node:test";
import assert from "node:assert/strict";
import { addressTicker } from "../src/address-ticker.ts";

test("the whitelist reads the company it was opened for from its address", () => {
  assert.equal(addressTicker("?ticker=NVDA"), "NVDA");
  assert.equal(addressTicker("?ticker=%20brk.b%20&view=x"), "BRK.B");
  assert.equal(addressTicker(""), "");
  assert.equal(addressTicker("?view=x"), "");
});
