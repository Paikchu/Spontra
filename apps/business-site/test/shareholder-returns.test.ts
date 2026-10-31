import { test } from "node:test";
import assert from "node:assert/strict";
import { buybacksAgainstStockPay, fiscalYearOf, marketCapOf, shareholderReturns } from "../src/shareholder-returns.ts";
import type { FindingFundamentals } from "../../../shared/analysis-runtime/findings.ts";
import type { ValuationResponse } from "../../../shared/analysis-contract/valuation.ts";

/** NVIDIA's figures as SEC companyfacts serves them (USD millions), quarter ends and fiscal years. */
const ENDS = ["2025-04-27", "2025-07-27", "2025-10-26", "2026-01-25", "2026-04-26", "2026-07-26"];
const series = (metricKey: string, quarters: Array<number | null>, annual: Array<[string, string, number]> = []) => ({
  metricKey, label: metricKey, category: "cash_flow", unitFamily: "currency", currency: "USD", available: true,
  points: ENDS.map((periodEnd, i) => ({ periodEnd, valueDecimal: quarters[i] == null ? null : String(quarters[i]! * 1e6) })),
  annual: annual.map(([periodStart, periodEnd, v]) => ({ periodStart, periodEnd, valueDecimal: String(v * 1e6) })),
}) as FindingFundamentals["series"][number];
const FY = (a: number, b: number, c: number): Array<[string, string, number]> => [["2023-01-30", "2024-01-28", a], ["2024-01-29", "2025-01-26", b], ["2025-01-27", "2026-01-25", c]];
const nvda: FindingFundamentals = { series: [
  series("share_repurchases", [14095, 9720, 12456, 3815, 19312, 19732], FY(9533, 33706, 40086)),
  series("dividends_paid", [244, 244, 244, 242, 243, 6000], FY(395, 834, 974)),
  series("free_cash_flow", [26187, 13470, 22115, 34904, 48587, 21400], FY(27021, 60853, 96676)),
  series("stock_based_compensation", [1474, 1624, 1655, 1633, 1928, 2027], FY(3549, 4737, 6386)),
] };

test("R25: NVIDIA's fiscal 2026 returns are the SEC figures: $40.086B of buybacks and $0.974B of dividends", () => {
  const r = shareholderReturns(nvda, "2026-07-26")!;
  assert.deepEqual(r.years.map(y => [y.fiscalYear, y.buybacks, y.dividends]), [[2026, 40086e6, 974e6], [2025, 33706e6, 834e6], [2024, 9533e6, 395e6]]);
  assert.equal(r.years[0]!.total, 41060e6);
  assert.equal(r.years[0]!.ofFreeCashFlow!.toFixed(4), (41060 / 96676).toFixed(4));
  // The four quarters ending at the report.
  assert.deepEqual(r.quarters.map(q => q.periodEnd), ["2025-10-26", "2026-01-25", "2026-04-26", "2026-07-26"]);
  assert.equal(r.ttm.buybacks, (12456 + 3815 + 19312 + 19732) * 1e6);
  assert.equal(r.ttm.dividends, (244 + 242 + 243 + 6000) * 1e6);
  assert.equal(r.yield, null, "no market value, amounts only");
  const against = buybacksAgainstStockPay(r)!;
  assert.equal(against.ratio.toFixed(2), ((12456 + 3815 + 19312 + 19732) / (1655 + 1633 + 1928 + 2027)).toFixed(2));
  // At an earlier report only the years closed by then count.
  assert.deepEqual(shareholderReturns(nvda, "2025-10-26")!.years.map(y => y.fiscalYear), [2025, 2024]);
});

test("R25: an undisclosed figure stays undisclosed, a company with neither shows no card, and yield needs a usable quote", () => {
  const gap = { series: [series("share_repurchases", [1, 1, null, 1, 1, 1]), series("free_cash_flow", [1, 1, 1, 1, 1, 1])] };
  const r = shareholderReturns(gap, "2026-07-26")!;
  assert.equal(r.ttm.buybacks, null);
  assert.equal(r.ttm.dividends, null);
  assert.equal(r.ttm.total, null);
  assert.equal(shareholderReturns({ series: [series("free_cash_flow", [1, 1, 1, 1, 1, 1])] }, "2026-07-26"), null);
  const valuation = (usable: boolean) => ({ availability: "ready", report: { quote: { price: 200, currency: "USD", usable }, model: { shares: { base: 24e9 } } } }) as unknown as ValuationResponse;
  assert.equal(marketCapOf(valuation(true), "USD"), 4.8e12);
  assert.equal(marketCapOf(valuation(false), "USD"), null);
  assert.equal(shareholderReturns(nvda, "2026-07-26", 4.8e12)!.yield!.toFixed(5), (((12456 + 3815 + 19312 + 19732) + (244 + 242 + 243 + 6000)) * 1e6 / 4.8e12).toFixed(5));
  // A fiscal year whose cash flow is filed but whose returns are not tagged still counts among the last three, undisclosed.
  const quiet = { series: [series("share_repurchases", [1, 1, 1, 1, 1, 1], [["2023-01-01", "2023-12-31", 9171]]),
    series("free_cash_flow", [1, 1, 1, 1, 1, 1], [["2023-01-01", "2023-12-31", 29787], ["2024-01-01", "2024-12-31", 11616], ["2025-01-01", "2025-12-31", 25042]])] };
  assert.deepEqual(shareholderReturns(quiet, "2026-06-30")!.years.map(y => [y.fiscalYear, y.buybacks]), [[2025, null], [2024, null], [2023, 9171e6]]);
  assert.equal(fiscalYearOf("2026-01-03"), 2025);
  assert.equal(fiscalYearOf("2025-09-27"), 2025);
});
