import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCompanyFacts } from "../src/sec/history.ts";
import { buildSecFundamentals } from "../src/fundamentals/sec-fundamentals.ts";
import { readFindingFundamentals } from "../../../shared/analysis-runtime/findings.ts";

/** A companyfacts payload with NVIDIA's fiscal 2025–2026 figures as SEC serves them (USD, positive payments). */
const fact = (start: string, end: string, val: number, form: string, accn: string, filed: string) => ({ start, end, val, form, accn, filed });
const K26 = ["0001045810-26-000021", "2026-02-25"] as const, K25 = ["0001045810-25-000023", "2025-02-26"] as const;
const Q = (n: number) => [`0001045810-25-00010${n}`, `2025-0${n + 4}-20`] as const;
const facts = (dividendConcept: string) => ({ facts: { "us-gaap": {
  Revenues: { units: { USD: [fact("2025-10-27", "2026-01-25", 68127e6, "10-K", ...K26)] } },
  PaymentsForRepurchaseOfCommonStock: { units: { USD: [
    fact("2024-01-29", "2025-01-26", 33706e6, "10-K", ...K25), fact("2025-01-27", "2026-01-25", 40086e6, "10-K", ...K26),
    fact("2025-01-27", "2025-04-27", 14095e6, "10-Q", ...Q(1)), fact("2025-01-27", "2025-07-27", 23815e6, "10-Q", ...Q(2)), fact("2025-01-27", "2025-10-26", 36271e6, "10-Q", ...Q(3)),
  ] } },
  [dividendConcept]: { units: { USD: [
    fact("2024-01-29", "2025-01-26", 834e6, "10-K", ...K25), fact("2025-01-27", "2026-01-25", 974e6, "10-K", ...K26),
    fact("2025-01-27", "2025-04-27", 244e6, "10-Q", ...Q(1)), fact("2025-01-27", "2025-07-27", 488e6, "10-Q", ...Q(2)), fact("2025-01-27", "2025-10-26", 732e6, "10-Q", ...Q(3)),
  ] } },
} } });

for (const concept of ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"]) test(`R25: buybacks and dividends (${concept}) reach the fundamentals feed by quarter and by fiscal year`, async () => {
  const response = await buildSecFundamentals(normalizeCompanyFacts("NVDA", facts(concept)), { ticker: "NVDA", periodCount: 12 } as never, null);
  const series = readFindingFundamentals(response, "NVDA")!.series;
  const buybacks = series.find(s => s.metricKey === "share_repurchases")!, dividends = series.find(s => s.metricKey === "dividends_paid")!;
  assert.deepEqual(buybacks.annual, [
    { periodStart: "2024-01-29", periodEnd: "2025-01-26", valueDecimal: "33706000000", sourceAccession: K25[0] },
    { periodStart: "2025-01-27", periodEnd: "2026-01-25", valueDecimal: "40086000000", sourceAccession: K26[0] }]);
  assert.deepEqual(dividends.annual?.map(p => p.valueDecimal), ["834000000", "974000000"]);
  // The fourth quarter is the fiscal year less nine months; the others difference the year-to-date facts.
  assert.deepEqual(buybacks.points.filter(p => p.valueDecimal != null).map(p => [p.periodEnd, Number(p.valueDecimal)]),
    [["2025-04-27", 14095e6], ["2025-07-27", 9720e6], ["2025-10-26", 12456e6], ["2026-01-25", 3815e6]]);
  assert.deepEqual(dividends.points.filter(p => p.valueDecimal != null).map(p => Number(p.valueDecimal)), [244e6, 244e6, 244e6, 242e6]);
});

test("R25: a reader built before the new series keeps reading the feed, leaving unknown series out", () => {
  const body = { ticker: "NVDA", source: "sec_xbrl", status: "ready", series: [
    { metricKey: "total_revenue", label: "Revenue", category: "income_statement", unitFamily: "currency", currency: "USD", available: true, points: [] },
    { metricKey: "a_future_metric", label: "Later", category: "cash_flow", unitFamily: "currency", currency: "USD", available: true, points: [] },
  ] };
  assert.deepEqual(readFindingFundamentals(body, "NVDA")?.series.map(s => s.metricKey), ["total_revenue"]);
});
