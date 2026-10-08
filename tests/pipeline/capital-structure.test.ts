import test from "node:test";
import assert from "node:assert/strict";
import { SqliteD1Database } from "./helpers/sqlite-d1.ts";
import { extractFilingDisclosures } from "../../shared/analysis-runtime/financial-data/disclosure-extraction.ts";
import { extractFinancialStatements } from "../../shared/analysis-runtime/financial-data/financial-statements.ts";
import { buildCapitalQuarters, CAPITAL_VERSION, extractCapitalFiling, readCapitalStructure } from "../../shared/analysis-runtime/financial-data/capital-structure.ts";
import { archiveFilingDisclosures, listFilingDisclosureAudits } from "../../workers/pipeline/src/financial-data/disclosure-audit.ts";
import { readArchivedCapital } from "../../workers/pipeline/src/financial-data/capital-history.ts";
import type { PublicBusinessFlow } from "../../shared/analysis-contract/business-flow.ts";

const contexts: Record<string, string> = {
  now: "<xbrli:instant>2026-06-30</xbrli:instant>", q1end: "<xbrli:instant>2026-03-31</xbrli:instant>", prior: "<xbrli:instant>2025-12-31</xbrli:instant>",
  h1: "<xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>2026-06-30</xbrli:endDate>",
  q1: "<xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate>",
};
/** A fact displayed in millions. `shown` is the printed text, so a positive payment can be printed in parentheses. */
const n = (name: string, context: string, value: number, shown = value.toLocaleString("en-US")) =>
  `${shown.startsWith("(") ? "(" : ""}<ix:nonFraction name="${name.includes(":") ? name : "us-gaap:" + name}" contextRef="${context}" unitRef="usd" scale="6" decimals="-6" format="ixt:num-dot-decimal"${value < 0 ? ' sign="-"' : ""}>${shown.replace(/[()-]/g, "")}</ix:nonFraction>${shown.startsWith("(") ? ")" : ""}`;
const row = (label: string, ...cells: string[]) => `<tr><td>${label}</td>${cells.map(c => `<td>${c}</td>`).join("")}</tr>`;
const filing = (balance: string, cash: string) => `<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:us-gaap="http://fasb.org/us-gaap/2026" xmlns:crwv="http://example.com/crwv" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:ixt="http://www.xbrl.org/inlineXBRL/transformation/2022-02-16"><ix:header>${Object.entries(contexts).map(([id, period]) => `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0001769628</xbrli:identifier></xbrli:entity><xbrli:period>${period}</xbrli:period></xbrli:context>`).join("")}<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit></ix:header>
<a href="#item_1">Financial Statements</a><a href="#balance">Condensed Consolidated Balance Sheets</a><a href="#cash">Condensed Consolidated Statements of Cash Flows</a><a href="#item_2">Management Discussion</a>
<h2 id="item_1">Item 1. Financial Statements</h2><h3 id="balance">Condensed Consolidated Balance Sheets</h3><p>(in millions)</p><table>${balance}</table>
<h3 id="cash">Condensed Consolidated Statements of Cash Flows</h3><p>(in millions)</p><table>${cash}</table><h2 id="item_2">Management Discussion</h2></html>`;

