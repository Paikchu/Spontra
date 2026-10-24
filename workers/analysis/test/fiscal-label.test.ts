import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarLabel, fiscalIdentity, periodLabel, resolvePeriod } from "../../../shared/analysis-runtime/fiscal-label.ts";

const LATEST: Array<[string, string, string, string, number, 1 | 2 | 3 | 4]> = [
  ["NVDA", "2026-07-26", "2027 财年 Q2", "FY27 Q2", 2027, 2],
  ["AAPL", "2026-06-27", "2026 财年 Q3", "FY26 Q3", 2026, 3],
  ["ORCL", "2026-08-31", "2027 财年 Q1", "FY27 Q1", 2027, 1],
  ["ADSK", "2026-07-31", "2027 财年 Q2", "FY27 Q2", 2027, 2],
  ["META", "2026-09-30", "2026 财年 Q3", "FY26 Q3", 2026, 3],
  ["JPM", "2026-09-30", "2026 财年 Q3", "FY26 Q3", 2026, 3],
  ["SPCX", "2026-09-30", "2026 财年 Q3", "FY26 Q3", 2026, 3],
  ["AMZN", "2026-06-30", "2026 财年 Q2", "FY26 Q2", 2026, 2],
  ["BRK.B", "2026-06-30", "2026 财年 Q2", "FY26 Q2", 2026, 2],
  ["CRWV", "2026-06-30", "2026 财年 Q2", "FY26 Q2", 2026, 2],
  ["GOOGL", "2026-06-30", "2026 财年 Q2", "FY26 Q2", 2026, 2],
  ["NBIS", "2026-06-30", "2026 财年 Q2", "FY26 Q2", 2026, 2],
  ["NET", "2026-06-30", "2026 财年 Q2", "FY26 Q2", 2026, 2],
  ["TSM", "2026-06-30", "2026 财年 Q2", "FY26 Q2", 2026, 2],
  ["MSFT", "2026-06-30", "2026 财年 Q4", "FY26 Q4", 2026, 4],
  ["TTMI", "2026-09-28", "2026 财年 Q3", "FY26 Q3", 2026, 3],
];

test("latest filing covers use the issuer fiscal quarter", () => {
  assert.equal(LATEST.length, 16);
  for (const [ticker, periodEnd, zh, en, year, quarter] of LATEST) {
    const label = periodLabel({ ticker, periodEnd }, "zh-CN");
    const english = periodLabel({ ticker, periodEnd }, "en");
    assert.equal(label.primary, zh, ticker);
    assert.equal(english.primary, en, ticker);
    assert.equal(label.fiscalYear, year, ticker);
    assert.equal(label.fiscalQuarter, quarter, ticker);
    assert.equal(label.labelSource, "derived", ticker);
    assert.equal(label.secondary, `截至 ${periodEnd.replaceAll("-", ".")}`, ticker);
    assert.equal(english.secondary.startsWith("Ended "), true, ticker);
    assert.equal(label.calendarYear, label.fiscalYearEndMonth === 12, ticker);
  }
});

test("NVIDIA tooltip names the January year-end and the reported quarter", () => {
  const label = periodLabel({ ticker: "NVDA", periodEnd: "2026-07-26", periodStart: "2026-04-27" }, "zh-CN");
  const english = periodLabel({ ticker: "NVDA", periodEnd: "2026-07-26", periodStart: "2026-04-27" }, "en");
  assert.equal(label.tooltip, "NVIDIA 的财年在 1 月结束。本季覆盖 2026 年 4 月 27 日至 7 月 26 日，即公司财报中的 2027 财年第二季度。");
  assert.equal(english.tooltip, "NVIDIA's fiscal year ends in January. This quarter runs Apr 27 to Jul 26, 2026, reported as Q2 of fiscal 2027.");
  assert.equal(label.badge, "本季度 · 2027 财年 Q2");
  assert.equal(english.badge, "This quarter · FY27 Q2");
  assert.equal(english.secondary, "Ended Jul 26, 2026");
  assert.equal(label.secondaryShort, "截至 2026.07");
});

test("a December year-end says the fiscal year matches the calendar year", () => {
  const label = periodLabel({ ticker: "META", periodEnd: "2026-09-30" }, "zh-CN");
  const english = periodLabel({ ticker: "META", periodEnd: "2026-09-30" }, "en");
  assert.equal(label.calendarYear, true);
  assert.equal(label.tooltip, "Meta 的财年与自然年一致。");
  assert.equal(english.tooltip, "Meta's fiscal year matches the calendar year.");
});

test("an XBRL year that repeats the prior fiscal year keeps the quarter and corrects the year", () => {
  const identity = fiscalIdentity({ ticker: "ORCL", periodEnd: "2026-08-31", xbrl: { fiscalYear: 2026, fiscalQuarter: 1 } });
  assert.deepEqual(identity, { fiscalYear: 2027, fiscalQuarter: 1, fiscalYearEndMonth: 5, labelSource: "xbrl" });
  const agreed = fiscalIdentity({ ticker: "NVDA", periodEnd: "2026-07-26", xbrl: { fiscalYear: 2027, fiscalQuarter: 2 } });
  assert.equal(agreed.labelSource, "xbrl");
  assert.equal(agreed.fiscalYear, 2027);
  const disagree = fiscalIdentity({ ticker: "NVDA", periodEnd: "2026-07-26", xbrl: { fiscalYear: 2027, fiscalQuarter: 3 } });
  assert.equal(disagree.labelSource, "derived");
  assert.equal(disagree.fiscalQuarter, 2);
});

test("an unknown issuer, or an explicit unknown stamp, never invents a quarter", () => {
  const label = periodLabel({ ticker: "ACME", periodEnd: "2026-06-30" }, "zh-CN");
  assert.equal(label.primary, null);
  assert.equal(label.labelSource, "unknown");
  assert.equal(label.unknown, "截至 2026.06.30 的季度");
  assert.equal(periodLabel({ ticker: "ACME", periodEnd: "2026-06-30" }, "en").unknown, "Quarter ended Jun 30, 2026");
  const stamped = resolvePeriod({ ticker: "NVDA", periodEnd: "2026-07-26", labelSource: "unknown" });
  assert.equal(stamped.labelSource, "unknown");
  assert.equal(stamped.fiscalQuarter, null);
  const derived = resolvePeriod({ ticker: "AAPL", periodEnd: "2026-06-27" });
  assert.equal(derived.fiscalYear, 2026);
  assert.equal(derived.fiscalQuarter, 3);
  assert.equal(calendarLabel("2026-07-26"), "2026 Q3");
});
