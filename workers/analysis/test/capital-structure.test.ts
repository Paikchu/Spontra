import { test } from "node:test";
import assert from "node:assert/strict";
import type { CapitalFiling, PublicCapitalStructure } from "../../../shared/analysis-contract/capital-structure.ts";
import type { DisclosureFact, FilingDisclosures } from "../../../shared/analysis-runtime/financial-data/disclosure-extraction.ts";
import type { FinancialStatements } from "../../../shared/analysis-runtime/financial-data/financial-statements.ts";
import { CAPITAL_VERSION, buildCapitalQuarters, extractCapitalFiling, extractSchedules, readCapitalStructure } from "../../../shared/analysis-runtime/financial-data/capital-structure.ts";
import { scheduleAt, scheduleBucketAt, scheduleBucketLabel, scheduleTotalAt } from "../../../shared/analysis-runtime/schedules.ts";

const US_GAAP = "http://fasb.org/us-gaap/2024";
const source = { accession: "0000012345-25-000001", url: "https://www.sec.gov/Archives/edgar/data/12345/x.htm", filedAt: "2025-06-20", form: "10-K" };

type FactInput = { concept: string; value: string; asOf?: string; currency?: string; dimensional?: boolean; status?: DisclosureFact["status"] };
/** An inventory fact as the extractor sees it: a scaled, signed exact decimal on an instant context, in a currency unit. */
function fact({ concept, value, asOf = "2025-05-31", currency = "USD", dimensional = false, status = "parsed" }: FactInput): DisclosureFact {
  const dimensions = dimensional ? [{ kind: "explicit" as const, axis: { name: "us-gaap:StatementBusinessSegmentsAxis", namespaceUri: US_GAAP }, member: { name: "x:CloudMember", namespaceUri: "http://x" }, value: "x:CloudMember", rawHtml: "" }] : [];
  return {
    id: `${concept}@${asOf}${dimensional ? "/dim" : ""}`, concept: { name: `us-gaap:${concept}`, namespaceUri: US_GAAP }, taxonomy: "standard", kind: "numeric", classification: "unclassified",
    contextRef: `c-${asOf}`, context: { id: `c-${asOf}`, entity: null, period: { kind: "instant", start: null, end: asOf }, dimensions, rawHtml: "", locator: { start: 0, end: 0, elementId: null }, issues: [] },
    unitRef: "u", unit: { id: "u", numerator: [{ name: `iso4217:${currency}`, namespaceUri: "http://www.xbrl.org/2003/iso4217" }], denominator: [], rawHtml: "", locator: { start: 0, end: 0, elementId: null }, issues: [] },
    rawValue: value, rawHtml: "", normalizedValue: value, numericValue: value, fraction: null, format: null, scale: "6", sign: value.startsWith("-") ? "-" : null, decimals: "-6", precision: null,
    nil: false, language: null, hidden: false, status, attributes: {}, source: { ticker: "TEST", accessionNumber: source.accession, documentUrl: source.url, form: "10-K", reportDate: "2025-05-31", filedAt: source.filedAt, locator: { start: 0, end: 0, elementId: null }, continuations: [] }, issues: [],
  } as DisclosureFact;
}
const disclosures = (facts: DisclosureFact[]) => ({ facts } as unknown as FilingDisclosures);

