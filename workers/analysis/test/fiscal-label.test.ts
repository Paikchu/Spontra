import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarLabel, fiscalIdentity, periodLabel, rememberIssuer, resolvePeriod, yearEndMonth } from "../../../shared/analysis-runtime/fiscal-label.ts";

// The year end each issuer's SEC submissions state (`fiscalYearEnd`), and the quarter its latest filing cover reports.
const LATEST: Array<[string, string, string, string, number, 1 | 2 | 3 | 4]> = [
  ["0131", "2026-07-26", "2027 财年 Q2", "FY27 Q2", 2027, 2],
  ["0926", "2026-06-27", "2026 财年 Q3", "FY26 Q3", 2026, 3],
  ["0531", "2026-08-31", "2027 财年 Q1", "FY27 Q1", 2027, 1],
  ["0131", "2026-07-31", "2027 财年 Q2", "FY27 Q2", 2027, 2],
  ["1231", "2026-09-30", "2026 财年 Q3", "FY26 Q3", 2026, 3],
  ["1231", "2026-06-30", "2026 财年 Q2", "FY26 Q2", 2026, 2],
  ["0630", "2026-06-30", "2026 财年 Q4", "FY26 Q4", 2026, 4],
  ["1228", "2026-09-28", "2026 财年 Q3", "FY26 Q3", 2026, 3],
];

test("latest filing covers use the issuer fiscal quarter", () => {
  for (const [yearEnd, periodEnd, zh, en, year, quarter] of LATEST) {
    const fiscalYearEndMonth = yearEndMonth(yearEnd);
    const label = periodLabel({ periodEnd, fiscalYearEndMonth }, "zh-CN");
    const english = periodLabel({ periodEnd, fiscalYearEndMonth }, "en");
    assert.equal(label.primary, zh, yearEnd);
    assert.equal(english.primary, en, yearEnd);
    assert.equal(label.fiscalYear, year, yearEnd);
    assert.equal(label.fiscalQuarter, quarter, yearEnd);
    assert.equal(label.labelSource, "derived", yearEnd);
    assert.equal(label.secondary, `截至 ${periodEnd.replaceAll("-", ".")}`, yearEnd);
    assert.equal(english.secondary.startsWith("Ended "), true, yearEnd);
    assert.equal(label.calendarYear, label.fiscalYearEndMonth === 12, yearEnd);
  }
});

test("a year end in a month's first week closes the year of the month before", () => {
  assert.equal(yearEndMonth("0131"), 1);
  assert.equal(yearEndMonth("0201"), 1);
  assert.equal(yearEndMonth("0102"), 12);
  assert.equal(yearEndMonth("2025-12-29"), 12);
  assert.equal(yearEndMonth(null), null);
  assert.equal(yearEndMonth("1340"), null);
});

test("an issuer remembered from the server labels by ticker alone", () => {
  rememberIssuer("ACME", { fiscalYearEndMonth: 1, name: "Acme" });
  assert.equal(periodLabel({ ticker: "acme", periodEnd: "2026-07-26" }, "en").primary, "FY27 Q2");
  assert.equal(periodLabel({ ticker: "OTHER", periodEnd: "2026-07-26" }, "en").primary, null);
});

test("the tooltip names a January year-end and the reported quarter", () => {
  const issuer = { companyName: "NVIDIA", fiscalYearEndMonth: 1, periodEnd: "2026-07-26", periodStart: "2026-04-27" };
  const label = periodLabel(issuer, "zh-CN");
  const english = periodLabel(issuer, "en");
  assert.equal(label.tooltip, "NVIDIA 的财年在 1 月结束。本季覆盖 2026 年 4 月 27 日至 7 月 26 日，即公司财报中的 2027 财年第二季度。");
  assert.equal(english.tooltip, "NVIDIA's fiscal year ends in January. This quarter runs Apr 27 to Jul 26, 2026, reported as Q2 of fiscal 2027.");
  assert.equal(label.badge, "本季度 · 2027 财年 Q2");
  assert.equal(english.badge, "This quarter · FY27 Q2");
  assert.equal(english.secondary, "Ended Jul 26, 2026");
  assert.equal(label.secondaryShort, "截至 2026.07");
});

test("a December year-end says the fiscal year matches the calendar year", () => {
  const label = periodLabel({ companyName: "Meta", fiscalYearEndMonth: 12, periodEnd: "2026-09-30" }, "zh-CN");
  const english = periodLabel({ companyName: "Meta", fiscalYearEndMonth: 12, periodEnd: "2026-09-30" }, "en");
  assert.equal(label.calendarYear, true);
  assert.equal(label.tooltip, "Meta 的财年与自然年一致。");
  assert.equal(english.tooltip, "Meta's fiscal year matches the calendar year.");
});

test("an XBRL year that repeats the prior fiscal year keeps the quarter and corrects the year", () => {
  const identity = fiscalIdentity({ fiscalYearEndMonth: 5, periodEnd: "2026-08-31", xbrl: { fiscalYear: 2026, fiscalQuarter: 1 } });
  assert.deepEqual(identity, { fiscalYear: 2027, fiscalQuarter: 1, fiscalYearEndMonth: 5, labelSource: "xbrl" });
  const agreed = fiscalIdentity({ fiscalYearEndMonth: 1, periodEnd: "2026-07-26", xbrl: { fiscalYear: 2027, fiscalQuarter: 2 } });
  assert.equal(agreed.labelSource, "xbrl");
  assert.equal(agreed.fiscalYear, 2027);
  const disagree = fiscalIdentity({ fiscalYearEndMonth: 1, periodEnd: "2026-07-26", xbrl: { fiscalYear: 2027, fiscalQuarter: 3 } });
  assert.equal(disagree.labelSource, "derived");
  assert.equal(disagree.fiscalQuarter, 2);
});

test("an unknown issuer, or an explicit unknown stamp, never invents a quarter", () => {
  const label = periodLabel({ ticker: "UNKNOWN", periodEnd: "2026-06-30" }, "zh-CN");
  assert.equal(label.primary, null);
  assert.equal(label.labelSource, "unknown");
  assert.equal(label.unknown, "截至 2026.06.30 的季度");
  assert.equal(periodLabel({ ticker: "UNKNOWN", periodEnd: "2026-06-30" }, "en").unknown, "Quarter ended Jun 30, 2026");
  const stamped = resolvePeriod({ fiscalYearEndMonth: 1, periodEnd: "2026-07-26", labelSource: "unknown" });
  assert.equal(stamped.labelSource, "unknown");
  assert.equal(stamped.fiscalQuarter, null);
  const derived = resolvePeriod({ fiscalYearEndMonth: 9, periodEnd: "2026-06-27" });
  assert.equal(derived.fiscalYear, 2026);
  assert.equal(derived.fiscalQuarter, 3);
  assert.equal(calendarLabel("2026-07-26"), "2026 Q3");
});
