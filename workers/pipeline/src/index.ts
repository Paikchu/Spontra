import { NonRetryableError } from "cloudflare:workflows";
import { SecModelHttpError } from "./operations.ts";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { runCompanyAnalysisSweep, runSecRefresh, type CompanyAnalysisBackfillParams, type CompanyAnalysisWorkflowParams, type SecMemoryWorkflowParams, type SecWorkflowParams } from "./core.ts";
import { executeCompanyAnalysisWorkflow, type CompanyWorkflowStep } from "./company-analysis-workflow.ts";
import { executeSecMemoryWorkflow } from "./memory-workflow.ts";
import { createSecPipelineOperations, type SecPipelineEnv } from "./operations.ts";
import { retryDelayForAttempt, SEC_WORKFLOW_STEP_TIMEOUT } from "./retry-policy.ts";
import worker from "./worker.ts";
import { executeSecAnalysisWorkflow, type WorkflowStepContextLike, type WorkflowStepLike } from "./workflow-core.ts";

const WORKFLOW_RETRY = {
  retries: {
    limit: 3,
    // The delay function already applies backoff; avoid multiplying it a second time.
    backoff: "constant" as const,
    delay: ({ ctx }: { ctx: WorkflowStepContextLike }) => retryDelayForAttempt(ctx.attempt),
  },
  timeout: SEC_WORKFLOW_STEP_TIMEOUT,
};

function durableSteps(step: WorkflowStep): WorkflowStepLike {
  const dynamicStep = step as unknown as {
    do<T>(name: string, config: typeof WORKFLOW_RETRY, callback: (context?: WorkflowStepContextLike) => Promise<T>): Promise<T>;
  };
  return {
    do<T>(name: string, callback: (context?: WorkflowStepContextLike) => Promise<T>): Promise<T> {
      return dynamicStep.do(name, WORKFLOW_RETRY, async (context) => {
        try { return await callback(context); }
        catch (error) {
          if (error instanceof SecModelHttpError && error.status >= 400 && error.status < 500 && error.status !== 429 && error.status !== 408) {
            throw new NonRetryableError(`Model rejected request: HTTP ${error.status}`);
          }
          throw error;
        }
      });
    },
  };
}

export class SecAnalysisWorkflow extends WorkflowEntrypoint<SecPipelineEnv, SecWorkflowParams> {
  async run(event: WorkflowEvent<SecWorkflowParams>, step: WorkflowStep) {
    return executeSecAnalysisWorkflow(event.payload, event.instanceId, durableSteps(step), createSecPipelineOperations(this.env));
  }
}

export class SecMemoryWorkflow extends WorkflowEntrypoint<SecPipelineEnv, SecMemoryWorkflowParams> {
  async run(event: WorkflowEvent<SecMemoryWorkflowParams>, step: WorkflowStep) {
    return executeSecMemoryWorkflow(event.payload, event.instanceId, durableSteps(step), this.env);
  }
}

export class CompanyAnalysisWorkflow extends WorkflowEntrypoint<SecPipelineEnv, CompanyAnalysisWorkflowParams> {
  async run(event: WorkflowEvent<CompanyAnalysisWorkflowParams>, step: WorkflowStep) {
    return executeCompanyAnalysisWorkflow(
      event.payload,
      event.instanceId,
      event.timestamp,
      step as unknown as CompanyWorkflowStep,
      this.env,
    );
  }
}

export class CompanyAnalysisBackfillWorkflow extends WorkflowEntrypoint<SecPipelineEnv, CompanyAnalysisBackfillParams> {
  async run(event: WorkflowEvent<CompanyAnalysisBackfillParams>, step: WorkflowStep) {
    const durable = durableSteps(step);
    // Recovery reuses the latest completed Memory and Yahoo snapshot. Starting every SEC workflow
    // again would add unrelated model traffic precisely while recovering rate-limited Agent runs.
    const sec = event.payload.forceIncomplete === true
      ? { started: [], failed: [], skipped: true }
      : await durable.do("backfill-latest-sec", () => runSecRefresh(this.env));
    const company = await durable.do("backfill-company-analysis", () => runCompanyAnalysisSweep(
      this.env,
      { forceIncomplete: event.payload.forceIncomplete === true },
    ));
    return { sec, company };
  }
}

/**
 * The request and Cron handler lives in `./worker.ts` so it can be imported — and therefore tested
 * — without `cloudflare:workers`, which only resolves inside the Workers runtime. The Workflow
 * entrypoints above genuinely need that module, so they stay here, and this file remains the one
 * Wrangler points `main` at.
 */
export default worker;
