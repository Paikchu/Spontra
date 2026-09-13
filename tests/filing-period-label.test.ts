import assert from "node:assert/strict";
import test from "node:test";
import { formatFilingPeriodLabel } from "../lib/earning-report/web/filing-period-label.ts";
import type { PublicSecFiling } from "../shared/analysis-contract/filings.ts";

function filing(report: string): PublicSecFiling {
  return { form: "10-Q", reportDate: "2026-08-31", summary: { report } } as PublicSecFiling;
}

test("uses an explicitly named fiscal quarter instead of the calendar quarter", () => {
  for (const period of ["FY2027一季度", "FY2027 Q1", "2027财年第一季度", "FY2027第1季度"]) {
    assert.equal(formatFilingPeriodLabel(filing(`${period}（截至2026年8月31日）收入增长。`)), "FY2027 Q1");
  }
});

test("does not infer a fiscal quarter from the date or later outlook", () => {
  assert.equal(formatFilingPeriodLabel(filing("本期收入增长。\n\nFY2027 Q2预计增长。")), "2026-08-31 财报");
  const stale = filing("FY2027 Q1收入增长。");
  stale.earningsGroup = { periodEnd: "2026-11-30" } as NonNullable<PublicSecFiling["earningsGroup"]>;
  assert.equal(formatFilingPeriodLabel(stale), "2026-11-30 财报");
});

test("retains form labels for independent events", () => {
  assert.equal(formatFilingPeriodLabel({ ...filing("FY2027 Q1"), form: "8-K" }), "8-K");
});