// No "Total liabilities" row: the boundary is verified by total stockholders' equity. Property is shown gross, less
// accumulated depreciation, then net (an unlabelled subtotal), and the receivables caption quotes an allowance amount.
const balance = (c: string) => [
  row("Assets"),
  row("Cash and cash equivalents", n("CashAndCashEquivalentsAtCarryingValue", c, 500)),
  row(`Accounts receivable, net of allowance of $${n("AllowanceForDoubtfulAccountsReceivableCurrent", c, 7)}`, n("AccountsReceivableNetCurrent", c, 200)),
  row("Total current assets", n("AssetsCurrent", c, 700)),
  row("Property and equipment, at cost", n("PropertyPlantAndEquipmentGross", c, 4000)),
  row("Less: accumulated depreciation", n("AccumulatedDepreciationDepletionAndAmortizationPropertyPlantAndEquipment", c, 1000, "(1,000)")),
  row("Property and equipment, net", n("PropertyPlantAndEquipmentNet", c, 3000)),
  row("Operating lease right-of-use assets", n("OperatingLeaseRightOfUseAsset", c, 300)),
  row("Total assets", n("Assets", c, 4000)),
  row("Liabilities and stockholders' equity"),
  row("Accounts payable", n("AccountsPayableCurrent", c, 150)),
  row("Recourse debt, current", n("crwv:RecourseDebtCurrent", c, 250)),
  row("Deferred revenue, current", n("ContractWithCustomerLiabilityCurrent", c, 100)),
  row("Total current liabilities", n("LiabilitiesCurrent", c, 500)),
  row("Recourse debt, non-current", n("crwv:RecourseDebtNonCurrent", c, 2000)),
  row("Operating lease liabilities, non-current", n("OperatingLeaseLiabilityNoncurrent", c, 320)),
  row("Commitments and contingencies (Note 9)"),
  row("Redeemable noncontrolling interests", n("RedeemableNoncontrollingInterestEquityCarryingAmount", c, 30)),
  row("Additional paid-in capital", n("AdditionalPaidInCapital", c, 1800)),
  row("Accumulated deficit", n("RetainedEarningsAccumulatedDeficit", c, -650, "(650)")),
  row("Total stockholders' equity", n("StockholdersEquity", c, 1150)),
  row("Total liabilities and stockholders' equity", n("LiabilitiesAndStockholdersEquity", c, 4000)),
].join("");

const cashQ1 = [
  row("Cash flows from operating activities:"),
  row("Net loss", n("NetIncomeLoss", "q1", -100, "(100)")),
  row("Depreciation and amortization", n("DepreciationDepletionAndAmortization", "q1", 250)),
  row("Changes in operating assets and liabilities:"),
  row("Deferred revenue", n("IncreaseDecreaseInContractWithCustomerLiability", "q1", 50)),
  row("Net cash provided by operating activities", n("NetCashProvidedByUsedInOperatingActivities", "q1", 200)),
  row("Cash flows from investing activities:"),
  row("Purchase of property and equipment", n("PaymentsToAcquirePropertyPlantAndEquipment", "q1", 900, "(900)")),
  row("Net cash used in investing activities", n("NetCashProvidedByUsedInInvestingActivities", "q1", -900, "(900)")),
  row("Cash flows from financing activities:"),
  row("Proceeds from issuance of debt, net", n("ProceedsFromIssuanceOfLongTermDebt", "q1", 600)),
  row("Proceeds from (repayments of) commercial paper, net", n("ProceedsFromRepaymentsOfCommercialPaper", "q1", 40)),
  row("Issuance of common stock in a private placement", n("ProceedsFromIssuanceOfPrivatePlacement", "q1", 300)),
  row("Net cash provided by financing activities", n("NetCashProvidedByUsedInFinancingActivities", "q1", 940)),
  row("Net increase in cash", n("CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect", "q1", 240)),
  row("Supplemental disclosures:"),
  row("Cash paid for interest", n("InterestPaidNet", "q1", 80)),
].join("");
// Six months: a capped-call row first appears, and commercial paper turns to net repayment.
const cashH1 = [
  row("Cash flows from operating activities:"),
  row("Net loss", n("NetIncomeLoss", "h1", -180, "(180)")),
  row("Depreciation and amortization", n("DepreciationDepletionAndAmortization", "h1", 520)),
  row("Changes in operating assets and liabilities:"),
  row("Deferred revenue", n("IncreaseDecreaseInContractWithCustomerLiability", "h1", 160)),
  row("Net cash provided by operating activities", n("NetCashProvidedByUsedInOperatingActivities", "h1", 500)),
  row("Cash flows from investing activities:"),
  row("Purchase of property and equipment", n("PaymentsToAcquirePropertyPlantAndEquipment", "h1", 2100, "(2,100)")),
  row("Net cash used in investing activities", n("NetCashProvidedByUsedInInvestingActivities", "h1", -2100, "(2,100)")),
  row("Cash flows from financing activities:"),
  row("Proceeds from issuance of debt, net", n("ProceedsFromIssuanceOfLongTermDebt", "h1", 1500)),
  row("Proceeds from (repayments of) commercial paper, net", n("ProceedsFromRepaymentsOfCommercialPaper", "h1", -20, "(20)")),
  row("Purchase of capped calls", n("crwv:PurchaseOfCappedCalls", "h1", 50, "(50)")),
  row("Issuance of common stock in a private placement", n("ProceedsFromIssuanceOfPrivatePlacement", "h1", 400)),
  row("Net cash provided by financing activities", n("NetCashProvidedByUsedInFinancingActivities", "h1", 1830)),
  row("Net increase in cash", n("CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect", "h1", 230)),
  row("Supplemental disclosures:"),
  row("Cash paid for interest", n("InterestPaidNet", "h1", 190)),
  row("Liabilities related to property and equipment additions", n("CapitalExpendituresIncurredButNotYetPaid", "h1", 700)),
].join("");

