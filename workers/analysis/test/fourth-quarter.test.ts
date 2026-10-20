import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { RevenueHistoryQuarter } from "../../../shared/analysis-contract/revenue-history.ts";
import { deriveFourthQuarters } from "../src/financial-data/history.ts";
import type { DocumentSource, Fact } from "../src/financial-data/parser.ts";
import { extractRevenueHistory } from "../src/financial-data/revenue-parser.ts";

const millions = (n: number) => n * 1e6;

// JPMorgan's 8-K Exhibit 99.2 supplement heads its quarterly columns "4Q25 3Q25 2Q25 1Q25 4Q24" and dates them only in
// its footnotes ("for the three months ended December 31, 2025, September 30, 2025, ...").
const jpm = readFileSync(new URL("./fixtures/releases/jpm-4q25-supplement.htm", import.meta.url), "utf8");
const jpmSource = (filedAt: string): DocumentSource => ({ url: "https://www.sec.gov/Archives/edgar/data/19617/000162828026001902/a4q25erfex992supplement.htm", accession: "0001628280-26-001902", filedAt, cik: "0000019617", industry: "financial" });
const periods = (html: string, src: DocumentSource) => extractRevenueHistory(html, src, "8-K").quarters.map(q => [q.periodStart, q.periodEnd, Number(q.revenue)]);

test("quarter-code columns are dated back from the newest quarter the document dates itself", () => {
  assert.deepEqual(periods(jpm, jpmSource("2026-01-13")), [
    ["2024-10-01", "2024-12-31", millions(42_768)],
    ["2025-01-01", "2025-03-31", millions(45_310)],
    ["2025-04-01", "2025-06-30", millions(44_912)],
    ["2025-07-01", "2025-09-30", millions(46_427)],
    ["2025-10-01", "2025-12-31", millions(45_798)],
  ]);
});

test("quarter codes stay undated without a dated quarter, or when the codes name another fiscal year", () => {
  // Filed long after its quarter: the footnote dates no recent quarter.
  assert.deepEqual(periods(jpm, jpmSource("2026-07-13")), []);
  // A quarter end that makes "4Q25" fall in fiscal 2026 contradicts the codes.
  assert.deepEqual(periods(jpm.replace("three months ended December 31, 2025", "three months ended September 30, 2026"), jpmSource("2026-10-14")), []);
});

test("a summary of income statement data, or a table printing two revenue totals, is not a statement", () => {
  assert.deepEqual(periods(jpm.replace("CONSOLIDATED STATEMENTS OF INCOME", "SELECTED INCOME STATEMENT DATA"), jpmSource("2026-01-13")), []);
  // The supplement's highlights page prints reported and managed-basis revenue under the same label.
  const managed = jpm.replace(/(<tr><td colspan="3">TOTAL NET REVENUE<\/td>.*)/, (row: string) => `${row}\n${row.replace("45,798", "46,767")}`);
  assert.notEqual(managed, jpm);
  assert.deepEqual(periods(managed, jpmSource("2026-01-13")), []);
});

// Berkshire Hathaway's releases print no statement of operations; its fourth quarter is the 10-K's year less the
// nine months in the same fiscal year's third-quarter 10-Q. Amounts are the filings' us-gaap:Revenues facts.
const BRK = "0001067983";
const filing = (accession: string, filedAt: string): DocumentSource => ({ url: `https://www.sec.gov/Archives/edgar/data/1067983/${accession.replaceAll("-", "")}/brka.htm`, accession, filedAt, cik: BRK, industry: "insurance" });
const tenK = filing("0001193125-26-083899", "2026-03-02"), tenQ = filing("0001193125-25-261548", "2025-11-03");
const fact = (source: DocumentSource, start: string, end: string, value: number, context: string): Fact => ({ source, tag: "us-gaap:Revenues", value, currency: "USD", start, end, context, dimensions: {}, precision: -6 });
const annual = fact(tenK, "2025-01-01", "2025-12-31", millions(371_444), "FY2025");
const nine = fact(tenQ, "2025-01-01", "2025-09-30", millions(277_212), "9M2025");
const quarter = (start: string, end: string, revenue: number, accession: string): RevenueHistoryQuarter => {
  const lineage = [{ accession, url: filing(accession, "2025-11-03").url, concept: "us-gaap:Revenues", contextId: start, periodStart: start, periodEnd: end, dimensions: {}, parserVersion: "deterministic-sec.v15" }];
  return { periodStart: start, periodEnd: end, currency: "USD", scale: 1, revenue: String(millions(revenue)), basis: "reported", lineage, segments: [{ id: "total", name: "Total", value: String(millions(revenue)), lineage }], source: { accession, url: lineage[0].url, filedAt: "2025-11-03", form: "10-Q" } };
};
const history = [
  quarter("2025-01-01", "2025-03-31", 89_725, "0000950170-25-063112"),
  quarter("2025-04-01", "2025-06-30", 92_515, "0000950170-25-101578"),
  quarter("2025-07-01", "2025-09-30", 94_972, "0001193125-25-261548"),
];

