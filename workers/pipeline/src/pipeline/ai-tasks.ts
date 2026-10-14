import { AiRunStore, quietly } from "../ai-runs/store.ts";
import { BUSINESS_EXPLAINER_VERSION, businessExplainerCacheKey, businessExplainerFingerprint } from "../business-explainer/workflow.ts";
import { BUSINESS_TREE_VERSION, businessTreeCacheKey, businessTreeFingerprint } from "../business-tree/workflow.ts";
import { COMPANY_ANALYSIS_PROMPT_VERSION } from "../company-analysis/contracts.ts";
import { recoverCompanyAnalysis, startCompanyMemory } from "../core.ts";
import { FINDINGS_VERSION, findingsFingerprint } from "../findings/workflow.ts";
import { ANALYST_VERSION, analystFingerprint, dossierCacheKey } from "../analyst/workflow.ts";
import { findingsCacheKey } from "../findings/read.ts";
import type { AiWorkflowBinding, SecPipelineEnv } from "../operations.ts";
import type { AiRunKind } from "../../../../shared/analysis-contract/ai-runs-admin.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { TaskImplementation, TaskOutcome } from "./tasks.ts";
import { driveWorkflow, failedInputKey } from "./workflow-task.ts";

const MINUTE = 60_000;
const until = (at: string, now: Date) => Math.max(MINUTE, Date.parse(at) - now.getTime());
const slug = (ticker: string) => ticker.replace(/[^A-Za-z0-9]/g, "-");

/**
 * Runs a model Workflow when the inputs it would write from changed: `fingerprint` is the state a run would write now
 * (null while there is nothing to write from), compared with what is published. A failed run becomes a dead letter.
 */
async function runWhenChanged(env: SecPipelineEnv, task: "findings" | "explainer" | "tree" | "analyst", kind: AiRunKind, ticker: string, causeId: string, now: Date,
  binding: AiWorkflowBinding<{ ticker: string; fingerprint: string }> | undefined, fingerprint: () => Promise<string | null>, published: () => Promise<string | null>): Promise<TaskOutcome> {
  return driveWorkflow(env, `${task}:${ticker}`, binding, async () => {
    const current = await fingerprint();
    if (!current || current === await published()) return null;
    // The last run failed on exactly this input; it runs again when the input changes or the dead letter is replayed.
    const failed = (await new D1SecRepository(env.DB!).getCache<{ fingerprint: string }>(failedInputKey(task, ticker)))?.payload?.fingerprint;
    if (failed === current) return { status: "done", detail: { skipped: "failed on this input before; replay the dead letter to retry" } };
    const id = `${task === "findings" ? "findings" : task === "tree" ? "business-tree" : task === "analyst" ? "analyst" : "business-explainer"}-${slug(ticker)}-${current.slice(0, 16)}-${now.getTime()}`;
    await quietly(() => new AiRunStore(env.DB!).start({ kind, ticker, runId: id, trigger: "schedule" }, now.toISOString()));
    return { id, params: { ticker, fingerprint: current }, fingerprint: current };
  }, { deadLetter: { task, ticker, causeId } });
}

const storedFingerprint = (env: SecPipelineEnv, key: string) => async () =>
  (await new D1SecRepository(env.DB!).getCache<{ fingerprint?: string }>(key))?.payload?.fingerprint ?? null;