const q2Source = { accession: "0001769628-26-000366", url: "https://www.sec.gov/Archives/edgar/data/1769628/000176962826000366/crwv-20260630.htm", filedAt: "2026-08-12", form: "10-Q" };
const q1Source = { accession: "0001769628-26-000222", url: "https://www.sec.gov/Archives/edgar/data/1769628/000176962826000222/crwv-20260331.htm", filedAt: "2026-05-12", form: "10-Q" };
const q2Html = filing(balance("now"), cashH1), q1Html = filing(balance("q1end"), cashQ1);
const project = (html: string, source: typeof q2Source, reportDate: string) => extractCapitalFiling(extractFinancialStatements(html, extractFilingDisclosures(html, { ticker: "CRWV", accessionNumber: source.accession, documentUrl: source.url, form: source.form, reportDate, filedAt: source.filedAt })), source);
const values = (lines: Array<{ group: string; value: string }>) => lines.map(l => [l.group, Number(l.value) / 1e6]);

test("balance sheet lines reconcile to the issuer's totals and are grouped by economic role", () => {
  const filing = project(q2Html, q2Source, "2026-06-30");
  assert.deepEqual(filing.issues, []);
  const b = filing.balanceSheet!;
  assert.equal(b.asOf, "2026-06-30");
  // The allowance quoted in the caption is not the receivable; gross and depreciation replace the net subtotal.
  assert.deepEqual(values(b.assets), [["cash", 500], ["receivables", 200], ["productive", 4000], ["productive", -1000], ["leaseAssets", 300]]);
  assert.deepEqual(values(b.liabilities), [["payables", 150], ["debt", 250], ["customerAdvances", 100], ["debt", 2000], ["leases", 320]]);
  assert.deepEqual(values(b.equity), [["redeemable", 30], ["paidIn", 1800], ["retained", -650]]);
  assert.deepEqual(b.totals, { assets: "4000000000", liabilities: "2820000000", equity: "1180000000", currentAssets: "700000000", currentLiabilities: "500000000" });
  assert.equal(b.liabilities[1].concept, "crwv:RecourseDebtCurrent");
});

test("a statement that does not add up is left out, with the failing side named", () => {
  const broken = project(q2Html.replace(">500</ix:nonFraction>", ">510</ix:nonFraction>"), q2Source, "2026-06-30");
  assert.equal(broken.balanceSheet, null);
  assert.ok(broken.issues.includes("BALANCE_SHEET_UNRECONCILED:assets"));
  const unbalanced = project(q2Html.replace("Total stockholders' equity", "Equity subtotal").replace('name="us-gaap:StockholdersEquity"', 'name="us-gaap:OtherEquity"'), q2Source, "2026-06-30");
  assert.equal(unbalanced.balanceSheet, null);
});

