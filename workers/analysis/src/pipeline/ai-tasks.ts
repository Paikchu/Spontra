import { AiRunStore, quietly } from "../ai-runs/store.ts";
import { BUSINESS_EXPLAINER_VERSION, businessExplainerCacheKey, businessExplainerFingerprint } from "../business-explainer/workflow.ts";
import { BUSINESS_TREE_VERSION, businessTreeCacheKey, businessTreeFingerprint } from "../business-tree/workflow.ts";
import { COMPANY_ANALYSIS_PROMPT_VERSION } from "../company-analysis/contracts.ts";
import { recoverCompanyAnalysis, startCompanyMemory } from "../core.ts";
import { FINDINGS_VERSION, findingsFingerprint, LENS_VERSION } from "../findings/workflow.ts";
import { ANALYST_VERSION, analystFingerprint, dossierCacheKey, emptyDossierKey } from "../analyst/workflow.ts";
import { CHECKUP_NOTES_VERSION, checkupCacheKey, checkupFingerprint, emptyCheckupKey } from "../checkup/workflow.ts";
import { findingsCacheKey } from "../findings/read.ts";
import { itemsIndexKey } from "../items/read.ts";
import { ITEMS_VERSION, itemsFingerprint } from "../items/workflow.ts";
import type { AiWorkflowBinding, AnalysisEnv } from "../operations.ts";
import type { AiRunKind } from "../../../../shared/analysis-contract/ai-runs-admin.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { TaskContext, TaskImplementation, TaskOutcome } from "./tasks.ts";
import { driveWorkflow, failedInputOutcome } from "./workflow-task.ts";
import { researchSearchConfigured } from "../web-search/research-search.ts";
import { VALUATION_VERSION, valuationFingerprint } from "../valuation/workflow.ts";
import { ValuationStore } from "../valuation/store.ts";

const MINUTE = 60_000;
/** Earnings releases this recent may still have guidance on the way; a run silent this long is not waited for. */
const GUIDANCE_WAIT_WINDOW_MS = 45 * 24 * 60 * MINUTE, GUIDANCE_SILENT_MS = 2 * 24 * 60 * MINUTE;
const until = (at: string, now: Date) => Math.max(MINUTE, Date.parse(at) - now.getTime());
const slug = (ticker: string) => ticker.replace(/[^A-Za-z0-9]/g, "-");

/**
 * Runs a model Workflow when the inputs it would write from changed: `fingerprint` is the state a run would write now
 * (null while there is nothing to write from), compared with what is published. A failed run is retried on the same
 * input after a growing wait, then becomes a dead letter (workflow-task.ts).
 */
async function runWhenChanged(env: AnalysisEnv, task: "findings" | "explainer" | "tree" | "analyst" | "checkup" | "items" | "valuation", kind: AiRunKind | null, ticker: string, { causeId, now, trigger }: TaskContext,
  binding: AiWorkflowBinding<{ ticker: string; fingerprint: string }> | undefined, fingerprint: () => Promise<string | null>, published: () => Promise<string | null>): Promise<TaskOutcome> {
  return driveWorkflow(env, `${task}:${ticker}`, binding, async () => {
    const current = await fingerprint();
    if (!current || current === await published()) return null;
    // The last run failed on exactly this input: wait for its retry time, or stay until the dead letter is replayed.
    const failed = await failedInputOutcome(env, task, ticker, current, now);
    if (failed) return failed;
    const id = `${task === "findings" ? "findings" : task === "tree" ? "business-tree" : task === "analyst" ? "analyst" : task === "checkup" ? "checkup" : task === "items" ? "items" : task === "valuation" ? "valuation" : "business-explainer"}-${slug(ticker)}-${current.slice(0, 16)}-${now.getTime()}`;
    if (kind) await quietly(() => new AiRunStore(env.DB!).start({ kind, ticker, runId: id, trigger: "schedule" }, now.toISOString()));
    return { id, params: { ticker, fingerprint: current }, fingerprint: current };
  }, { deadLetter: { task, ticker, causeId }, trigger });
}

const storedFingerprint = (env: AnalysisEnv, key: string) => async () =>
  (await new D1SecRepository(env.DB!).getCache<{ fingerprint?: string }>(key))?.payload?.fingerprint ?? null;

