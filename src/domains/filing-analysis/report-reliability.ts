export type GenerationJob = {
  jobId: string; status: string; createdAt: string; updatedAt: string;
  currentStage?: string; errorCode?: string | null;
};
const timestamp = (text: string) => Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text.replace(" ", "T") + "Z" : text);

/** One-sided exact 95% binomial upper confidence limit. Not valid for correlated synthetic tests. */
export function failureRateUpperBound(failed: number, total: number, alpha = 0.05): number | null {
  if (total === 0) return null;
  if (failed === total) return 1;
  if (failed === 0) return 1 - alpha ** (1 / total);
  const logCdf = (p: number) => {
    let term = total * Math.log1p(-p), sum = term;
    for (let k = 1; k <= failed; k++) {
      term += Math.log(total - k + 1) - Math.log(k) + Math.log(p) - Math.log1p(-p);
      const max = Math.max(sum, term);
      sum = max + Math.log(Math.exp(sum - max) + Math.exp(term - max));
    }
    return sum;
  };
  let low = failed / total, high = 1;
  for (let i = 0; i < 64; i++) {
    const middle = (low + high) / 2;
    if (logCdf(middle) > Math.log(alpha)) low = middle; else high = middle;
  }
  return high;
}

/** A generation request is counted once, not once per retry. Old reports are never new successes. */
export function measureReportReliability(jobs: GenerationJob[], since: string, now = new Date().toISOString(), deadlineMs = 24 * 60 * 60_000) {
  const start = Date.parse(since), end = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error("A valid release cohort and observation time are required");
  const latest = new Map<string, GenerationJob>();
  for (const job of jobs) {
    const created = timestamp(job.createdAt);
    if (!Number.isFinite(created) || !Number.isFinite(timestamp(job.updatedAt))) throw new Error("Job export contains an invalid timestamp");
    if (created < start || created > end) continue;
    const previous = latest.get(job.jobId);
    if (!previous || timestamp(job.updatedAt) >= timestamp(previous.updatedAt)) latest.set(job.jobId, job);
  }
  let published = 0, failed = 0, overdue = 0, pending = 0;
  const failuresByCode: Record<string, number> = {};
  for (const job of latest.values()) {
    if (job.status === "complete" && job.currentStage === "published") { published++; continue; }
    if (job.status === "failed" || end - timestamp(job.createdAt) >= deadlineMs) {
      failed++;
      const code = job.status === "failed" ? job.errorCode || "unknown" : "generation_deadline";
      if (code === "generation_deadline") overdue++;
      failuresByCode[code] = (failuresByCode[code] ?? 0) + 1;
    } else pending++;
  }
  const terminal = published + failed;
  const observedFailureRate = terminal ? failed / terminal : null;
  const upper95 = failureRateUpperBound(failed, terminal);
  return { since, checkedAt: now, acceptedRequests: latest.size, published, failed, overdue, pending,
    observedFailureRate, upper95, target: 0.01, failuresByCode,
    assessment: observedFailureRate !== null && observedFailureRate >= 0.01 ? "above_target"
      : !pending && upper95 !== null && upper95 < 0.01 ? "supported_by_sample" : "insufficient_evidence",
  };
}
