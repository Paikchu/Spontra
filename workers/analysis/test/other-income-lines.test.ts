import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { BusinessFlowQuarter } from "../../../shared/analysis-contract/business-flow.ts";
import { checkCompleteQuarter } from "../../../shared/analysis-runtime/financial-data/completeness.ts";
import { releaseQuarter } from "../../../shared/analysis-runtime/financial-data/earnings-release.ts";
import { otherFromStatement, type OtherPeriod } from "../src/financial-data/bridge.ts";
import type { IncomeCalculation } from "../src/financial-data/calculation.ts";
import { extractDisclosedQuarters, extractVerifiedCurrentQuarters, SEC_FLOW_PARSER_VERSION, type DocumentSource, type Fact } from "../src/financial-data/parser.ts";
import { fiscalFourthQuarters } from "../src/financial-data/period-review.ts";

// Nebius's statement of operations from its 8-K of August 12, 2026 (Exhibit 99.2): five lines between the loss from
// operations and income before taxes, the revaluation gain on its ClickHouse stake among them, printed "—" in the second quarter.
const nbisHtml = readFileSync(new URL("./fixtures/releases/nbis-q2-2026.htm", import.meta.url), "utf8");
const nbisSource: DocumentSource = { url: "https://www.sec.gov/Archives/edgar/data/1513845/000110465926094844/nbis-20260812xex99d2.htm", accession: "0001104659-26-094844", filedAt: "2026-08-12", cik: "0001513845", industry: "standard" };
const nbis = (html = nbisHtml) => extractDisclosedQuarters(html, nbisSource).quarters;
const lines = (q: BusinessFlowQuarter | undefined) => q?.otherComponents?.map(c => [c.name, Number(c.amount.value) / 1e6]);
const at = (quarters: BusinessFlowQuarter[], end: string) => quarters.find(q => q.periodEnd === end);
const close = (a: number, b: number) => Math.abs(a - b) < 1e-3;

test("each line between operating income and income before taxes is its own component, with the statement's label and sign", () => {
  const quarters = nbis();
  assert.deepEqual(lines(at(quarters, "2026-06-30")), [
    ["Interest income", 24.1], ["Interest expense", -119.1], ["Income / (loss) from equity method investments", 12.7], ["Other income, net", 81.5],
  ]);
  assert.deepEqual(lines(at(quarters, "2025-06-30")), [
    ["Interest income", 3.6], ["Interest expense", -4.8], ["Gain from revaluation of investment in equity securities", 597.4],
    ["Income / (loss) from equity method investments", -6.3], ["Other income, net", 24.6],
  ]);
  for (const q of quarters) {
    assert.ok(checkCompleteQuarter(q).complete, q.periodEnd);
    assert.ok(close(q.otherComponents!.reduce((n, c) => n + Number(c.amount.value), 0), Number(q.figures.other!.value)), q.periodEnd);
    for (const c of q.otherComponents!) assert.equal(c.amount.lineage![0].url, nbisSource.url);
  }
});

test("a first quarter derived as six months less the second subtracts line by line, a printed dash counting as zero", () => {
  const q1 = at(nbis(), "2026-03-31")!;
  const got = lines(q1)!;
  assert.deepEqual(got.map(([name]) => name), ["Interest income", "Interest expense", "Gain from revaluation of investment in equity securities", "Income / (loss) from equity method investments", "Other income, net"]);
  [14.2, -63.7, 780.6, -7.6, 19.9].forEach((v, i) => assert.ok(close(got[i]![1] as number, v), String(got[i])));
  assert.ok(close(Number(q1.figures.other!.value) / 1e6, 743.4));
  const gain = q1.otherComponents!.find(c => /revaluation/.test(c.name))!;
  assert.equal(gain.amount.basis, "derived");
  assert.match(gain.amount.formula!, /six months to date − second quarter/);
});