test("cash flows keep presented signs; the quarter is the six-month statement less the first quarter", () => {
  const h1 = project(q2Html, q2Source, "2026-06-30"), q1 = project(q1Html, q1Source, "2026-03-31");
  const ytd = h1.cashFlow!;
  assert.deepEqual([ytd.periodStart, ytd.periodEnd, ytd.basis], ["2026-01-01", "2026-06-30", "reported"]);
  assert.deepEqual(values(ytd.investing.lines!), [["capex", -2100]]);
  assert.deepEqual(values(ytd.financing.lines!), [["debtIssued", 1500], ["debtRepaid", -20], ["other", -50], ["equityIssued", 400]]);
  assert.deepEqual(values(ytd.operating.lines!), [["netIncome", -180], ["nonCash", 520], ["workingCapital", 160]]);
  assert.deepEqual(values(ytd.supplemental), [["interestPaid", 190], ["unpaidCapex", 700]]);

  const [june, march] = buildCapitalQuarters([q1, h1]);
  assert.equal(march.cashFlow, march.yearToDate);
  const quarter = june.cashFlow!;
  assert.deepEqual([quarter.periodStart, quarter.periodEnd, quarter.basis], ["2026-04-01", "2026-06-30", "derived"]);
  assert.deepEqual([quarter.operating.total, quarter.investing.total, quarter.financing.total, quarter.netChange].map(Number), [300e6, -1200e6, 890e6, -10e6]);
  // The capped-call row was not presented in March and counts as zero there; net commercial paper flips to a repayment.
  assert.deepEqual(values(quarter.financing.lines!), [["debtIssued", 900], ["debtRepaid", -60], ["other", -50], ["equityIssued", 100]]);
  assert.deepEqual(values(quarter.supplemental), [["interestPaid", 110], ["unpaidCapex", 700]]);
  assert.deepEqual(quarter.sources.map(s => s.accession), [q2Source.accession, q1Source.accession]);
});

test("a row that disappears means the presentation changed; only totals are derived", () => {
  const h1 = project(q2Html.replace(/<tr><td>Issuance of common stock[\s\S]*?<\/tr>/, ""), q2Source, "2026-06-30");
  assert.equal(h1.cashFlow!.financing.lines, null, "rows that no longer add up to the reported total are not published");
  assert.ok(h1.issues.includes("CASH_FLOW_FINANCING_LINES_UNRECONCILED"));
  const regrouped = project(q2Html.replace("Issuance of common stock in a private placement", "Other financing").replace("ProceedsFromIssuanceOfPrivatePlacement", "ProceedsFromPaymentsForOtherFinancingActivities"), q2Source, "2026-06-30");
  const q1 = project(q1Html, q1Source, "2026-03-31");
  const quarter = buildCapitalQuarters([q1, regrouped])[0].cashFlow!;
  assert.equal(quarter.financing.lines, null);
  assert.equal(Number(quarter.financing.total), 890e6);
});

test("public reader re-checks every identity and drops tampered statements without repairing them", () => {
  const quarters = buildCapitalQuarters([project(q1Html, q1Source, "2026-03-31"), project(q2Html, q2Source, "2026-06-30")]);
  const capital = { schemaVersion: "capital-structure.v1", ticker: "CRWV", quarters };
  assert.deepEqual(readCapitalStructure(JSON.parse(JSON.stringify(capital)), "CRWV")?.quarters.map(q => q.periodEnd), ["2026-06-30", "2026-03-31"]);
  assert.equal(readCapitalStructure(capital, "MSFT"), null);
  const tampered = JSON.parse(JSON.stringify(capital));
  tampered.quarters[0].balanceSheet.assets[0].value = "1";
  tampered.quarters[0].cashFlow.financing.lines[0].value = "1";
  const read = readCapitalStructure(tampered, "CRWV")!;
  assert.equal(read.quarters[0].balanceSheet, null);
  assert.equal(read.quarters[0].cashFlow, null);
  assert.ok(read.quarters[0].yearToDate);
});

function archiveFixture() {
  const database = new SqliteD1Database();
  database.raw.exec("CREATE TABLE sec_cache(cache_key TEXT PRIMARY KEY,payload TEXT,fetched_at TEXT)");
  const objects = new Map<string, string>();
  const bucket = { get: async (key: string) => objects.has(key) ? { text: async () => objects.get(key)! } : null, put: async (key: string, value: string) => { objects.set(key, value); } };
  return { database, objects, env: { DB: database as unknown as D1Database, SEC_FILINGS: bucket } };
}
const flow: PublicBusinessFlow = { schemaVersion: "business-flow.v1", ticker: "CRWV", fetchedAt: null, quarters: [{ id: "2026-06-30", label: "", periodStart: "2026-04-01", periodEnd: "2026-06-30", periodType: "3M", currency: "USD", scale: 1, basisLabel: "", reportedAt: null, figures: {}, segments: [], segmentsComplete: false, sources: [{ id: q2Source.accession, title: "", url: q2Source.url }] }] };
const dataSource = (s: typeof q2Source) => ({ url: s.url, accession: s.accession, cik: "0001769628", filedAt: s.filedAt, industry: "standard" as const });

