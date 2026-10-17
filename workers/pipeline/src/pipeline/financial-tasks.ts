import { financialPolicy, allowData } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import { CAPITAL_VERSION } from "../../../../shared/analysis-runtime/financial-data/capital-structure.ts";
import { FinancialMaintenanceStore } from "../admin/financial-maintenance-store.ts";
import { runFinancialMaintenanceTick } from "../admin/financial-maintenance-runner.ts";
import { collectComplete } from "../financial-data/collect.ts";
import { companyPolicyEnvironment } from "../financial-data/company-policy.ts";
import { archiveFilingDisclosures, readArchivedDocument, refreshStaleProjections } from "../financial-data/disclosure-audit.ts";
import { HISTORY_VERSION, runHistoryStep } from "../financial-data/history.ts";
import { SEC_FLOW_PARSER_VERSION } from "../financial-data/parser.ts";
import { discoverDataIssuer, readReleaseQuarter, readSecDocumentBatch, throttledSecReader, type SecReader } from "../financial-data/provider.ts";
import { withFilingStructure } from "../financial-data/presentation.ts";
import { claimJobFor, latestJob, startCollection } from "../financial-data/queue.ts";
import { D1CompleteStore } from "../financial-data/store.ts";
import type { SecPipelineEnv } from "../operations.ts";
import { syncTranscript } from "../transcripts/library.ts";
import { dataTickersFor } from "../core.ts";
import { knownCik } from "./identity.ts";
import type { TaskImplementation, TaskOutcome } from "./tasks.ts";

const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE;
const until = (at: string | null | undefined, now: Date, floor = SECOND) => Math.max(floor, (at ? Date.parse(at) : now.getTime()) - now.getTime());

/**
 * A collection job lists the issuer's filings once, when it starts. A filing discovered while the job was active (it
 * was waiting to retry, or a run was claimed from the old listing) is therefore not in that job: when the job ends, the
 * newest filing collection reads (discovery's `collectable`) is compared with the job's listing, and a missing one
 * starts a new collection. Each accession restarts at most once, so a filing a job cannot list never loops.
 */
export async function missedFiling(db: D1Database, ticker: string, jobId: string): Promise<string | null> {
  const state = await db.prepare("SELECT json_extract(payload, '$.collectable[0]') newest FROM sec_cache WHERE cache_key = ?").bind(`sec:discovery:v1:${ticker}`).first<{ newest: string | null }>();
  if (!state?.newest) return null;
  const job = await db.prepare("SELECT cursor_json FROM financial_collection_jobs WHERE job_id = ?").bind(jobId).first<{ cursor_json: string | null }>();
  let listed: string[] = [];
  try {
    const cursor = JSON.parse(job?.cursor_json || "{}") as { documents?: Array<{ accession: string }>; release?: { accession: string } };
    if (!cursor.documents) return null;
    listed = [...cursor.documents.map(d => d.accession), ...(cursor.release ? [cursor.release.accession] : [])];
  } catch { return null; }
  if (listed.includes(state.newest)) return null;
  const marker = `pipeline:collect-restarted:${ticker}`;
  const restarted = await db.prepare("SELECT json_extract(payload, '$.accession') accession FROM sec_cache WHERE cache_key = ?").bind(marker).first<{ accession: string | null }>();
  if (restarted?.accession === state.newest) return null;
  await db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
    .bind(marker, JSON.stringify({ accession: state.newest, jobId }), new Date().toISOString()).run();
  return state.newest;
}

async function dataPolicy(env: SecPipelineEnv) {
  const policyEnv = await companyPolicyEnvironment(env);
  return financialPolicy({ SEC_DATA_TICKERS: policyEnv.SEC_DATA_TICKERS, SEC_TRACKED_TICKERS: policyEnv.SEC_TRACKED_TICKERS, SEC_AI_ENABLED: "false" });
}

