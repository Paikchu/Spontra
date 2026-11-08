import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RESULT_CHARS, fitResult } from "../src/recipe.ts";

test("a tool result past the limit says it was cut, so a partial result cannot pass for a whole one", () => {
  assert.equal(fitResult("short", 10), "short");
  assert.match(fitResult("x".repeat(30), 10), /Result cut: 20 of 30 characters not shown/);
  assert.match(fitResult("x".repeat(DEFAULT_RESULT_CHARS + 1)), /Result cut: 1 of/);
});