test("archiving stores the capital projection; the read API serves reconciled quarters without exposing it in audit summaries", async () => {
  const f = archiveFixture();
  try {
    await archiveFilingDisclosures(f.env, "CRWV", dataSource(q1Source), q1Html, { form: "10-Q", reportDate: "2026-03-31" });
    await archiveFilingDisclosures(f.env, "CRWV", dataSource(q2Source), q2Html, { form: "10-Q", reportDate: "2026-06-30" });
    const stored = (f.database.raw.prepare("SELECT payload FROM sec_cache").all() as Array<{ payload: string }>).map(r => JSON.parse(r.payload));
    assert.ok(stored.every(r => r.capital?.version === CAPITAL_VERSION && r.capital.balanceSheet && r.capital.cashFlow));
    assert.ok((await listFilingDisclosureAudits(f.env.DB, "CRWV")).every(summary => !("capital" in summary)));
    const capital = await readArchivedCapital(f.env.DB, f.env.SEC_FILINGS, flow);
    assert.deepEqual(capital?.quarters.map(q => [q.periodEnd, q.cashFlow?.basis]), [["2026-06-30", "derived"], ["2026-03-31", "reported"]]);
    assert.deepEqual(readCapitalStructure(JSON.parse(JSON.stringify(capital)), "CRWV"), capital);
  } finally { f.database.close(); }
});

test("archives from before the projection are projected on read without writing back", async () => {
  const f = archiveFixture();
  try {
    await archiveFilingDisclosures(f.env, "CRWV", dataSource(q2Source), q2Html, { form: "10-Q", reportDate: "2026-06-30" });
    const record = f.database.raw.prepare("SELECT cache_key,payload FROM sec_cache").get() as { cache_key: string; payload: string };
    const old = JSON.parse(record.payload);
    delete old.capital;
    f.database.raw.prepare("UPDATE sec_cache SET payload=? WHERE cache_key=?").run(JSON.stringify(old), record.cache_key);
    const objects = f.objects.size;
    const capital = await readArchivedCapital(f.env.DB, f.env.SEC_FILINGS, flow);
    assert.equal(capital?.quarters[0].balanceSheet?.totals.assets, "4000000000");
    assert.equal(capital?.quarters[0].cashFlow, null, "no adjacent first-quarter archive, so no quarterly bridge");
    assert.equal(f.objects.size, objects);
    assert.ok(!("capital" in JSON.parse((f.database.raw.prepare("SELECT payload FROM sec_cache").get() as { payload: string }).payload)));
  } finally { f.database.close(); }
});

