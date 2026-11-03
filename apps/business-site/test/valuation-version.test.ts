import { test } from "node:test";
import assert from "node:assert/strict";
import { valuationReport } from "../../../scripts/i18n/fixture.ts";
import { versionLoading, versionSettled, versionView, type VersionRead } from "../src/valuation-version.ts";
import type { ValuationPublication } from "../../../shared/analysis-contract/valuation.ts";

const report = (versionId: string): ValuationPublication => ({ ...valuationReport, versionId });
const A = report("a"), B = report("b"), C = report("c");

test("the current version, or no pick, shows the response's report whatever an older read holds", () => {
  assert.deepEqual(versionView(null, A, versionSettled("b", B)), { phase: "ready", report: A });
  assert.deepEqual(versionView("a", A, versionSettled("b", B)), { phase: "ready", report: A });
});

test("switching B -> C while C loads never shows B under C's label", () => {
  let read: VersionRead = versionSettled("b", B);
  assert.deepEqual(versionView("b", A, read), { phase: "ready", report: B });
  // C is picked: the read B finished with is still held for an instant, or already reset to C's loading state.
  assert.deepEqual(versionView("c", A, read), { phase: "loading" });
  read = versionLoading("c");
  assert.deepEqual(versionView("c", A, read), { phase: "loading" });
  // B's read landing late is for another id and still does not show under C.
  assert.deepEqual(versionView("c", A, versionSettled("b", B)), { phase: "loading" });
  read = versionSettled("c", C);
  assert.deepEqual(versionView("c", A, read), { phase: "ready", report: C });
});

test("a failed read shows as failed under its own version, not as the current or the previous report", () => {
  const failed = versionSettled("c", null);
  assert.deepEqual(failed, { id: "c", phase: "failed", report: null });
  assert.deepEqual(versionView("c", A, failed), { phase: "failed" });
  // Picking B again leaves C's failure behind and waits for B's own read.
  assert.deepEqual(versionView("b", A, failed), { phase: "loading" });
});
