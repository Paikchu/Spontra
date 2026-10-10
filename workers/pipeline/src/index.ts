import { NonRetryableError } from "cloudflare:workflows";
import { SecModelHttpError } from "./operations.ts";
import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { handleMapRead } from "./read-api/router.ts";

import { assertTrackedTicker, type CompanyAnalysisWorkflowParams, type SecMemoryWorkflowParams, type SecWorkflowParams } from "./core.ts";
import { executeCompanyAnalysisWorkflow, type CompanyWorkflowStep } from "./company-analysis-workflow.ts";
import { executeSecMemoryWorkflow } from "./memory-workflow.ts";
import { createSecPipelineOperations, type SecPipelineEnv } from "./operations.ts";
import { retryDelayForAttempt, SEC_WORKFLOW_STEP_TIMEOUT } from "./retry-policy.ts";
import worker from "./worker.ts";
import { executeSecAnalysisWorkflow, type WorkflowStepContextLike, type WorkflowStepLike } from "./workflow-core.ts";
import { storeWorkflowResult, loadWorkflowResult } from "./workflow-results.ts";
import { executeBusinessExplainerWorkflow, type BusinessExplainerParams } from "./business-explainer/workflow.ts";
import { maintenanceAnalysisEnvironment } from "./admin/financial-maintenance-runner.ts";
import { executeGuidanceWorkflow, type GuidanceWorkflowParams } from "./guidance/workflow.ts";
import { executeFindingsWorkflow, type FindingsWorkflowParams } from "./findings/workflow.ts";
import { executeOperatingMetricsWorkflow, type OperatingMetricsParams } from "./operating-metrics/workflow.ts";
import { executeFiguresWorkflow, type FiguresWorkflowParams } from "./figures/workflow.ts";
import { trackRun, trackSleep, trackSteps } from "./ai-runs/tracking.ts";

const WORKFLOW_RETRY = {
  retries: {
    limit: 3,
    // The delay function already applies backoff; avoid multiplying it a second time.
    backoff: "constant" as const,
    delay: ({ ctx }: { ctx: WorkflowStepContextLike }) => retryDelayForAttempt(ctx.attempt),
  },
  timeout: SEC_WORKFLOW_STEP_TIMEOUT,
};