// A foreign issuer's 6-K exhibit without XBRL: periods come from the printed header, and note references are not amounts.
const untagged = `<a href="#bs">Unaudited Condensed Consolidated Balance Sheets</a><a href="#ops">Unaudited Condensed Consolidated Statements of Operations</a><a href="#cf">Unaudited Condensed Consolidated Statements of Cash Flows</a><a href="#notes">Notes to the Financial Statements</a>
<h2 id="bs">Unaudited Condensed Consolidated Balance Sheets</h2><p>(In millions of U.S. dollars (“$”), except share data)</p><table>
<tr><td>\u200b</td><td></td><td colspan="3">As of</td></tr>
<tr><td></td><td></td><td>December 31,</td><td></td><td>June 30,</td></tr>
<tr><td></td><td>Notes</td><td>2025</td><td></td><td>2026</td></tr>
<tr><td>ASSETS</td></tr>
<tr><td>Cash and cash equivalents</td><td>4</td><td>3,678.1</td><td></td><td>8,042.1</td></tr>
<tr><td>Property and equipment, net</td><td>7</td><td>5,553.3</td><td></td><td>13,045.2</td></tr>
<tr><td>Goodwill</td><td>3, 9</td><td>—</td><td></td><td>605.6</td></tr>
<tr><td>TOTAL ASSETS</td><td></td><td>9,231.4</td><td></td><td>21,692.9</td></tr>
<tr><td>Debt, non-current</td><td>12</td><td>4,103.2</td><td></td><td>8,499.0</td></tr>
<tr><td>Total liabilities</td><td></td><td>4,103.2</td><td></td><td>8,499.0</td></tr>
<tr><td>Shareholders’ equity:</td></tr>
<tr><td>Treasury shares at cost</td><td></td><td>(1,075.7)</td><td></td><td>(782.1)</td></tr>
<tr><td>Additional paid-in capital</td><td></td><td>2,903.4</td><td></td><td>10,244.7</td></tr>
<tr><td>Retained earnings</td><td></td><td>3,300.5</td><td></td><td>3,731.3</td></tr>
<tr><td>Total shareholders' equity</td><td></td><td>5,128.2</td><td></td><td>13,193.9</td></tr>
<tr><td>TOTAL LIABILITIES AND SHAREHOLDERS’ EQUITY</td><td></td><td>9,231.4</td><td></td><td>21,692.9</td></tr></table>
<h2 id="ops">Statements of Operations</h2><table><tr><td>Revenues</td><td>582.3</td></tr></table>
<h2 id="cf">Unaudited Condensed Consolidated Statements of Cash Flows</h2><p>(In millions of U.S. dollars (“$”))</p><table>
<tr><td></td><td></td><td colspan="3">Six months ended June 30,</td></tr>
<tr><td></td><td>Notes</td><td>2025</td><td></td><td>2026</td></tr>
<tr><td>CASH FLOWS PROVIDED BY OPERATING ACTIVITIES:</td></tr>
<tr><td>Net income from continuing operations</td><td></td><td>398.2</td><td></td><td>430.8</td></tr>
<tr><td>Changes in operating assets and liabilities:</td></tr>
<tr><td>Deferred revenue</td><td></td><td>3.0</td><td></td><td>4,073.3</td></tr>
<tr><td>Net cash provided by operating activities from continuing operations</td><td></td><td>401.2</td><td></td><td>4,504.1</td></tr>
<tr><td>Net cash used in operating activities from discontinued operations</td><td></td><td>(17.1)</td><td></td><td>—</td></tr>
<tr><td>Net cash provided by operating activities</td><td></td><td>384.1</td><td></td><td>4,504.1</td></tr>
<tr><td>CASH FLOWS USED IN INVESTING ACTIVITIES:</td></tr>
<tr><td>Purchases of property and equipment</td><td></td><td>(1,054.5)</td><td></td><td>(8,130.3)</td></tr>
<tr><td>Net cash used in investing activities</td><td></td><td>(1,054.5)</td><td></td><td>(8,130.3)</td></tr>
<tr><td>CASH FLOWS PROVIDED BY FINANCING ACTIVITIES:</td></tr>
<tr><td>Proceeds from issuance of convertible notes</td><td>12</td><td>1,000.0</td><td></td><td>4,337.5</td></tr>
<tr><td>Proceeds from sale of treasury shares</td><td></td><td>—</td><td></td><td>2,846.7</td></tr>
<tr><td>Net cash provided by financing activities</td><td></td><td>1,000.0</td><td></td><td>7,184.2</td></tr>
<tr><td>Net change in cash and cash equivalents</td><td></td><td>329.6</td><td></td><td>3,558.0</td></tr>
<tr><td>Cash and cash equivalents, beginning of period</td><td></td><td>2,450.3</td><td></td><td>3,721.6</td></tr></table>
<h2 id="notes">Notes</h2><p>Policies.</p>`;
const nbis = { accession: "0001104659-26-094844", url: "https://www.sec.gov/Archives/edgar/data/1513845/000110465926094844/nbis-20260812xex99d2.htm", filedAt: "2026-08-12", form: "6-K" };

