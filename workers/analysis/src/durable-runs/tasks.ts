import { companyPolicyEnvironment } from "../financial-data/company-policy.ts";
import { maintenanceAnalysisEnvironment } from "../admin/financial-maintenance-runner.ts";
import { assertFeatureTicker, assertTrackedTicker, scheduledAnalysisAllowed, type CompanyAnalysisWorkflowParams, type SecMemoryWorkflowParams, type SecWorkflowParams } from "../core.ts";
import { createAnalysisOperations, SecModelHttpError, type AnalysisEnv } from "../operations.ts";
import { retryDelayForAttempt, SEC_WORKFLOW_STEP_TIMEOUT } from "../retry-policy.ts";
import { executeSecAnalysisWorkflow, type WorkflowStepLike } from "../workflow-core.ts";
import { storeWorkflowResult, loadWorkflowResult } from "../workflow-results.ts";
import { executeCompanyAnalysisWorkflow } from "../company-analysis-workflow.ts";
import { executeSecMemoryWorkflow } from "../memory-workflow.ts";
import { executeReportWorkflow, type ReportParams } from "../stage/report-workflow.ts";
import { executeBusinessExplainerWorkflow, type BusinessExplainerParams } from "../business-explainer/workflow.ts";
import { executeBusinessTreeWorkflow, type BusinessTreeParams } from "../business-tree/workflow.ts";
import { executeValuationWorkflow, type ValuationWorkflowParams } from "../valuation/workflow.ts";
import { executeValuationEvaluation, type ValuationEvaluationParams } from "../valuation/evaluation.ts";
import { executeGuidanceWorkflow, type GuidanceWorkflowParams } from "../guidance/workflow.ts";
import { executeFindingsWorkflow, type FindingsWorkflowParams } from "../findings/workflow.ts";
import { executeItemsWorkflow, type ItemsParams } from "../items/workflow.ts";
import { executeAnalystWorkflow, type AnalystWorkflowParams } from "../analyst/workflow.ts";
import { executeCheckupWorkflow, type CheckupWorkflowParams } from "../checkup/workflow.ts";
import { executeLibraryCardsWorkflow, type LibraryCardsParams } from "../filing-library/cards.ts";
import { executeLibraryLinksWorkflow, type LibraryLinksParams } from "../filing-library/links.ts";
import { executeBusinessTagsWorkflow, type BusinessTagsParams } from "../business-tags/workflow.ts";
import { executeTranslateWorkflow, type TranslateParams } from "../translation/translate.ts";
import { trackRun, trackSleep, trackSteps } from "../ai-runs/tracking.ts";
import { NonRetryableError, type RunStep, type StepConfig } from "./engine.ts";
import type { RunKind } from "./binding.ts";

export type RunContext = { env: AnalysisEnv; step: RunStep; id: string; timestamp: Date };
type Task = (params: never, run: RunContext) => Promise<unknown>;

const STEP_RETRY = {
  // The delay function already applies backoff.
  retries: { limit: 3, backoff: "constant", delay: ({ ctx }) => retryDelayForAttempt(ctx.attempt) },
  timeout: SEC_WORKFLOW_STEP_TIMEOUT,
} satisfies StepConfig;

/** The analysis steps: large results go to R2, and a provider's refusal of the request itself is final. */
function durableSteps(step: RunStep, env: AnalysisEnv, runId: string): WorkflowStepLike {
  return {
    // A session's outcome carries its whole trail and state, which can pass what one journal row holds.
    waitFor: async <T>(name: string, check: () => Promise<T | null>, recheck: Parameters<RunStep["waitFor"]>[2]) => loadWorkflowResult<T>(env.SEC_FILINGS, await step.waitFor(name, async () => {
      const value = await check();
      return value === null ? null : await storeWorkflowResult(env.SEC_FILINGS, runId, name, value);
    }, recheck) as never),
    async do<T>(name: string, callback: (context?: { attempt: number }) => Promise<T>): Promise<T> {
      const stored = await step.do(name, STEP_RETRY, async (context) => {
        try { return await storeWorkflowResult(env.SEC_FILINGS, runId, name, await callback(context)); }
        catch (error) {
          if (error instanceof SecModelHttpError && error.status >= 400 && error.status < 500 && error.status !== 429 && error.status !== 408) {
            // The request layer redacts the credential before constructing this message.
            throw new NonRetryableError(`${error.providerCode ? `[${error.providerCode}] ` : ""}${error.message.slice(0, 1000)}`);
          }
          throw error;
        }
      });
      for (let attempt = 0; ; attempt++) {
        try { return await loadWorkflowResult<T>(env.SEC_FILINGS, stored); }
        catch (error) {
          if (attempt >= 2 || /integrity|Invalid stored|missing/.test(String(error))) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 1000 * 3 ** attempt));
        }
      }
    },
  };
}

const sleeper = (step: RunStep) => (name: string, ms: number) => step.sleep(name, Math.max(1000, Math.round(ms)));