/** A throttled SEC reader whose documents are archived for this company, read back from the archive when already there. */
function archivingReader(env: SecPipelineEnv, ticker: string, causeId: string): SecReader {
  const reader = throttledSecReader(env.SEC_USER_AGENT, fetch, 1000);
  const archive = { DB: env.DB!, SEC_FILINGS: env.SEC_FILINGS };
  reader.archive = (source, html, metadata) => archiveFilingDisclosures(archive, ticker, source, html, metadata, causeId).then(() => undefined);
  reader.archived = url => readArchivedDocument(archive, ticker, url);
  return withFilingStructure(reader, env.DB!);
}

export const FINANCIAL_TASKS = {
  /**
   * One collection step for the company: starts a collection when a filing arrived and none is active, then reads
   * one batch of documents. Continues at once while the job is preparing, after its back-off when it must retry.
   * A job that ended unavailable for a transient reason is tried again six hours later, at most three times running.
   */
  collect: {
    version: SEC_FLOW_PARSER_VERSION,
    async run(env, ticker, { causeId, now }): Promise<TaskOutcome> {
      const db = env.DB!;
      // Paused, not finished: the filing that asked for this run is collected when collection is switched back on.
      if (env.SEC_DATA_COLLECTION_ENABLED !== "true") return { status: "later", afterMs: HOUR, detail: { waiting: "collection paused" } };
      const policy = await dataPolicy(env);
      if (!allowData(policy, ticker)) return { status: "done", detail: { skipped: "not a data company" } };
      // An admin maintenance task owns this issuer's data while it runs; other issuers' tasks do not hold this one up.
      const cik = await knownCik(db, ticker);
      if (await new FinancialMaintenanceStore(db).hasActiveDataTasksFor(ticker, cik)) return { status: "later", afterMs: 5 * MINUTE, detail: { waiting: "maintenance" } };
      let job = await claimJobFor(db, ticker, now);
      if (!job) {
        const latest = await latestJob(db, ticker);
        if (latest && ["queued", "retry", "running"].includes(latest.status)) {
          return { status: "later", afterMs: until(latest.status === "running" ? latest.lease_until : latest.next_attempt_at, now), detail: { waiting: latest.status } };
        }
        await startCollection(db, ticker, cik ?? (await discoverDataIssuer(ticker, throttledSecReader(env.SEC_USER_AGENT, fetch, 1000))).cik, now);
        job = await claimJobFor(db, ticker, now);
        // Another owner (a collection or maintenance task the checks above did not see) has the issuer: wait, never drop the filing.
        if (!job) return { status: "later", afterMs: 5 * MINUTE, detail: { waiting: "collection owned elsewhere" } };
      }
      const reader = archivingReader(env, ticker, causeId);
      // A quarter whose earnings release is out is published from the release, ahead of its 10-Q.
      // A newest quarter no structure balanced asks for a judgement (presentation-task.ts) in the publication's own
      // transaction; the publication stands meanwhile.
      const collected = await collectComplete(job, policy, new D1CompleteStore(db, causeId, { announceDegraded: true }), j => readSecDocumentBatch(j, reader), (j, previous) => readReleaseQuarter(j, previous, reader));
      const result = { published: collected.published, reasons: collected.reasons };
      const after = await latestJob(db, ticker);
      if (after && ["queued", "retry"].includes(after.status)) return { status: "later", afterMs: until(after.next_attempt_at, now), detail: result };
      // Still running: this run's lease ran out mid-batch (its writes did not take), or another run holds it. Claim again when it frees.
      if (after?.status === "running") return { status: "later", afterMs: until(after.lease_until, now), detail: { ...result, waiting: "running" } };
      const missed = after ? await missedFiling(db, ticker, after.job_id) : null;
      if (missed && await startCollection(db, ticker, after!.cik, new Date())) return { status: "later", afterMs: SECOND, detail: { ...result, restarted: missed } };
      if (after?.status === "unavailable" && after.reasons_json?.includes("SOURCE_TEMPORARILY_UNAVAILABLE")) {
        const recent = await db.prepare("SELECT status FROM financial_collection_jobs WHERE ticker = ? AND job_id NOT LIKE 'admin:%' ORDER BY generation DESC LIMIT 3").bind(ticker).all<{ status: string }>();
        if (recent.results.length < 3 || recent.results.some(r => r.status !== "unavailable")) return { status: "later", afterMs: 6 * HOUR, detail: { ...result, retry: "source unavailable" } };
      }
      return { status: "done", detail: result };
    },
  },

  /** Brings quarterly revenue history up to date after a publication: a finished scan restarts, an unfinished one continues. */
  history: {
    version: HISTORY_VERSION,
    async run(env, ticker, { causeId, now }): Promise<TaskOutcome> {
      if (env.SEC_DATA_COLLECTION_ENABLED !== "true") return { status: "later", afterMs: HOUR, detail: { waiting: "collection paused" } };
      if (!allowData(await dataPolicy(env), ticker)) return { status: "done", detail: { skipped: "not a data company" } };
      const job = await latestJob(env.DB!, ticker);
      if (!job || !/^\d{10}$/.test(job.cik)) return { status: "done", detail: { skipped: "issuer not collected yet" } };
      const cursor = await env.DB!.prepare("SELECT json_extract(payload, '$.finishedAt') finished FROM sec_cache WHERE cache_key = ?").bind(`sec:revenue-history-cursor:v1:${job.cik}`).first<{ finished: string | null }>();
      const result = await runHistoryStep(env.DB!, archivingReader(env, ticker, causeId), { ticker, cik: job.cik }, now, 3, { restartFinished: !!cursor?.finished });
      if (result.finished) return { status: "done", detail: result };
      return { status: "later", afterMs: result.retry ? 10 * MINUTE : SECOND, detail: result };
    },
  },

  /** Re-projects a few archived filings at a time whose capital projection is older than the current version. */
  reproject: {
    version: CAPITAL_VERSION,
    async run(env, _ticker, { causeId }): Promise<TaskOutcome> {
      const done = await refreshStaleProjections({ DB: env.DB!, SEC_FILINGS: env.SEC_FILINGS }, 3, causeId);
      return done.length === 3 ? { status: "later", afterMs: SECOND, detail: { reprojected: done.length } } : { status: "done", detail: { reprojected: done.length } };
    },
  },

  /** One step of the admin's financial maintenance tasks, then sleeps until the earliest one may run again. */
  maintenance: {
    version: "maintenance.v1",
    async run(env, _ticker, { now }): Promise<TaskOutcome> {
      const outcome = await runFinancialMaintenanceTick(env, undefined, now);
      const next = await env.DB!.prepare(`SELECT MIN(CASE WHEN lease_until > ? THEN lease_until ELSE next_attempt_at END) AS next
        FROM financial_maintenance_tasks WHERE status IN ('queued','running','cancel_requested')`).bind(now.toISOString()).first<{ next: string | null }>();
      if (!next?.next) return { status: "done", detail: outcome };
      return { status: "later", afterMs: until(next.next, now), detail: outcome };
    },
  },

  /**
   * Fetches one transcript within the shared daily budget, then sleeps until the next one is due: the next queued
   * period, a failed one's retry the next day, or the next UTC day when the budget is spent.
   */
  transcript: {
    version: "transcript.v1",
    async run(env, _ticker, { now, causeId }): Promise<TaskOutcome> {
      const result = await syncTranscript(env, now, fetch, causeId);
      if (result.status === "disabled") return { status: "done", detail: result };
      if (result.status === "daily_budget") {
        const tomorrow = new Date(now); tomorrow.setUTCHours(24, 10, 0, 0);
        return { status: "later", afterMs: until(tomorrow.toISOString(), now), detail: result };
      }
      const tickers = dataTickersFor(await companyPolicyEnvironment(env));
      const next = await env.DB!.prepare(`SELECT MIN(CASE WHEN status = 'fetching' THEN lease_until ELSE next_attempt_at END) AS next FROM company_transcripts
        WHERE status IN ('queued','retry','fetching') AND ticker IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(tickers)).first<{ next: string | null }>();
      if (!next?.next) return { status: "done", detail: result };
      // The provider's free tier allows a handful of calls a minute; one every 20 seconds stays well inside it.
      return { status: "later", afterMs: until(next.next, now, 20 * SECOND), detail: result };
    },
  },
} satisfies Record<string, TaskImplementation>;
