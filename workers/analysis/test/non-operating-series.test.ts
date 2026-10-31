import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCompanyFacts } from "../src/sec/history.ts";
import { buildSecFundamentals } from "../src/fundamentals/sec-fundamentals.ts";
import { readFindingFundamentals } from "../../../shared/analysis-runtime/findings.ts";

/** Alphabet's 10-Q for the quarter to 2026-06-30 (0001652044-26-000071) as Company Facts serves its other income (expense) note. */
const Q2 = { form: "10-Q", accn: "0001652044-26-000071", filed: "2026-07-23", fy: 2026, fp: "Q2" };
const quarterAndHalf = (q: number, h: number) => ({ units: { USD: [{ start: "2026-04-01", end: "2026-06-30", val: q, ...Q2 }, { start: "2026-01-01", end: "2026-06-30", val: h, ...Q2 }] } });
const facts = { facts: { "us-gaap": {
  Revenues: quarterAndHalf(119_796e6, 229_692e6),
  OperatingIncomeLoss: quarterAndHalf(40_770e6, 80_466e6),
  NetIncomeLoss: quarterAndHalf(112_193e6, 174_771e6),
  EquitySecuritiesFvNiGainLoss: quarterAndHalf(99_031e6, 135_946e6),
  InterestIncomeOther: quarterAndHalf(1_430e6, 2_811e6),
  InterestExpenseNonoperating: quarterAndHalf(1_278e6, 1_811e6),
  ForeignCurrencyTransactionGainLossBeforeTax: quarterAndHalf(-160e6, -14e6),
} } };

test("R28: the other income (expense) note's lines reach the fundamentals feed, signed as filed", async () => {
  const response = await buildSecFundamentals(normalizeCompanyFacts("GOOGL", facts), { ticker: "GOOGL", periodCount: 12 } as never, null);
  const series = readFindingFundamentals(response, "GOOGL")!.series;
  const at = (key: string) => series.find(s => s.metricKey === key)?.points.find(p => p.periodEnd === "2026-06-30")?.valueDecimal;
  assert.deepEqual(["equity_securities_gains", "nonoperating_interest_income", "nonoperating_interest_expense", "foreign_exchange_gains", "net_income", "operating_income"].map(at),
    ["99031000000", "1430000000", "1278000000", "-160000000", "112193000000", "40770000000"]);
});
