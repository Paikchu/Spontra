import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEarningsGroups } from "../src/sec/earnings.ts";
import type { SecFiling } from "../src/sec/sec.ts";

const filing = (accessionNumber: string, form: string, filingDate: string) => ({ accessionNumber, form, filingDate, ticker: "NBIS" }) as SecFiling;

test("a period's canonical report is the original periodic filing, not a later amendment of it", () => {
  const filings = [filing("a-20fa", "20-F/A", "2026-05-22"), filing("a-20f", "20-F", "2026-04-30"), filing("a-6k", "6-K", "2026-02-12")];
  const periods = new Map(filings.map(f => [f.accessionNumber, "2025-12-31"]));
  const grouped = buildEarningsGroups(filings, periods);
  assert.deepEqual(grouped.map(f => f.earningsGroup?.canonicalAccession), ["a-20f", "a-20f", "a-20f"]);
  assert.equal(grouped[0]!.earningsGroup!.inputKey, "a-20f+a-20fa+a-6k");
});

test("a periodic filing still outranks the earnings release, and the newest original wins", () => {
  const filings = [filing("q-new", "10-Q", "2026-08-01"), filing("q-old", "10-Q", "2026-07-30"), filing("k8", "8-K", "2026-07-28")];
  const grouped = buildEarningsGroups(filings, new Map(filings.map(f => [f.accessionNumber, "2026-06-30"])));
  assert.equal(grouped[0]!.earningsGroup!.canonicalAccession, "q-new");
});