const ladder = [
  fact({ concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths", value: "7500000000" }),
  fact({ concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo", value: "8000000000" }),
  fact({ concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalInYearThree", value: "9000000000" }),
  fact({ concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalInYearFour", value: "5500000000" }),
  fact({ concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalInYearFive", value: "6000000000" }),
  fact({ concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalAfterYearFive", value: "68000000000" }),
  fact({ concept: "LongTermDebt", value: "104000000000" }),
  // Last year's ladder restated in the same note, and the carrying amount at that instant, must not win.
  fact({ concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths", value: "6000000000", asOf: "2024-05-31" }),
  fact({ concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo", value: "7000000000", asOf: "2024-05-31" }),
  fact({ concept: "LongTermDebt", value: "90000000000", asOf: "2024-05-31" }),
  // A segment's share of the ladder is a dimensional fact; it is never read as the company's.
  fact({ concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths", value: "1000000000", dimensional: true }),
];
const purchases = [
  fact({ concept: "PurchaseObligationDueInNextTwelveMonths", value: "20000000000" }),
  fact({ concept: "PurchaseObligationDueInSecondYear", value: "15000000000" }),
  fact({ concept: "PurchaseObligationDueInThirdYear", value: "10000000000" }),
  fact({ concept: "PurchaseObligationDueAfterFifthYear", value: "3000000000" }),
  // A total tagged at the same instant publishes with the ladder.
  fact({ concept: "PurchaseObligation", value: "48000000000" }),
];
// One bucket is not a ladder: a filing that tags only next year's lease payments has no schedule.
const oneLeaseBucket = [fact({ concept: "LesseeOperatingLeaseLiabilityPaymentsDueNextTwelveMonths", value: "900000000" }), fact({ concept: "LesseeOperatingLeaseLiabilityPaymentsDue", value: "5000000000" })];

test("a debt ladder and a purchase-obligation schedule are read at the period end; a one-bucket schedule is dropped", () => {
  const schedules = extractSchedules(disclosures([...ladder, ...purchases, ...oneLeaseBucket]), source);
  assert.deepEqual(schedules.map(s => s.kind), ["debtMaturities", "purchaseObligations"]);
  const debt = schedules[0];
  assert.equal(debt.asOf, "2025-05-31");
  assert.equal(debt.currency, "USD");
  assert.equal(debt.total, "104000000000");
  assert.deepEqual(debt.buckets, [
    { from: 0, to: 12, amount: "7500000000" }, { from: 12, to: 24, amount: "8000000000" }, { from: 24, to: 36, amount: "9000000000" },
    { from: 36, to: 48, amount: "5500000000" }, { from: 48, to: 60, amount: "6000000000" }, { from: 60, to: null, amount: "68000000000" },
  ]);
  assert.deepEqual(debt.source, source);
  const purchase = schedules[1];
  assert.equal(purchase.total, "48000000000");
  // Years four and five are not tagged, so they are absent rather than zero; "thereafter" keeps its place.
  assert.deepEqual(purchase.buckets.map(b => [b.from, b.to]), [[0, 12], [12, 24], [24, 36], [60, null]]);
});

test("a ladder tagged at the prior year end only is read at that instant; the total must share it", () => {
  const prior = ladder.filter(f => f.context!.period.end === "2024-05-31");
  const [debt] = extractSchedules(disclosures([...prior, fact({ concept: "LongTermDebt", value: "104000000000" })]), source);
  assert.equal(debt.asOf, "2024-05-31");
  assert.equal(debt.total, "90000000000");
  assert.equal(debt.buckets.length, 2);
});

test("operating and finance lease payments are one schedule, summed per bucket, with the total summed only when both are tagged", () => {
  const operating = [
    fact({ concept: "LesseeOperatingLeaseLiabilityPaymentsDueNextTwelveMonths", value: "900000000" }),
    fact({ concept: "LesseeOperatingLeaseLiabilityPaymentsDueYearTwo", value: "800000000" }),
    fact({ concept: "LesseeOperatingLeaseLiabilityPaymentsDueAfterYearFive", value: "2000000000" }),
    fact({ concept: "LesseeOperatingLeaseLiabilityPaymentsDue", value: "5000000000" }),
  ];
  const finance = [
    fact({ concept: "FinanceLeaseLiabilityPaymentsDueNextTwelveMonths", value: "100000000" }),
    fact({ concept: "FinanceLeaseLiabilityPaymentsDueYearThree", value: "50000000" }),
  ];
  const [summed] = extractSchedules(disclosures([...operating, ...finance]), source);
  assert.equal(summed.kind, "leasePaymentsDue");
  assert.deepEqual(summed.buckets, [{ from: 0, to: 12, amount: "1000000000" }, { from: 12, to: 24, amount: "800000000" }, { from: 24, to: 36, amount: "50000000" }, { from: 60, to: null, amount: "2000000000" }]);
  assert.equal(summed.total, null);
  const [withTotal] = extractSchedules(disclosures([...operating, ...finance, fact({ concept: "FinanceLeaseLiabilityPaymentsDue", value: "150000000" })]), source);
  assert.equal(withTotal.total, "5150000000");
  const [operatingOnly] = extractSchedules(disclosures(operating), source);
  assert.equal(operatingOnly.total, "5000000000");
});

test("unrecorded purchase obligations are read only when the recorded series is not a ladder; the two are never added", () => {
  const unrecorded = [
    fact({ concept: "UnrecordedUnconditionalPurchaseObligationDueWithinOneYear", value: "4000000000" }),
    fact({ concept: "UnrecordedUnconditionalPurchaseObligationDueInSecondYear", value: "3000000000" }),
    fact({ concept: "UnrecordedUnconditionalPurchaseObligationBalanceSheetAmount", value: "7000000000" }),
  ];
  const [fromUnrecorded] = extractSchedules(disclosures([...unrecorded, fact({ concept: "PurchaseObligationDueInNextTwelveMonths", value: "1" })]), source);
  assert.deepEqual(fromUnrecorded.buckets.map(b => b.amount), ["4000000000", "3000000000"]);
  assert.equal(fromUnrecorded.total, "7000000000");
  const [fromRecorded] = extractSchedules(disclosures([...unrecorded, ...purchases]), source);
  assert.equal(fromRecorded.total, "48000000000");
  assert.equal(fromRecorded.buckets[0].amount, "20000000000");
});

test("facts that are unparsed, non-currency or dimensional never form a schedule", () => {
  const facts = [
    fact({ concept: "PurchaseObligationDueInNextTwelveMonths", value: "1", status: "unsupported" }),
    fact({ concept: "PurchaseObligationDueInSecondYear", value: "2", currency: "shares" }),
    fact({ concept: "PurchaseObligationDueInThirdYear", value: "3", dimensional: true }),
    fact({ concept: "PurchaseObligationDueInFourthYear", value: "4" }),
  ];
  assert.deepEqual(extractSchedules(disclosures(facts), source), []);
});

test("a filing carries its schedules under the bumped version, and the quarter keeps only those stated at its period end", () => {
  assert.equal(CAPITAL_VERSION, "sec-capital-structure.v5");
  const filing = extractCapitalFiling({ status: "not_located" } as FinancialStatements, source, disclosures([...ladder, ...purchases]));
  assert.equal(filing.version, CAPITAL_VERSION);
  assert.equal(filing.schedules?.length, 2);
  const restated: CapitalFiling = { ...filing, schedules: [...filing.schedules!, { ...filing.schedules![0], asOf: "2024-05-31" }] };
  const quarters = buildCapitalQuarters([restated]);
  assert.equal(quarters.length, 1);
  assert.equal(quarters[0].periodEnd, "2025-05-31");
  assert.deepEqual(quarters[0].schedules?.map(s => [s.kind, s.asOf]), [["debtMaturities", "2025-05-31"], ["purchaseObligations", "2025-05-31"]]);
});

test("reading a published structure keeps well-formed schedules and drops the rest", () => {
  const filing = extractCapitalFiling({ status: "not_located" } as FinancialStatements, source, disclosures([...ladder, ...purchases]));
  const [debt, purchase] = filing.schedules!;
  const raw = {
    schemaVersion: "capital-structure.v1", ticker: "TEST", quarters: [{
      periodEnd: "2025-05-31", balanceSheet: null, cashFlow: null, yearToDate: null, rpo: null,
      schedules: [
        { ...debt, extra: "stripped" },
        { ...purchase, buckets: [purchase.buckets[0]] }, // one bucket
        { ...debt, kind: "leasePaymentsDue", asOf: "2024-05-31" }, // another instant
        { ...debt, kind: "leasePaymentsDue", buckets: [{ from: 12, to: 24, amount: "1" }, { from: 0, to: 12, amount: "2" }] }, // out of order
      ],
    }, { periodEnd: "2025-02-28", balanceSheet: null, cashFlow: null, yearToDate: null, schedules: [] }],
  };
  const read = readCapitalStructure(raw, "TEST");
  assert.equal(read?.quarters.length, 1);
  assert.deepEqual(read!.quarters[0].schedules, [debt]);
  assert.equal("extra" in read!.quarters[0].schedules![0], false);
  const legacy = readCapitalStructure({ schemaVersion: "capital-structure.v1", ticker: "TEST", quarters: [{ periodEnd: "2025-05-31", balanceSheet: null, cashFlow: null, yearToDate: null, rpo: { asOf: "2025-05-31", currency: "USD", total: "1", buckets: [], source } }] }, "TEST");
  assert.deepEqual(legacy?.quarters[0].schedules, []);
});

test("schedule figures resolve at the nearest quarter within 20 days, by bucket ordinal or total", () => {
  const filing = extractCapitalFiling({ status: "not_located" } as FinancialStatements, source, disclosures([...ladder, ...purchases]));
  const capital: PublicCapitalStructure = { schemaVersion: "capital-structure.v1", ticker: "TEST", quarters: buildCapitalQuarters([filing]) };
  assert.equal(scheduleAt(capital, "debtMaturities", "2025-06-15")?.asOf, "2025-05-31");
  assert.equal(scheduleAt(capital, "debtMaturities", "2025-06-30"), null);
  assert.equal(scheduleAt(capital, "leasePaymentsDue", "2025-05-31"), null);
  assert.deepEqual(scheduleBucketAt(capital, "debtMaturities", 0, "2025-05-31"), { value: 7.5e9, periodEnd: "2025-05-31", currency: "USD", accessions: [source.accession] });
  assert.equal(scheduleBucketAt(capital, "debtMaturities", 5, "2025-05-31")?.value, 68e9);
  assert.equal(scheduleBucketAt(capital, "purchaseObligations", 3, "2025-05-31"), null);
  assert.equal(scheduleTotalAt(capital, "debtMaturities", "2025-05-31")?.value, 104e9);
  assert.equal(scheduleTotalAt(null, "debtMaturities", "2025-05-31"), null);
  const untotalled = { ...capital, quarters: capital.quarters.map(q => ({ ...q, schedules: q.schedules!.map(s => ({ ...s, total: null })) })) };
  assert.equal(scheduleTotalAt(untotalled, "debtMaturities", "2025-05-31"), null);
});

test("bucket labels name the window in both locales", () => {
  assert.equal(scheduleBucketLabel("debtMaturities", { from: 0, to: 12, amount: "1" }), "Debt due within 12 months");
  assert.equal(scheduleBucketLabel("debtMaturities", { from: 12, to: 24, amount: "1" }), "Debt due 13–24 months");
  assert.equal(scheduleBucketLabel("debtMaturities", { from: 60, to: null, amount: "1" }), "Debt due after 60 months");
  assert.equal(scheduleBucketLabel("leasePaymentsDue", { from: 24, to: 36, amount: "1" }), "Lease payments due 25–36 months");
  assert.equal(scheduleBucketLabel("purchaseObligations", { from: 0, to: 12, amount: "1" }), "Purchase obligations due within 12 months");
  assert.equal(scheduleBucketLabel("debtMaturities", { from: 0, to: 12, amount: "1" }, "zh-CN"), "12 个月内到期债务");
  assert.equal(scheduleBucketLabel("debtMaturities", { from: 12, to: 24, amount: "1" }, "zh-CN"), "13–24 个月到期债务");
  assert.equal(scheduleBucketLabel("leasePaymentsDue", { from: 60, to: null, amount: "1" }, "zh-CN"), "60 个月后应付租赁款");
  assert.equal(scheduleBucketLabel("purchaseObligations", { from: 0, to: 12, amount: "1" }, "zh-CN"), "12 个月内采购义务");
});
