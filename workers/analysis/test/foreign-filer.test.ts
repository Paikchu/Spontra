import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readStatementTableFacts } from "../src/financial-data/statement-table.ts";
import { extractDisclosedQuarters, readReportedFacts, type DocumentSource } from "../src/financial-data/parser.ts";
import { readSecDocumentBatch, reportsFinancials, type SecReader } from "../src/financial-data/provider.ts";
import { readRevenueHistory, runHistoryStep } from "../src/financial-data/history.ts";
import { checkCompleteFlow, checkCompleteQuarter, newestPair } from "../../../shared/analysis-runtime/financial-data/completeness.ts";
import { parseFilingDocument } from "../../../shared/analysis-runtime/filing-library/parse.ts";
import { compactMoney } from "../../../shared/analysis-runtime/locale.ts";

// TSMC (CIK 0001046179) files a 20-F under IFRS in NT$ and furnishes its quarterly statements as non-XBRL 6-K exhibits.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/tsm/${name}`, import.meta.url), "utf8");
const CIK = "0001046179", FOLDER = "https://www.sec.gov/Archives/edgar/data/1046179/";
const report = fixture("a2026q2consolidatedreport-.htm"), cover = fixture("tsm-fsx20260814x6k.htm"), notice = fixture("tsm-revenue20261008.htm"), annual = fixture("tsm-20251231-income.htm");
const source: DocumentSource = { url: FOLDER + "000104617926000541/a2026q2consolidatedreport-.htm", accession: "0001046179-26-000541", filedAt: "2026-08-14", cik: CIK, industry: "standard" };
const thousands = (n: number) => n * 1000;

test("an IFRS statement of comprehensive income is read in the currency its title names", () => {
  const facts = readStatementTableFacts(report, source);
  const at = (tag: string, start: string, end: string) => facts.find(f => f.tag === tag && f.start === start && f.end === end && !f.operands)?.value;
  assert.ok(facts.length && facts.every(f => f.currency === "TWD"));
  assert.equal(at("table:Revenues", "2026-04-01", "2026-06-30"), thousands(1_270_380_250));
  assert.equal(at("table:CostOfRevenue", "2026-04-01", "2026-06-30"), thousands(410_069_555));
  assert.equal(at("table:Revenues", "2025-04-01", "2025-06-30"), thousands(933_791_869));
  assert.equal(at("table:Revenues", "2026-01-01", "2026-06-30"), thousands(2_404_483_690));
  assert.equal(at("table:IncomeTaxExpenseBenefit", "2026-04-01", "2026-06-30"), thousands(155_649_163));
  const firstQuarter = facts.find(f => f.tag === "table:Revenues" && f.start === "2026-01-01" && f.end === "2026-03-31");
  assert.equal(firstQuarter?.value, thousands(2_404_483_690 - 1_270_380_250));
  assert.ok(firstQuarter?.operands?.length === 2);
});

test("a statement whose title names an unknown currency is not read, and never as USD", () => {
  assert.deepEqual(readStatementTableFacts(report.replace("New Taiwan Dollars", "Brazilian Reais"), source), []);
  assert.deepEqual(readStatementTableFacts(report.replace("(In Thousands of New Taiwan Dollars, Except Earnings Per Share)", ""), source), []);
  const usd = readStatementTableFacts(report.replace("New Taiwan Dollars", "U.S. Dollars"), source);
  assert.ok(usd.length && usd.every(f => f.currency === "USD"));
});