export const AI_TASKS = {
  /**
   * Findings for the newest report, written from the map snapshot, guidance, SEC fundamentals and the company analysis.
   * Within a day of an earnings release whose guidance is still being extracted, it waits for that guidance.
   */
  findings: {
    version: FINDINGS_VERSION,
    async run(env, ticker, { now, causeId }): Promise<TaskOutcome> {
      if (env.FINDINGS_ENABLED !== "true") return { status: "done", detail: { skipped: "findings disabled" } };
      if (env.GUIDANCE_ENABLED === "true") {
        const since = new Date(now.getTime() - 24 * 60 * MINUTE).toISOString().slice(0, 10);
        const pending = await env.DB!.prepare("SELECT accession FROM earnings_events WHERE ticker = ? AND status IN ('queued', 'started') AND event_date >= ? LIMIT 1").bind(ticker, since).first<{ accession: string }>();
        if (pending) return { status: "later", afterMs: 30 * MINUTE, detail: { waiting: "guidance", accession: pending.accession } };
      }
      return runWhenChanged(env, "findings", "findings", ticker, causeId, now, env.FINDINGS_WORKFLOW,
        () => findingsFingerprint(env, ticker), storedFingerprint(env, findingsCacheKey(ticker)));
    },
  },

  /** The analyst dossier for the served findings; reruns when the findings, the newest periodic filings or the prompt change. */
  analyst: {
    version: ANALYST_VERSION,
    async run(env, ticker, { now, causeId }): Promise<TaskOutcome> {
      if (env.ANALYST_ENABLED !== "true") return { status: "done", detail: { skipped: "analyst disabled" } };
      return runWhenChanged(env, "analyst", "analyst", ticker, causeId, now, env.ANALYST_WORKFLOW, () => analystFingerprint(env, ticker), storedFingerprint(env, dossierCacheKey(ticker)));
    },
  },

  /** Explanations of each disclosed business, rewritten when the business list changes. */
  explainer: {
    version: BUSINESS_EXPLAINER_VERSION,
    async run(env, ticker, { now, causeId }): Promise<TaskOutcome> {
      if (!env.TAVILY_API_KEY) return { status: "done", detail: { skipped: "research search not configured" } };
      return runWhenChanged(env, "explainer", "explainer", ticker, causeId, now, env.BUSINESS_EXPLAINER_WORKFLOW,
        () => businessExplainerFingerprint(env, ticker), storedFingerprint(env, businessExplainerCacheKey(ticker)));
    },
  },

  /** The business mind map, rebuilt when the business list changes. */
  tree: {
    version: BUSINESS_TREE_VERSION,
    async run(env, ticker, { now, causeId }): Promise<TaskOutcome> {
      if (!env.TAVILY_API_KEY || env.BUSINESS_TREE_ENABLED === "false") return { status: "done", detail: { skipped: "business tree disabled" } };
      return runWhenChanged(env, "tree", "tree", ticker, causeId, now, env.BUSINESS_TREE_WORKFLOW,
        () => businessTreeFingerprint(env, ticker), storedFingerprint(env, businessTreeCacheKey(ticker)));
    },
  },

  /**
   * Starts report memory for a published periodic report. The report Workflow usually starts it already; this picks
   * up a job that was never started or whose run died, once its lease has expired.
   */
  memory: {
    version: "memory.v1",
    async run(env, ticker): Promise<TaskOutcome> {
      const result = await startCompanyMemory(env, ticker);
      if (result.started) return { status: "later", afterMs: 15 * MINUTE, detail: result };
      if (result.leasedUntil && Date.parse(result.leasedUntil) > Date.now()) return { status: "later", afterMs: until(result.leasedUntil, new Date()) + MINUTE, detail: result };
      return { status: "done", detail: result };
    },
  },

  /**
   * Company analysis recovery: settles stopped executions, starts the analysis the company is missing, and checks back
   * while one runs or until a failed run's back-off has passed.
   */
  "company-analysis": {
    version: COMPANY_ANALYSIS_PROMPT_VERSION,
    async run(env, ticker, { now }): Promise<TaskOutcome> {
      const result = await recoverCompanyAnalysis(env, ticker, now.getTime());
      if (result.running) return { status: "later", afterMs: 15 * MINUTE, detail: result };
      // A failed run whose back-off has not passed is retried then; one past it with no candidate has nothing left to try.
      if (result.nextRecoveryAt && Date.parse(result.nextRecoveryAt) > now.getTime()) return { status: "later", afterMs: until(result.nextRecoveryAt, now), detail: result };
      return { status: "done", detail: result };
    },
  },
} satisfies Record<string, TaskImplementation>;
