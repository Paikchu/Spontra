import { test } from "node:test";
import assert from "node:assert/strict";
import { coverAmendmentNote, coverAmendmentSummary } from "../src/sec/amendment.ts";
import { maintenanceIssueBlocksTask } from "../src/admin/financial-maintenance-runner.ts";
import { extractRevenueHistory } from "../src/financial-data/revenue-parser.ts";
import type { DocumentSource } from "../src/financial-data/parser.ts";

/** The explanatory note of NBIS 20-F/A 0001104659-26-065681, as filed on 2026-05-22. */
const nbisAmendment = `<p>Nebius Group N.V. (the &#8220;Company&#8221;) is filing this Amendment No. 1 (the &#8220;Amendment&#8221;) on Form 20-F/A to amend its annual report on Form 20-F for the fiscal year ended December 31, 2025, filed with the Securities and Exchange Commission on April 30, 2026 (the &#8220;Original 20-F&#8221;), solely for the purpose of including Exhibit 97.1.</p><p>The Amendment does not reflect events occurring after the date of the filing of the Original 20-F or modify or update any of the other disclosures contained therein in any way. Accordingly, the Amendment should be read in conjunction with the Original 20-F. The Amendment consists solely of the preceding cover page, this explanatory note, the signature page and the Exhibits identified in Item 19.</p>`;

test("NBIS's exhibit-only 20-F/A is recognized as a cover amendment for Exhibit 97.1", () => {
  assert.deepEqual(coverAmendmentNote("20-F/A", nbisAmendment), { exhibit: "97.1" });
  const summary = coverAmendmentSummary({ ticker: "NBIS", form: "20-F/A", filingDate: "2026-05-22", accessionNumber: "0001104659-26-065681" }, { exhibit: "97.1" }, new Date("2026-10-22T00:00:00Z"));
  assert.equal(summary.source, "filing");
  assert.match(summary.headline, /Exhibit 97\.1/);
  assert.match(summary.report, /does not modify the disclosures/);
});

test("a restatement, a 6-K, or an amendment that does not name the exhibit is not a cover amendment", () => {
  const restatement = `<p>This Form 10-K/A restates the consolidated financial statements for the year ended December 31, 2025 and modifies the disclosures in the original report, including Exhibit 99.1.</p>`;
  assert.equal(coverAmendmentNote("10-K/A", restatement), null);
  assert.equal(coverAmendmentNote("20-F", nbisAmendment), null);
  assert.equal(coverAmendmentNote("6-K", nbisAmendment), null);
  assert.equal(coverAmendmentNote("20-F/A", nbisAmendment.replace("including Exhibit 97.1", "adding the clawback policy")), null);
  assert.equal(coverAmendmentNote("20-F/A", nbisAmendment.replace("consists solely of the preceding cover page", "includes the cover page")), null);
});

test("a filing that never prints a quarter is not a failed quarter read, and one that does still is", () => {
  const source: DocumentSource = { url: "https://www.sec.gov/doc.htm", accession: "0001104659-26-065681", filedAt: "2026-05-22", cik: "0001513845", industry: "standard" };
  const annual = extractRevenueHistory("<html><body><p>Year ended December 31, 2025</p></body></html>", source, "20-F");
  assert.deepEqual(annual.quarters, []);
  assert.deepEqual(annual.issues, ["NO_QUARTERLY_PERIOD"]);
  const quarterly = extractRevenueHistory("<html><body><p>For the Three Months Ended June 30, 2026</p></body></html>", source, "6-K");
  assert.deepEqual(quarterly.quarters, []);
  assert.ok(quarterly.issues.includes("NO_DIRECT_COMPARABLE_QUARTER"));
  assert.ok(!quarterly.issues.includes("NO_QUARTERLY_PERIOD"));
});

test("notes from a scan do not keep a maintenance task partial", () => {
  for (const issue of ["NO_QUARTERLY_PERIOD", "0001104659-26-065681:NO_QUARTERLY_PERIOD", "NO_DIRECT_COMPARABLE_QUARTER", "0001628280-26-025362:RESTATEMENT_REVIEW_REQUIRED", "UNSUPPORTED_SOURCE_FACTS:346"]) {
    assert.equal(maintenanceIssueBlocksTask(issue), false, issue);
  }
  for (const issue of ["ANALYSIS_INCOMPLETE", "REVENUE_BREAKDOWN_NOT_VERIFIED", "MISSING_TWO_QUARTERS", "0001046179-26-000541:NO_QUARTER_READ"]) {
    assert.equal(maintenanceIssueBlocksTask(issue), true, issue);
  }
});
