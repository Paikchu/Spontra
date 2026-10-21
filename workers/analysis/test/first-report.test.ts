import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocumentSource, Fact } from "../src/financial-data/parser.ts";
import { reviewedCurrentPair } from "../src/financial-data/period-review.ts";

// A newly listed issuer's first 10-Q (SpaceX, June 2026 quarter): the second quarter and six months to date, no earlier report.
const source: DocumentSource = { url: "https://www.sec.gov/Archives/edgar/data/1181412/000162828026052535/spcx-20260630.htm", accession: "0001628280-26-052535", filedAt: "2026-08-04", cik: "0001181412", industry: "standard" };
const lines: Array<[string, number, number]> = [
  ["us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", 7814, 12508],
  ["us-gaap:CostOfRevenue", 3495, 6000],
  ["us-gaap:GrossProfit", 4319, 6508],
  ["us-gaap:OperatingExpenses", 4462, 9600],
  ["us-gaap:OperatingIncomeLoss", -143, -3092],
  ["us-gaap:NonoperatingIncomeExpense", -375, -1600],
  ["us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", -518, -4692],
  ["us-gaap:IncomeTaxExpenseBenefit", 23, 125],
  ["us-gaap:NetIncomeLoss", -541, -4817],
];
const fact = (tag: string, start: string, value: number, context: string): Fact => ({ source, tag, value: value * 1e6, currency: "USD", start, end: "2026-06-30", context, dimensions: {}, precision: -6 });
const facts = lines.flatMap(([tag, quarter, sixMonths]) => [fact(tag, "2026-04-01", quarter, "c-q2"), fact(tag, "2026-01-01", sixMonths, "c-6m")]);
const documents = [{ source, eligible: true }];

test("a first quarterly report pairs its quarter with the quarter before, as six months less the quarter", () => {
  const review = reviewedCurrentPair(facts, "2026-06-30", documents, {}, null, {}, true);
  assert.equal(review.reviewed, true);
  const [current, previous] = review.quarters;
  assert.deepEqual([current.periodStart, current.periodEnd, current.figures.revenue?.basis], ["2026-04-01", "2026-06-30", "reported"]);
  assert.deepEqual([previous.periodStart, previous.periodEnd, previous.figures.revenue?.basis], ["2026-01-01", "2026-03-31", "derived"]);
  assert.equal(previous.figures.revenue?.value, String(4694e6));
  assert.equal(previous.figures.net?.value, String(-4276e6));
  assert.equal(previous.figures.revenue?.comparabilityKey, current.figures.revenue?.comparabilityKey);
});

test("an issuer with earlier reports takes the quarter before from its own report", () => {
  assert.deepEqual(reviewedCurrentPair(facts, "2026-06-30", documents, {}, null, {}, false), { quarters: [], reviewed: false });
});