test("lines that do not balance the total leave one derived total, and the quarter stays complete", () => {
  // Without the second quarter's other income the lines no longer sum to pretax − operating in either quarter.
  const html = nbisHtml.replace(/(Other income, net[\s\S]*?)81\.5/, "$1—");
  for (const end of ["2026-06-30", "2026-03-31"]) {
    const q = at(nbis(html), end)!;
    assert.deepEqual(q.otherComponents!.map(c => c.id), ["reported-net-other"], end);
    assert.ok(checkCompleteQuarter(q).complete);
  }
  // The signs are settled for the whole statement, so every quarter it reports keeps the one total.
  assert.deepEqual(at(nbis(html), "2025-06-30")!.otherComponents!.map(c => c.id), ["reported-net-other"]);
});

const usd = (tag: string, value: number, row: number, label: string, start = "2026-04-01", end = "2026-06-30", accession = "0000000001-26-000002", filedAt = "2026-07-30"): Fact => ({
  source: { url: `https://www.sec.gov/Archives/edgar/data/1/${accession.replaceAll("-", "")}/q.htm`, accession, filedAt, cik: "0000000001", industry: "standard" },
  precision: -6, tag: `us-gaap:${tag}`, value, currency: "USD", start, end, context: `c-${start}-${end}`, dimensions: {}, statementRow: { order: row, label, flip: false },
});
const statement = (scale: number, start?: string, end?: string, accession?: string, filedAt?: string) => {
  const f = (tag: string, v: number, row: number, label: string) => usd(tag, v * scale, row, label, start, end, accession, filedAt);
  return [f("Revenues", 1000, 1, "Revenue"), f("CostOfRevenue", 400, 2, "Cost of revenue"), f("OperatingExpenses", 300, 3, "Total operating expenses"),
    f("OperatingIncomeLoss", 300, 4, "Operating income"), f("InvestmentIncomeInterest", 20, 5, "Interest income"), f("InterestExpenseNonoperating", 50, 6, "Interest expense"),
    f("OtherNonoperatingIncomeExpense", 5, 7, "Other income (expense), net"), f("NonoperatingIncomeExpense", -25, 8, "Total non-operating income (expense)"),
    f("IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", 275, 9, "Income before income taxes"),
    f("IncomeTaxExpenseBenefit", 55, 10, "Provision for income taxes"), f("NetIncomeLoss", 220, 11, "Net income")];
};
const pretaxTag = "us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest";
const calculation: IncomeCalculation = {
  role: "ops", title: "Statements of Operations", root: "us-gaap:NetIncomeLoss", labels: {},
  arcs: [
    { parent: "us-gaap:NetIncomeLoss", child: pretaxTag, weight: 1, order: 1 }, { parent: "us-gaap:NetIncomeLoss", child: "us-gaap:IncomeTaxExpenseBenefit", weight: -1, order: 2 },
    { parent: pretaxTag, child: "us-gaap:OperatingIncomeLoss", weight: 1, order: 1 }, { parent: pretaxTag, child: "us-gaap:NonoperatingIncomeExpense", weight: 1, order: 2 },
    { parent: "us-gaap:NonoperatingIncomeExpense", child: "us-gaap:InvestmentIncomeInterest", weight: 1, order: 1 },
    { parent: "us-gaap:NonoperatingIncomeExpense", child: "us-gaap:InterestExpenseNonoperating", weight: -1, order: 2 },
    { parent: "us-gaap:NonoperatingIncomeExpense", child: "us-gaap:OtherNonoperatingIncomeExpense", weight: 1, order: 3 },
  ] as IncomeCalculation["arcs"],
};

test("the calculation opens the nonoperating total into its lines and signs each toward income before taxes", () => {
  const [q] = extractVerifiedCurrentQuarters({ ...statement(1e6)[0]!.source, calculation }, statement(1e6)).quarters;
  assert.deepEqual(lines(q), [["Interest income", 20], ["Interest expense", -50], ["Other income (expense), net", 5]]);
  const interest = q!.otherComponents![1]!;
  assert.equal(interest.amount.basis, "derived");
  assert.equal(interest.amount.formula, "− reported Interest expense");
  assert.equal(interest.amount.lineage![0].concept, "us-gaap:InterestExpenseNonoperating");
  assert.ok(checkCompleteQuarter(q!).complete);
});