function durableSteps(step: WorkflowStep, env: SecPipelineEnv, instanceId: string): WorkflowStepLike {
  const dynamicStep = step as unknown as {
    do<T>(name: string, config: typeof WORKFLOW_RETRY, callback: (context?: WorkflowStepContextLike) => Promise<T>): Promise<T>;
  };
  return {
    async do<T>(name: string, callback: (context?: WorkflowStepContextLike) => Promise<T>): Promise<T> {
      const stored = await dynamicStep.do(name, WORKFLOW_RETRY, async (context) => {
        try { return await storeWorkflowResult(env.SEC_FILINGS, instanceId, name, await callback(context)); }
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

export class SecAnalysisWorkflow extends WorkflowEntrypoint<SecPipelineEnv, SecWorkflowParams> {
  async run(event: WorkflowEvent<SecWorkflowParams>, step: WorkflowStep) {
    const env = await maintenanceAnalysisEnvironment(this.env, event.payload, event.instanceId);
    assertTrackedTicker(env,event.payload.ticker);
    const operations = createSecPipelineOperations(env, fetch, event.instanceId);
    // One-off reports do not enroll a company in recurring memory/company analysis.
    if (event.payload.maintenanceTaskId) operations.enqueueMemory = undefined;
    return executeSecAnalysisWorkflow(event.payload, event.instanceId, durableSteps(step, env, event.instanceId), operations);
  }
}

/**
 * The public business map reads over a Service Binding to this named entrypoint. A named entrypoint
 * is unreachable from the public internet, so the binding is the credential: no key to issue, store
 * or rotate for that consumer. Only the read API is exposed here; control routes stay on the default
 * entrypoint behind SEC_REFRESH_KEY.
 */
export class MapReads extends WorkerEntrypoint<SecPipelineEnv> {
  fetch(request: Request) {
    return handleMapRead(request, this.env);
  }
}

export class BusinessExplainerWorkflow extends WorkflowEntrypoint<SecPipelineEnv, BusinessExplainerParams> {
  async run(event: WorkflowEvent<BusinessExplainerParams>, step: WorkflowStep) {
    const run = { env: this.env, kind: "explainer" as const, ticker: event.payload.ticker, runId: event.instanceId };
    return trackRun(run, () => executeBusinessExplainerWorkflow(event.payload, trackSteps(durableSteps(step, this.env, event.instanceId), run), this.env));
  }
}

export class FindingsWorkflow extends WorkflowEntrypoint<SecPipelineEnv, FindingsWorkflowParams> {
  async run(event: WorkflowEvent<FindingsWorkflowParams>, step: WorkflowStep) {
    const run = { env: this.env, kind: "findings" as const, ticker: event.payload.ticker, runId: event.instanceId };
    return trackRun(run, () => executeFindingsWorkflow(event.payload, trackSteps(durableSteps(step, this.env, event.instanceId), run), this.env));
  }
}

export class OperatingMetricsWorkflow extends WorkflowEntrypoint<SecPipelineEnv, OperatingMetricsParams> {
  async run(event: WorkflowEvent<OperatingMetricsParams>, step: WorkflowStep) {
    const run = { env: this.env, kind: "metrics" as const, ticker: event.payload.ticker, runId: event.instanceId };
    return trackRun(run, () => executeOperatingMetricsWorkflow(event.payload, trackSteps(durableSteps(step, this.env, event.instanceId), run), this.env));
  }
}

export class BusinessFiguresWorkflow extends WorkflowEntrypoint<SecPipelineEnv, FiguresWorkflowParams> {
  async run(event: WorkflowEvent<FiguresWorkflowParams>, step: WorkflowStep) {
    const run = { env: this.env, kind: "figures" as const, ticker: event.payload.ticker, runId: event.instanceId };
    return trackRun(run, () => executeFiguresWorkflow(event.payload, trackSteps(durableSteps(step, this.env, event.instanceId), run), this.env));
  }
}

export class GuidanceWorkflow extends WorkflowEntrypoint<SecPipelineEnv, GuidanceWorkflowParams> {
  async run(event: WorkflowEvent<GuidanceWorkflowParams>, step: WorkflowStep) {
    const run = { env: this.env, kind: "guidance" as const, ticker: event.payload.ticker, runId: event.instanceId };
    const durable = trackSteps(durableSteps(step, this.env, event.instanceId), run);
    // Waiting for a transcript sleeps the instance; a sleeping Workflow uses no CPU.
    const sleep = trackSleep((name, ms) => step.sleep(name, Math.max(1000, Math.round(ms))), run);
    return trackRun(run, () => executeGuidanceWorkflow(event.payload, { do: durable.do, sleep }, this.env));
  }
}

export class SecMemoryWorkflow extends WorkflowEntrypoint<SecPipelineEnv, SecMemoryWorkflowParams> {
  async run(event: WorkflowEvent<SecMemoryWorkflowParams>, step: WorkflowStep) {
    assertTrackedTicker(this.env,event.payload.ticker);
    return executeSecMemoryWorkflow(event.payload, event.instanceId, durableSteps(step, this.env, event.instanceId), this.env);
  }
}

export class CompanyAnalysisWorkflow extends WorkflowEntrypoint<SecPipelineEnv, CompanyAnalysisWorkflowParams> {
  async run(event: WorkflowEvent<CompanyAnalysisWorkflowParams>, step: WorkflowStep) {
    assertTrackedTicker(this.env,event.payload.ticker);
    return executeCompanyAnalysisWorkflow(
      event.payload,
      event.instanceId,
      event.timestamp,
      step as unknown as CompanyWorkflowStep,
      this.env,
    );
  }
}

/**
 * The request and Cron handler lives in `./worker.ts` so it can be imported — and therefore tested
 * — without `cloudflare:workers`, which only resolves inside the Workers runtime. The Workflow
 * entrypoints above genuinely need that module, so they stay here, and this file remains the one
 * Wrangler points `main` at.
 */
export default worker;