test("statements filed without XBRL are read from the dated header columns and reconciled the same way", () => {
  const filing = extractCapitalFiling(extractFinancialStatements(untagged, extractFilingDisclosures(untagged, { ticker: "NBIS", accessionNumber: nbis.accession, documentUrl: nbis.url, form: "6-K", reportDate: "2026-08-12", filedAt: nbis.filedAt })), nbis);
  assert.deepEqual(filing.issues, []);
  const b = filing.balanceSheet!;
  assert.equal(b.asOf, "2026-06-30");
  assert.deepEqual(values(b.assets), [["cash", 8042.1], ["productive", 13045.2], ["intangibles", 605.6]]);
  assert.deepEqual(values(b.equity), [["paidIn", -782.1], ["paidIn", 10244.7], ["retained", 3731.3]]);
  assert.equal(b.assets[0].concept, "");
  const c = filing.cashFlow!;
  assert.deepEqual([c.periodStart, c.periodEnd, Number(c.operating.total)], ["2026-01-01", "2026-06-30", 4504.1e6]);
  assert.deepEqual(values(c.operating.lines!), [["netIncome", 430.8], ["workingCapital", 4073.3]]);
  assert.deepEqual(values(c.financing.lines!), [["debtIssued", 4337.5], ["equityIssued", 2846.7]]);
  assert.deepEqual(c.supplemental, [], "opening cash is a balance, not a supplemental flow");
  // Without a stated unit nothing is read.
  const unstated = untagged.replace(/\(In millions of U\.S\. dollars[^)]*\)/g, "");
  const blank = extractCapitalFiling(extractFinancialStatements(unstated, extractFilingDisclosures(unstated, { ticker: "NBIS", accessionNumber: nbis.accession, documentUrl: nbis.url, form: "6-K", reportDate: "", filedAt: nbis.filedAt })), nbis);
  assert.equal(blank.balanceSheet, null);
  assert.ok(blank.issues.includes("BALANCE_SHEET_UNTAGGED_UNIT_NOT_STATED"));
});

test("a member-tagged segment subtotal printed on the face statement is a subtotal, not the total", () => {
  const segmented = balance("now").replace(row("Total current assets", n("AssetsCurrent", "now", 700)), row("", n("Assets", "now", 700).replace('contextRef="now"', 'contextRef="segment"')));
  const html = filing(segmented, cashH1).replace("</ix:header>", '<xbrli:context id="segment"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0001769628</xbrli:identifier><xbrli:segment><xbrldi:explicitMember xmlns:xbrldi="http://xbrl.org/2006/xbrldi" dimension="us-gaap:StatementBusinessSegmentsAxis">crwv:CloudMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>2026-06-30</xbrli:instant></xbrli:period></xbrli:context></ix:header>');
  const b = project(html, q2Source, "2026-06-30").balanceSheet!;
  assert.equal(b.totals.assets, "4000000000");
  assert.equal(b.totals.currentAssets, null);
});

test("the read path includes a foreign issuer's 6-K statement exhibit, dated by its statements rather than its filing date", async () => {
  const f = archiveFixture();
  try {
    await archiveFilingDisclosures(f.env, "NBIS", { url: nbis.url, accession: nbis.accession, cik: "0001513845", filedAt: nbis.filedAt, industry: "standard" }, untagged, { form: "6-K", reportDate: "2026-08-12" });
    const nbisFlow = { ...flow, ticker: "NBIS", quarters: [{ ...flow.quarters[0], sources: [{ id: nbis.accession, title: "", url: nbis.url }] }] };
    const capital = await readArchivedCapital(f.env.DB, f.env.SEC_FILINGS, nbisFlow);
    assert.deepEqual(capital?.quarters.map(q => [q.periodEnd, Boolean(q.balanceSheet), q.yearToDate?.periodStart]), [["2026-06-30", true, "2026-01-01"]]);
  } finally { f.database.close(); }
});

test("a share-class caption hundreds of characters long is shortened, so the statement still passes the public reader", () => {
  const caption = "Ordinary shares: par value (Class A €0.01, Class B €0.10); shares authorized " + "and issued as of each date, ".repeat(20);
  const long = untagged.replace("Additional paid-in capital", caption);
  const filing = extractCapitalFiling(extractFinancialStatements(long, extractFilingDisclosures(long, { ticker: "NBIS", accessionNumber: nbis.accession, documentUrl: nbis.url, form: "6-K", reportDate: "", filedAt: nbis.filedAt })), nbis);
  assert.equal(filing.balanceSheet!.equity[1].label, "Ordinary shares");
  const read = readCapitalStructure({ schemaVersion: "capital-structure.v1", ticker: "NBIS", quarters: buildCapitalQuarters([filing]) }, "NBIS");
  assert.ok(read?.quarters[0].balanceSheet);
});