test("a 10-K year less its fiscal year's 10-Q nine months is a fourth quarter when the nine months equal the quarters on record", () => {
  const [q4, ...rest] = deriveFourthQuarters([annual, nine], BRK, history);
  assert.equal(rest.length, 0);
  assert.deepEqual([q4.periodStart, q4.periodEnd, Number(q4.revenue), q4.basis, q4.source.form, q4.source.accession], ["2025-10-01", "2025-12-31", millions(94_232), "derived", "10-K", tenK.accession]);
  assert.match(q4.formula ?? "", /third-quarter report \(0001193125-25-261548\)/);
  assert.deepEqual(new Set(q4.lineage?.map(l => l.accession)), new Set([tenK.accession, tenQ.accession]));
});

test("the cross-filing bridge is refused unless it is shown to hold", () => {
  // The history lacks a quarter of the nine months.
  assert.deepEqual(deriveFourthQuarters([annual, nine], BRK, history.slice(1)), []);
  // The quarters on record do not add up to the nine months.
  assert.deepEqual(deriveFourthQuarters([annual, { ...nine, value: millions(277_000) }], BRK, history), []);
  // A different concept or dimensions is not the same amount.
  assert.deepEqual(deriveFourthQuarters([annual, { ...nine, tag: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" }], BRK, history), []);
  assert.deepEqual(deriveFourthQuarters([annual, { ...nine, dimensions: { "us-gaap:StatementBusinessSegmentsAxis": "brka:RailroadMember" } }], BRK, history), []);
  // A later filing reports the nine months differently: one of the presentations was recast.
  const recast = fact(filing("0001193125-26-500000", "2026-11-02"), "2025-01-01", "2025-09-30", millions(276_900), "9M2025-recast");
  assert.deepEqual(deriveFourthQuarters([annual, nine, recast], BRK, history), []);
  // A 10-Q filed after the 10-K is not the third-quarter report the year was closed against.
  assert.deepEqual(deriveFourthQuarters([annual, { ...nine, source: { ...tenQ, filedAt: "2026-03-03" } }], BRK, history), []);
});

test("an operating-segments total beside the consolidated total, or a recast of another line, leaves the bridge standing", () => {
  // BRK.B tags the segments' sum with ConsolidationItemsAxis = OperatingSegmentsMember; it is a different amount.
  const segments = { "srt:ConsolidationItemsAxis": "us-gaap:OperatingSegmentsMember" };
  const segmentYear = { ...fact(tenK, "2025-01-01", "2025-12-31", millions(368_372), "FY2025-segments"), dimensions: segments };
  const segmentNine = { ...fact(tenQ, "2025-01-01", "2025-09-30", millions(274_998), "9M2025-segments"), dimensions: segments };
  // A prior year's product grouping regrouped in a later filing is another line.
  const product = { "srt:ProductOrServiceAxis": "brka:InsuranceAndOtherMember" };
  const regrouped = [
    { ...fact(tenQ, "2024-01-01", "2024-09-30", millions(239_104), "9M2024-product"), dimensions: product },
    { ...fact(filing("0000950170-24-120241", "2024-11-04"), "2024-01-01", "2024-09-30", millions(203_004), "9M2024-product-old"), dimensions: product },
  ];
  const quarters = deriveFourthQuarters([annual, nine, segmentYear, segmentNine, ...regrouped], BRK, history);
  assert.deepEqual(quarters.map(q => [q.periodEnd, Number(q.revenue)]), [["2025-12-31", millions(94_232)]]);
});