export const AI_TASKS = {
  /**
   * Findings for the newest report, written from the map snapshot, guidance, SEC fundamentals and the company analysis.
   * While a recent earnings release's guidance is still queued or being extracted, it waits for that guidance: a
   * guidance run can take more than a day (the daily model budget), and writing first without it would write twice.
   * A run silent for two days is not waited for; a published guidance (`extracted`, `complete`) is not pending.
   */
  findings: {
    // The lens agent runs inside the findings workflow: a new lens version rewrites every company's findings once.
    version: `${FINDINGS_VERSION}:${LENS_VERSION}`,
    async run(env, ticker, context): Promise<TaskOutcome> {
      const { now } = context;
      if (env.FINDINGS_ENABLED !== "true") return { status: "done", detail: { skipped: "findings disabled" } };
      if (env.GUIDANCE_ENABLED === "true") {
        const since = new Date(now.getTime() - GUIDANCE_WAIT_WINDOW_MS).toISOString().slice(0, 10), silent = new Date(now.getTime() - GUIDANCE_SILENT_MS).toISOString();
        const pending = await env.DB!.prepare("SELECT accession, status FROM earnings_events WHERE ticker = ? AND event_date >= ? AND (status = 'queued' OR (status = 'started' AND updated_at >= ?)) LIMIT 1")
          .bind(ticker, since, silent).first<{ accession: string; status: string }>();
        if (pending) return { status: "later", afterMs: 30 * MINUTE, detail: { waiting: "guidance", accession: pending.accession, guidance: pending.status } };
      }
      return runWhenChanged(env, "findings", "findings", ticker, context, env.FINDINGS_WORKFLOW,
        () => findingsFingerprint(env, ticker), storedFingerprint(env, findingsCacheKey(ticker)));
    },
  },

  /** The analyst dossier for the served findings; reruns when the findings, the newest periodic filings or the prompt change. */
  analyst: {
    version: ANALYST_VERSION,
    async run(env, ticker, context): Promise<TaskOutcome> {
      if (env.ANALYST_ENABLED !== "true") return { status: "done", detail: { skipped: "analyst disabled" } };
      // A run that composed nothing counts as written for its input; a published dossier clears that record.
      const published = async () => await storedFingerprint(env, emptyDossierKey(ticker))() ?? await storedFingerprint(env, dossierCacheKey(ticker))();
      return runWhenChanged(env, "analyst", "analyst", ticker, context, env.ANALYST_WORKFLOW, () => analystFingerprint(env, ticker), published);
    },
  },

  /** Checkup notes: rewritten when the flags, the periodic filings in the library or the prompt change; with the analyst switch. */
  checkup: {
    version: CHECKUP_NOTES_VERSION,
    async run(env, ticker, context): Promise<TaskOutcome> {
      if (env.ANALYST_ENABLED !== "true") return { status: "done", detail: { skipped: "analyst disabled" } };
      const published = async () => await storedFingerprint(env, emptyCheckupKey(ticker))() ?? await storedFingerprint(env, checkupCacheKey(ticker))();
      return runWhenChanged(env, "checkup", "checkup", ticker, context, env.CHECKUP_WORKFLOW, () => checkupFingerprint(env, ticker), published);
    },
  },

  /**
   * The analysis of each row of the filings rail, with the AI analysis switch: a run writes the due rows that have none
   * at this version, so a new filing (or a report the library has just split) is the only work a later run does.
   */
  items: {
    version: ITEMS_VERSION,
    async run(env, ticker, context): Promise<TaskOutcome> {
      if (env.FINDINGS_ENABLED !== "true") return { status: "done", detail: { skipped: "findings disabled" } };
      return runWhenChanged(env, "items", null, ticker, context, env.ITEMS_WORKFLOW, () => itemsFingerprint(env, ticker), storedFingerprint(env, itemsIndexKey(ticker)));
    },
  },

  /** Explanations of each disclosed business, rewritten when the business list changes. */
  explainer: {
    version: BUSINESS_EXPLAINER_VERSION,
    async run(env, ticker, context): Promise<TaskOutcome> {
      if (!researchSearchConfigured(env)) return { status: "done", detail: { skipped: "research search not configured" } };
      return runWhenChanged(env, "explainer", "explainer", ticker, context, env.BUSINESS_EXPLAINER_WORKFLOW,
        () => businessExplainerFingerprint(env, ticker), storedFingerprint(env, businessExplainerCacheKey(ticker)));
    },
  },

  /** The business mind map, rebuilt when the business list changes. */
  tree: {
    version: BUSINESS_TREE_VERSION,
    async run(env, ticker, context): Promise<TaskOutcome> {
      if (!researchSearchConfigured(env) || env.BUSINESS_TREE_ENABLED === "false") return { status: "done", detail: { skipped: "business tree disabled" } };
      return runWhenChanged(env, "tree", "tree", ticker, context, env.BUSINESS_TREE_WORKFLOW,
        () => businessTreeFingerprint(env, ticker), storedFingerprint(env, businessTreeCacheKey(ticker)));
    },
  },

  /** The valuation assessment, rewritten when the figures, filings, guidance or calls it reads from change (docs/valuation-assessment-design.md). */
  valuation: {
    version: VALUATION_VERSION,
    async run(env, ticker, context): Promise<TaskOutcome> {
      if (env.VALUATION_ENABLED === "false") return { status: "done", detail: { skipped: "valuation disabled" } };
      return runWhenChanged(env, "valuation", "valuation", ticker, context, env.VALUATION_WORKFLOW,
        () => valuationFingerprint(env, ticker), () => new ValuationStore(env.DB!).publishedFingerprint(ticker));
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
