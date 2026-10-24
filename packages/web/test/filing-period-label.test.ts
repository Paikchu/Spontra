import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicSecFiling } from "../../../shared/analysis-contract/filings.ts";
import { formatFilingPeriodLabel } from "../src/model/filing-period-label.ts";

const filing = (extra: Partial<PublicSecFiling>): PublicSecFiling => ({
  ticker: "NVDA", form: "10-Q", filingDate: "2026-08-26", reportDate: "2026-07-26",
  accessionNumber: "0001045810-26-000001", companyName: "NVIDIA CORP", cik: "0001045810", cikNumber: 1045810,
  description: "10-Q", summary: null, analysis: null, analysisStatus: "not_collected", reportVersion: null,
  edgarUrl: "https://www.sec.gov/", documentUrl: "https://www.sec.gov/", provenance: "sec_edgar", periodId: null,
  analysisSchemaVersion: null, contentRevision: null, analysisRun: { state: "none", updatedAt: null, errorCode: null },
  ...extra,
}) as PublicSecFiling;

test("a filing label follows the issuer fiscal quarter and never says the quarter is pending", () => {
  assert.equal(formatFilingPeriodLabel(filing({}), "zh-CN"), "2027 财年 Q2");
  assert.equal(formatFilingPeriodLabel(filing({}), "en"), "FY27 Q2");
  assert.equal(formatFilingPeriodLabel(filing({ ticker: "AAPL", reportDate: "2026-06-27" }), "zh-CN"), "2026 财年 Q3");
  assert.equal(formatFilingPeriodLabel(filing({ ticker: "ORCL", reportDate: "2026-08-31", fiscalPeriod: { fiscalYear: 2026, fiscalPeriod: "Q1", periodEnd: "2026-08-31", source: "sec_dei", sourceAccession: "x", sourceUrl: "https://www.sec.gov/" } }), "zh-CN"), "2027 财年 Q1");
  assert.equal(formatFilingPeriodLabel(filing({ ticker: "META", reportDate: "2026-09-30" }), "zh-CN"), "2026 财年 Q3");
  assert.equal(formatFilingPeriodLabel(filing({ ticker: "MSFT", form: "10-K", reportDate: "2026-06-30" }), "en"), "FY26 Q4");
  const pending = formatFilingPeriodLabel(filing({ ticker: "NBIS", form: "6-K", reportDate: "2026-06-30", earningsGroup: { id: "e", periodEnd: "2026-06-30", earningsDate: "2026-08-12", canonicalAccession: "a", inputKey: "k", sources: [] } }), "zh-CN");
  assert.equal(pending, "2026 财年 Q2");
  assert.equal(pending.includes("待确认"), false);
  assert.equal(formatFilingPeriodLabel(filing({ ticker: "ACME", reportDate: "2026-06-30" }), "zh-CN"), "截至 2026.06.30 的季度");
  assert.equal(formatFilingPeriodLabel(filing({ ticker: "ACME", reportDate: "2026-06-30" }), "en"), "Quarter ended Jun 30, 2026");
  assert.equal(formatFilingPeriodLabel(filing({ form: "8-K", reportDate: "2026-08-26" }), "zh-CN"), "8-K");
});