test("TSMC's second quarter is a complete NT$ quarter whose operating bridge keeps other operating income", () => {
  const { quarters, issues } = extractDisclosedQuarters(report, source);
  assert.deepEqual(issues, []);
  assert.deepEqual(quarters.map(q => q.periodEnd).sort(), ["2025-03-31", "2025-06-30", "2026-03-31", "2026-06-30"]);
  for (const q of quarters) {
    assert.equal(q.currency, "TWD");
    assert.deepEqual(checkCompleteQuarter(q), { complete: true, reasons: [] });
  }
  const q2 = quarters.find(q => q.periodEnd === "2026-06-30")!;
  assert.equal(q2.figures.revenue?.value, String(thousands(1_270_380_250)));
  assert.equal(q2.figures.cost?.value, String(thousands(410_069_555)));
  assert.equal(q2.figures.gross?.value, String(thousands(860_310_695)));
  assert.equal(q2.figures.operating?.value, String(thousands(766_602_651)));
  // Gross profit − operating income; the printed 98,982,083 total leaves other operating income outside it.
  assert.equal(q2.figures.operatingExpenses?.value, String(thousands(93_708_044)));
  assert.deepEqual(q2.expenseComponents?.map(c => [c.name, c.group, c.amount.value]), [
    ["Research and development", "research", String(thousands(73_146_138))],
    ["General and administrative", "administration", String(thousands(21_366_992))],
    ["Marketing", "sales", String(thousands(4_468_953))],
    ["Other operating income and expenses, net", "other", String(thousands(-5_274_039))],
  ]);
  assert.equal(q2.figures.net?.value, String(thousands(706_780_923)));
});

test("a 20-F reads IFRS concepts in its presentation currency; the US$ convenience translation is dropped", () => {
  const annualSource: DocumentSource = { url: FOLDER + "000162828026025362/tsm-20251231.htm", accession: "0001628280-26-025362", filedAt: "2026-04-16", cik: CIK, industry: "standard" };
  assert.match(annual, /unitRef="usd"[^>]*name="ifrs-full:RevenueFromContractsWithCustomers"/);
  const { facts, issues } = readReportedFacts(annual, annualSource);
  assert.deepEqual(issues, []);
  assert.deepEqual([...new Set(facts.map(f => f.currency))], ["TWD"]);
  const revenue = facts.filter(f => f.tag === "ifrs-full:RevenueFromContractsWithCustomers" && f.end === "2025-12-31");
  assert.deepEqual([...new Set(revenue.map(f => f.value))], [3_809_054_300_000]);
  assert.ok(["CostOfSales", "ProfitLossFromOperatingActivities", "ProfitLossBeforeTax", "IncomeTaxExpenseContinuingOperations"].every(name => facts.some(f => f.tag === "ifrs-full:" + name)));
  // Annual periods alone make no quarter.
  assert.equal(extractDisclosedQuarters(annual, annualSource).quarters.length, 0);
});

test("a 6-K reports financials only when its exhibits are statements, results or an earnings release", () => {
  assert.equal(reportsFinancials("6-K", cover), true);
  assert.equal(reportsFinancials("6-K", notice), false);
  assert.equal(reportsFinancials("6-K", '<table><tr><td>99.1</td><td>Press release issued on July 16, 2026.</td></tr><tr><td>99.2</td><td>2026 Second Quarter Earnings Conference Presentation Material.</td></tr></table>'), true);
  assert.equal(reportsFinancials("6-K", '<table><tr><td>99.1</td><td>Press release announcing a joint venture.</td></tr></table>'), false);
  assert.equal(reportsFinancials("10-Q", notice), true);
});

/** SEC submissions for the three filings the fixtures cover, newest first, with the notice ahead of the report. */
const submissions = {
  cik: CIK, sic: "3674",
  filings: { recent: {
    form: ["6-K", "6-K", "20-F"], accessionNumber: ["0001046179-26-000680", "0001046179-26-000541", "0001628280-26-025362"],
    primaryDocument: ["tsm-revenue20261008.htm", "tsm-fsx20260814x6k.htm", "tsm-20251231.htm"], filingDate: ["2026-10-08", "2026-08-14", "2026-04-16"], reportDate: ["2026-09-30", "2026-06-30", "2025-12-31"],
  } },
};
const documents: Record<string, string> = {
  "000104617926000680/tsm-revenue20261008.htm": notice, "000104617926000541/tsm-fsx20260814x6k.htm": cover,
  "000104617926000541/a2026q2consolidatedreport-.htm": report, "000162828026025362/tsm-20251231.htm": annual,
};
function fixtureReader() {
  const archived: string[] = [];
  const reader: SecReader = {
    read: async url => {
      if (url === `https://data.sec.gov/submissions/CIK${CIK}.json`) return Response.json(submissions);
      const html = documents[url.slice(FOLDER.length)];
      if (!html) throw new Error("unexpected read " + url);
      return new Response(html);
    },
    archive: async s => { archived.push(s.url.slice(FOLDER.length)); },
  };
  return { reader, archived };
}

