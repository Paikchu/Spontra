import { test } from "node:test";
import assert from "node:assert/strict";
import type { HomeCompany } from "../../../shared/analysis-contract/home.ts";
import { freshResults } from "../src/fresh-results.ts";
import { parseHomeDigest } from "../src/home-model.ts";

const company = (ticker: string, periodEnd: string, filedAt: string | null, margin: HomeCompany["operatingMargin"] = null): HomeCompany => ({
  ticker, name: ticker, nameZh: null, aliases: [], sector: null, status: "ready",
  latestPeriod: { periodEnd, periodStart: null, fiscalLabel: "2026 Q3", calendarLabel: "2026 Q3", filedAt, fiscalYear: null, fiscalQuarter: null, fiscalYearEndMonth: null, labelSource: "unknown" },
  revenue: { value: "100", currency: "USD", yoyPct: 10, qoqPct: 2 }, revenueReason: null, revenueTrend: [], operatingMargin: margin,
  findingCounts: { risk: 0, strength: 0, shift: 0, watch: 0 }, topFindings: [],
});
const NOW = new Date("2026-10-31T09:00:00Z");

test("R29: reports filed in the last seven days, newest first, with the operating margin's move in points; the card opens the quarter", () => {
  const list = freshResults([
    company("GOOGL", "2026-09-30", "2026-10-29", { pct: 31.81, yearAgoPct: 30.51 }),
    company("AMZN", "2026-09-30", "2026-10-30", { pct: 13.9, yearAgoPct: 9.67 }),
    company("META", "2026-09-30", "2026-10-22", { pct: 20.1, yearAgoPct: 40.07 }),
    company("MSFT", "2026-09-30", "2026-10-25", { pct: 49.76, yearAgoPct: null }),
    company("NVDA", "2026-07-26", "2026-08-26"),
    company("WAIT", "2026-09-30", null),
  ], NOW);
  assert.deepEqual(list.map(r => [r.company.ticker, r.filedAt, r.marginPct, r.marginChangePp]), [
    ["AMZN", "2026-10-30", 13.9, 4.2], ["GOOGL", "2026-10-29", 31.81, 1.3], ["MSFT", "2026-10-25", 49.76, null]]);
  assert.equal(list[1]!.href, "/companies/GOOGL?period=2026-09-30");
  // Seven calendar days, today included: the 24th is out.
  assert.deepEqual(freshResults([company("X", "2026-09-30", "2026-10-24")], NOW), []);
  // No fresh report, no row.
  assert.deepEqual(freshResults([company("NVDA", "2026-07-26", "2026-08-26")], NOW), []);
});

test("R29: the digest reader keeps the operating margin, and a malformed one is dropped rather than failing the company", () => {
  const body = (margin: unknown) => ({ schemaVersion: "home-digest.v1", status: "ready", generatedAt: "2026-10-31T00:00:00Z", coverage: { count: 1, lastUpdatedAt: null }, popular: [],
    companies: [{ ...company("GOOGL", "2026-09-30", "2026-10-29"), operatingMargin: margin }] });
  assert.deepEqual(parseHomeDigest(body({ pct: 31.81, yearAgoPct: 30.51 }))!.companies[0]!.operatingMargin, { pct: 31.81, yearAgoPct: 30.51 });
  assert.deepEqual(parseHomeDigest(body({ pct: 31.81, yearAgoPct: null }))!.companies[0]!.operatingMargin, { pct: 31.81, yearAgoPct: null });
  assert.equal(parseHomeDigest(body({ pct: "x" }))!.companies[0]!.operatingMargin, null);
  assert.equal(parseHomeDigest(body(undefined))!.companies[0]!.operatingMargin, null);
});
