import { readFile } from "node:fs/promises";
import { measureReportReliability, type GenerationJob } from "../workers/pipeline/src/report-reliability.ts";

const args = process.argv.slice(2);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const input = value("--input"), since = value("--since");
if (!input || !since) throw new Error("Usage: node --experimental-strip-types scripts/sec-report-reliability.ts --input <D1 export.json> --since <release ISO timestamp> [--now <ISO timestamp>]");
const data = JSON.parse(await readFile(input, "utf8"));
const rows = Array.isArray(data) ? data.flatMap((item) => item.results ?? [item]) : data.results;
if (!Array.isArray(rows)) throw new Error("Expected D1 JSON export rows");
const jobs: GenerationJob[] = rows.map((row) => ({
  jobId: row.jobId ?? row.job_id, status: row.status, createdAt: row.createdAt ?? row.created_at,
  updatedAt: row.updatedAt ?? row.updated_at, currentStage: row.currentStage ?? row.current_stage, errorCode: row.errorCode ?? row.error_code,
}));
if (jobs.some((job) => !job.jobId || !job.status || !job.createdAt || !job.updatedAt)) throw new Error("Job export is missing required fields");
const report = measureReportReliability(jobs, since, value("--now"));
console.log(JSON.stringify({ source: "provided_job_export", ...report }, null, 2));
if (report.assessment === "above_target") process.exitCode = 1;
if (report.assessment === "insufficient_evidence") process.exitCode = 2;