test("a foreign issuer's scan passes over 6-K notices and publishes the NT$ pair from the quarterly report", async () => {
  const { reader, archived } = fixtureReader();
  const batch = await readSecDocumentBatch({ cik: CIK, ticker: "TSM", cursor: "" } as Parameters<typeof readSecDocumentBatch>[0], reader, 2);
  assert.equal(batch.finished, true);
  assert.equal(batch.expectedPeriodEnd, "2026-06-30");
  const cursor = JSON.parse(batch.nextCursor);
  assert.equal(cursor.reports, 1);
  // The notice is archived like any filing but not parsed.
  assert.deepEqual(archived, ["000104617926000680/tsm-revenue20261008.htm", "000104617926000541/tsm-fsx20260814x6k.htm", "000104617926000541/a2026q2consolidatedreport-.htm"]);
  const flow = newestPair({ schemaVersion: "business-flow.v1", ticker: "TSM", fetchedAt: null, quarters: batch.quarters });
  assert.deepEqual(flow.quarters.map(q => [q.periodEnd, q.currency]), [["2026-06-30", "TWD"], ["2026-03-31", "TWD"]]);
  assert.deepEqual(checkCompleteFlow(flow), { complete: true, reasons: [] });
});

/** sec_cache alone, the one table the revenue history reads and writes. */
function cacheDb() {
  const rows = new Map<string, { payload: string; fetchedAt: string }>();
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => /SELECT payload/.test(sql) ? rows.get(String(args[0])) ?? null : null,
    run: async () => { if (/INSERT INTO sec_cache/.test(sql)) rows.set(String(args[0]), { payload: String(args[1]), fetchedAt: String(args[2]) }); return { success: true }; },
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

test("revenue history reads the NT$ quarters and records no issue for a 6-K notice", async () => {
  const db = cacheDb(), { reader } = fixtureReader();
  let step;
  for (let i = 0; i < 5; i++) {
    step = await runHistoryStep(db, reader, { ticker: "TSM", cik: CIK }, new Date("2026-10-15T00:00:00Z"));
    if (step.finished) break;
  }
  assert.equal(step?.finished, true);
  assert.ok(!step!.issues.some(issue => issue.startsWith("0001046179-26-000680")), step!.issues.join());
  assert.ok(!step!.issues.some(issue => issue.startsWith("0001046179-26-000541")), step!.issues.join());
  const history = await readRevenueHistory(db, CIK, "TSM");
  const q2 = history?.quarters.find(q => q.periodEnd === "2026-06-30");
  assert.equal(q2?.currency, "TWD");
  assert.equal(q2?.revenue, String(thousands(1_270_380_250)));
});

test("a 6-K cover in the filing library has no item structure to miss", () => {
  const doc = parseFilingDocument(cover, { documentId: "tsm-6k", accessionNumber: "0001046179-26-000541", documentUrl: FOLDER + "000104617926000541/tsm-fsx20260814x6k.htm", form: "6-K" });
  assert.equal(doc.docType, "primary");
  assert.ok(!doc.issues.includes("ITEMS_NOT_FOUND"));
  const eightK = parseFilingDocument(cover.replace(/FORM 6-K/g, "FORM 8-K"), { documentId: "x-8k", accessionNumber: "0001046179-26-000541", documentUrl: FOLDER + "000104617926000541/x.htm", form: "8-K" });
  assert.ok(eightK.issues.includes("ITEMS_NOT_FOUND"));
});

test("NT$ amounts are written with their own symbol", () => {
  assert.equal(compactMoney(1_270_380_250_000, "TWD"), "NT$1.3T");
  assert.equal(compactMoney(-5_274_039_000, "TWD"), "−NT$5.3B");
});