/** What each run kind executes; the bodies the Workflow classes had. */
export const RUN_TASKS: Record<RunKind, Task> = {
  async SEC_ANALYSIS_WORKFLOW(params: SecWorkflowParams, { env: raw, step, id }) {
    const env = await maintenanceAnalysisEnvironment(await companyPolicyEnvironment(raw), params, id);
    // A scheduled run that finds the company gone from the reports list completes with nothing to publish.
    if (!scheduledAnalysisAllowed(env, params)) return { analyzed: [], skipped: [], failed: [] };
    assertTrackedTicker(env, params.ticker);
    const operations = createAnalysisOperations(env, fetch, id);
    // One-off reports do not enroll a company in recurring memory/company analysis.
    if (params.maintenanceTaskId) operations.enqueueMemory = undefined;
    return executeSecAnalysisWorkflow(params, id, durableSteps(step, env, id), operations);
  },
  async BUSINESS_EXPLAINER_WORKFLOW(params: BusinessExplainerParams, { env: raw, step, id }) {
    const env = await companyPolicyEnvironment(raw);
    const run = { env, kind: "explainer" as const, ticker: params.ticker, runId: id };
    return trackRun(run, () => executeBusinessExplainerWorkflow(params, trackSteps(durableSteps(step, env, id), run), env, fetch, id));
  },
  async BUSINESS_TREE_WORKFLOW(params: BusinessTreeParams, { env: raw, step, id }) {
    const env = await companyPolicyEnvironment(raw);
    const run = { env, kind: "tree" as const, ticker: params.ticker, runId: id };
    return trackRun(run, () => executeBusinessTreeWorkflow(params, trackSteps(durableSteps(step, env, id), run), env, fetch, id));
  },
  async VALUATION_WORKFLOW(params: ValuationWorkflowParams | ValuationEvaluationParams, { env: raw, step, id }) {
    const env = await companyPolicyEnvironment(raw);
    if ("evaluationId" in params) return executeValuationEvaluation(params, durableSteps(step, env, id), env, id);
    const run = { env, kind: "valuation" as const, ticker: params.ticker, runId: id };
    return trackRun(run, () => executeValuationWorkflow(params, trackSteps(durableSteps(step, env, id), run), env, fetch, id));
  },
  async TRANSLATE_WORKFLOW(params: TranslateParams, { env: raw, step, id }) {
    const env = await companyPolicyEnvironment(raw);
    return executeTranslateWorkflow(params, durableSteps(step, env, id), env, id);
  },
  async LIBRARY_CARDS_WORKFLOW(params: LibraryCardsParams, { env: raw, step, id }) {
    const env = await companyPolicyEnvironment(raw);
    return executeLibraryCardsWorkflow(params, durableSteps(step, env, id), env);
  },
  async LIBRARY_LINKS_WORKFLOW(params: LibraryLinksParams, { env: raw, step, id }) {
    const env = await companyPolicyEnvironment(raw);
    return executeLibraryLinksWorkflow(params, durableSteps(step, env, id), env);
  },
  async BUSINESS_TAGS_WORKFLOW(params: BusinessTagsParams, { env: raw, step, id }) {
    const env = await companyPolicyEnvironment(raw);
    return executeBusinessTagsWorkflow(params, durableSteps(step, env, id), env);
  },
  async ANALYST_WORKFLOW(params: AnalystWorkflowParams, { env: raw, step, id }) {
    const env = await companyPolicyEnvironment(raw);
    const run = { env, kind: "analyst" as const, ticker: params.ticker, runId: id };
    // A provider outage makes the run wait (analyst/workflow.ts); a waiting run holds no CPU.
    const sleep = trackSleep(sleeper(step), run);
    return trackRun(run, () => executeAnalystWorkflow(params, trackSteps(durableSteps(step, env, id), run), env, { sleep, runId: id }));
  },
  async CHECKUP_WORKFLOW(params: CheckupWorkflowParams, { env: raw, step, id }) {
    const env = await companyPolicyEnvironment(raw);
    const run = { env, kind: "checkup" as const, ticker: params.ticker, runId: id };
    return trackRun(run, () => executeCheckupWorkflow(params, trackSteps(durableSteps(step, env, id), run), env, { runId: id }));
  },
  async FINDINGS_WORKFLOW(params: FindingsWorkflowParams, { env: raw, step, id }) {
    const env = await companyPolicyEnvironment(raw);
    const run = { env, kind: "findings" as const, ticker: params.ticker, runId: id };
    return trackRun(run, () => executeFindingsWorkflow(params, trackSteps(durableSteps(step, env, id), run), env));
  },
  async ITEMS_WORKFLOW(params: ItemsParams, { env: raw, step, id }) {
    const env = await companyPolicyEnvironment(raw);
    return executeItemsWorkflow(params, durableSteps(step, env, id), env, id);
  },
  async GUIDANCE_WORKFLOW(params: GuidanceWorkflowParams, { env: raw, step, id }) {
    const env = await companyPolicyEnvironment(raw);
    const run = { env, kind: "guidance" as const, ticker: params.ticker, runId: id };
    const durable = trackSteps(durableSteps(step, env, id), run);
    // Waiting for the daily model budget makes the run wait; a waiting run holds no CPU.
    const sleep = trackSleep(sleeper(step), run);
    return trackRun(run, () => executeGuidanceWorkflow(params, { do: durable.do, sleep }, env, { runId: id }));
  },
  async SEC_MEMORY_WORKFLOW(params: SecMemoryWorkflowParams, { env: raw, step, id }) {
    const env = await companyPolicyEnvironment(raw);
    assertFeatureTicker(env, "findings", params.ticker);
    return executeSecMemoryWorkflow(params, id, durableSteps(step, env, id), env);
  },
  async COMPANY_ANALYSIS_WORKFLOW(params: CompanyAnalysisWorkflowParams, { env: raw, step, id, timestamp }) {
    const env = await companyPolicyEnvironment(raw);
    assertFeatureTicker(env, "findings", params.ticker);
    return executeCompanyAnalysisWorkflow(params, id, timestamp, step, env);
  },
  async REPORT_WORKFLOW(params: ReportParams, { env: raw, step, id }) {
    const env = await companyPolicyEnvironment(raw);
    return executeReportWorkflow(params, durableSteps(step, env, id), env as AnalysisEnv & { StageAgent?: DurableObjectNamespace }, id);
  },
};