test("without a calculation the statement rows are signed by the arithmetic, the printed subtotal left out", () => {
  const [q] = extractVerifiedCurrentQuarters(statement(1e6)[0]!.source, statement(1e6)).quarters;
  assert.deepEqual(lines(q), [["Interest income", 20], ["Interest expense", -50], ["Other income (expense), net", 5]]);
});

test("statement rows whose signs more than one combination balances give no structure", () => {
  const period = (values: number[], pretax: number): OtherPeriod => {
    const facts = [usd("OperatingIncomeLoss", 100, 1, "Operating income"), ...values.map((v, i) => usd(`Line${i}`, v, 2 + i, `Line ${i}`)), usd("IncomeLossBeforeIncomeTaxes", pretax, 9, "Income before income taxes")];
    return { pick: c => facts.find(f => f.tag === c), operating: facts[0]!, pretax: facts.at(-1)! };
  };
  const one = period([10, 5, 5], 110);
  const rows = (p: OtherPeriod) => ["OperatingIncomeLoss", "Line0", "Line1", "Line2", "IncomeLossBeforeIncomeTaxes"].map(t => p.pick(`us-gaap:${t}`)!);
  assert.equal(otherFromStatement(rows(one), [one]), null);
  // A second period with other amounts settles the signs.
  const second = period([10, 7, 3], 114);
  assert.deepEqual(otherFromStatement([...rows(one), ...rows(second)], [one, second])?.lines.map(l => l.weight), [1, 1, -1]);
});

test("a fiscal fourth quarter subtracts each line of the nine months from the same line of the year", () => {
  const year = statement(4e6, "2025-07-01", "2026-06-30", "0000000001-26-000003", "2026-08-20"), nine = statement(3e6, "2025-07-01", "2026-03-31", "0000000001-26-000001", "2026-04-30");
  // The nine months carry a smaller interest charge, so the fourth quarter's lines differ from a quarter of the year.
  const adjust = (facts: Fact[], tag: string, by: number) => facts.map(f => f.tag === `us-gaap:${tag}` ? { ...f, value: f.value + by } : f);
  const nineMonths = adjust(adjust(adjust(adjust(nine, "InterestExpenseNonoperating", -30e6), "NonoperatingIncomeExpense", 30e6), pretaxTag.slice(8), 30e6), "NetIncomeLoss", 30e6);
  const [q4] = fiscalFourthQuarters(year, nineMonths);
  assert.equal(q4!.periodStart, "2026-04-01");
  assert.deepEqual(lines(q4), [["Interest income", 20], ["Interest expense", -80], ["Other income (expense), net", 5]]);
  assert.ok(q4!.otherComponents!.every(c => /full fiscal year/.test(c.amount.formula ?? "") || c.amount.formula === "− reported Interest expense"));
});

test("an earnings release reads its own lines between operating income and pretax income, and keeps the filings' ids", () => {
  const previous = at(nbis(), "2026-03-31")!;
  const { quarter, issues } = releaseQuarter([{ url: nbisSource.url, html: nbisHtml }], previous, { accession: "0001104659-26-099999", filedAt: "2026-08-12", parserVersion: SEC_FLOW_PARSER_VERSION });
  assert.deepEqual(issues, []);
  assert.deepEqual(lines(quarter!), [["Interest income", 24.1], ["Interest expense", -119.1], ["Income / (loss) from equity method investments", 12.7], ["Other income, net", 81.5]]);
  assert.deepEqual(quarter!.otherComponents!.map(c => c.id), previous.otherComponents!.filter(c => !/Revaluation/.test(c.id)).map(c => c.id));
});
