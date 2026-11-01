import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEventSubmissions } from "../src/events/workflow.ts";

test("the 24-month event window includes its UTC boundary in every timezone", () => {
  const payload = { filings: { recent: {
    accessionNumber: ["0001104659-24-000002", "0001104659-24-000001"],
    form: ["8-K", "8-K"],
    filingDate: ["2024-03-09", "2024-03-08"],
  } } };
  const now = new Date("2026-03-09T23:30:00Z");
  const originalTimezone = process.env.TZ;
  try {
    const included = ["UTC", "America/Los_Angeles"].map(timezone => {
      process.env.TZ = timezone;
      return parseEventSubmissions(payload, 1104659, now).map(filing => filing.filingDate);
    });
    assert.deepEqual(included[0], ["2024-03-09"], "include the boundary and exclude the previous day in UTC");
    assert.deepEqual(included[1], included[0], "DST must not shift the UTC filing cutoff in America/Los_Angeles");
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});
