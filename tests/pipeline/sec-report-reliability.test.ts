import assert from "node:assert/strict";
import test from "node:test";
import { failureRateUpperBound, measureReportReliability } from "../../workers/pipeline/src/report-reliability.ts";

test("the production SLO cannot pass on a tiny sample, old successes or unfinished jobs", () => {
  const job = { jobId: "new", status: "complete", currentStage: "published", createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T01:00:00Z" };
  const since = "2026-09-15T00:00:00Z", now = "2026-09-15T02:00:00Z";
  assert.equal(measureReportReliability([job], since, now).assessment, "insufficient_evidence");
  const rows = Array.from({ length: 300 }, (_, i) => ({ ...job, jobId: `job-${i}` }));
  assert.equal(measureReportReliability(rows, since, now).assessment, "supported_by_sample");
  assert.equal(measureReportReliability([...rows, { ...job, status: "running", currentStage: "synthesis" }], since, now).assessment, "insufficient_evidence");
  assert.equal(measureReportReliability(rows, "2026-09-15T00:30:00Z", now).published, 0);
  assert.equal(measureReportReliability([job, job], since, now).published, 1);
  const overdue = measureReportReliability([{ ...job, status: "running" }], since, "2026-09-16T01:00:00Z");
  assert.equal(overdue.overdue, 1); assert.equal(overdue.assessment, "above_target");
});

test("one-sided confidence bound requires 299 zero-failure independent production observations", () => {
  assert.ok(failureRateUpperBound(0, 298)! >= 0.01);
  assert.ok(failureRateUpperBound(0, 299)! < 0.01);
  assert.equal(failureRateUpperBound(0, 0), null);
  assert.ok(failureRateUpperBound(1, 300)! > 0.01);
  assert.ok(failureRateUpperBound(5, 1000)! > 0.005);
  assert.equal(failureRateUpperBound(1, 1), 1);
});
