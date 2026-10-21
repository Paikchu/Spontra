import { NonRetryableError } from "cloudflare:workflows";
import { SecModelHttpError } from "./operations.ts";
import { companyPolicyEnvironment } from "./financial-data/company-policy.ts";
import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { handleMapRead } from "./read-api/router.ts";
import { handleStageRequest } from "./stage/gateway.ts";
import { executeReportWorkflow, type ReportParams } from "./stage/report-workflow.ts";

import { assertTrackedTicker, type CompanyAnalysisWorkflowParams, type SecMemoryWorkflowParams, type SecWorkflowParams } from "./core.ts";
import { executeCompanyAnalysisWorkflow, type CompanyWorkflowStep } from "./company-analysis-workflow.ts";
import { executeSecMemoryWorkflow } from "./memory-workflow.ts";
import { createAnalysisOperations, type AnalysisEnv } from "./operations.ts";
import { retryDelayForAttempt, SEC_WORKFLOW_STEP_TIMEOUT } from "./retry-policy.ts";
import worker from "./worker.ts";
import { executeSecAnalysisWorkflow, type WorkflowStepContextLike, type WorkflowStepLike } from "./workflow-core.ts";
import { storeWorkflowResult, loadWorkflowResult } from "./workflow-results.ts";
import { executeBusinessExplainerWorkflow, type BusinessExplainerParams } from "./business-explainer/workflow.ts";
import { executeBusinessTreeWorkflow, type BusinessTreeParams } from "./business-tree/workflow.ts";
import { maintenanceAnalysisEnvironment } from "./admin/financial-maintenance-runner.ts";
import { executeGuidanceWorkflow, type GuidanceWorkflowParams } from "./guidance/workflow.ts";
import { executeFindingsWorkflow, type FindingsWorkflowParams } from "./findings/workflow.ts";
import { executeItemsWorkflow, type ItemsParams } from "./items/workflow.ts";
import { executeAnalystWorkflow, type AnalystWorkflowParams } from "./analyst/workflow.ts";
import { executeCheckupWorkflow, type CheckupWorkflowParams } from "./checkup/workflow.ts";
import { trackRun, trackSleep, trackSteps } from "./ai-runs/tracking.ts";
import { executeLibraryCardsWorkflow, type LibraryCardsParams } from "./filing-library/cards.ts";
import { executeLibraryLinksWorkflow, type LibraryLinksParams } from "./filing-library/links.ts";
import { executeBusinessTagsWorkflow, type BusinessTagsParams } from "./business-tags/workflow.ts";
import { executeTranslateWorkflow, type TranslateParams } from "./translation/translate.ts";

const WORKFLOW_RETRY = {
  retries: {
    limit: 3,
    // The delay function already applies backoff; avoid multiplying it a second time.
    backoff: "constant" as const,
    delay: ({ ctx }: { ctx: WorkflowStepContextLike }) => retryDelayForAttempt(ctx.attempt),
  },
  timeout: SEC_WORKFLOW_STEP_TIMEOUT,
};

function durableSteps(step: WorkflowStep, env: AnalysisEnv, instanceId: string): WorkflowStepLike {
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

export class SecAnalysisWorkflow extends WorkflowEntrypoint<AnalysisEnv, SecWorkflowParams> {
  async run(event: WorkflowEvent<SecWorkflowParams>, step: WorkflowStep) {
    const env = await maintenanceAnalysisEnvironment(await companyPolicyEnvironment(this.env), event.payload, event.instanceId);
    assertTrackedTicker(env,event.payload.ticker);
    const operations = createAnalysisOperations(env, fetch, event.instanceId);
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
export class MapReads extends WorkerEntrypoint<AnalysisEnv> {
  fetch(request: Request) {
    return handleMapRead(request, this.env);
  }
}

export class BusinessExplainerWorkflow extends WorkflowEntrypoint<AnalysisEnv, BusinessExplainerParams> {
  async run(event: WorkflowEvent<BusinessExplainerParams>, step: WorkflowStep) {
    const env = await companyPolicyEnvironment(this.env);
    const run = { env, kind: "explainer" as const, ticker: event.payload.ticker, runId: event.instanceId };
    return trackRun(run, () => executeBusinessExplainerWorkflow(event.payload, trackSteps(durableSteps(step, env, event.instanceId), run), env, fetch, event.instanceId));
  }
}

/** The ReAct business breakdown: one think → act loop per disclosed business, each turn a durable step. */
export class BusinessTreeWorkflow extends WorkflowEntrypoint<AnalysisEnv, BusinessTreeParams> {
  async run(event: WorkflowEvent<BusinessTreeParams>, step: WorkflowStep) {
    const env = await companyPolicyEnvironment(this.env);
    const run = { env, kind: "tree" as const, ticker: event.payload.ticker, runId: event.instanceId };
    return trackRun(run, () => executeBusinessTreeWorkflow(event.payload, trackSteps(durableSteps(step, env, event.instanceId), run), env, fetch, event.instanceId));
  }
}

/** Index cards for one company's recent library sections; each batch of sections is a durable step. */
/** One company's translation run: the strings of its publications not yet translated, then every resource's table. */
export class TranslateWorkflow extends WorkflowEntrypoint<AnalysisEnv, TranslateParams> {
  async run(event: WorkflowEvent<TranslateParams>, step: WorkflowStep) {
    const env = await companyPolicyEnvironment(this.env);
    return executeTranslateWorkflow(event.payload, durableSteps(step, env, event.instanceId), env, event.instanceId);
  }
}

export class LibraryCardsWorkflow extends WorkflowEntrypoint<AnalysisEnv, LibraryCardsParams> {
  async run(event: WorkflowEvent<LibraryCardsParams>, step: WorkflowStep) {
    const env = await companyPolicyEnvironment(this.env);
    return executeLibraryCardsWorkflow(event.payload, durableSteps(step, env, event.instanceId), env);
  }
}

/** One company's business links: a single model call at high reasoning, checked and written in one durable step. */
export class LibraryLinksWorkflow extends WorkflowEntrypoint<AnalysisEnv, LibraryLinksParams> {
  async run(event: WorkflowEvent<LibraryLinksParams>, step: WorkflowStep) {
    const env = await companyPolicyEnvironment(this.env);
    return executeLibraryLinksWorkflow(event.payload, durableSteps(step, env, event.instanceId), env);
  }
}

/** One company's units, business tags and pairs: two model calls at high reasoning, then embedding and matching. */
export class BusinessTagsWorkflow extends WorkflowEntrypoint<AnalysisEnv, BusinessTagsParams> {
  async run(event: WorkflowEvent<BusinessTagsParams>, step: WorkflowStep) {
    const env = await companyPolicyEnvironment(this.env);
    return executeBusinessTagsWorkflow(event.payload, durableSteps(step, env, event.instanceId), env);
  }
}

export class AnalystWorkflow extends WorkflowEntrypoint<AnalysisEnv, AnalystWorkflowParams> {
  async run(event: WorkflowEvent<AnalystWorkflowParams>, step: WorkflowStep) {
    const env = await companyPolicyEnvironment(this.env);
    const run = { env, kind: "analyst" as const, ticker: event.payload.ticker, runId: event.instanceId };
    // A provider outage makes the run wait (analyst/workflow.ts); a sleeping Workflow uses no CPU.
    const sleep = trackSleep((name, ms) => step.sleep(name, Math.max(1000, Math.round(ms))), run);
    return trackRun(run, () => executeAnalystWorkflow(event.payload, trackSteps(durableSteps(step, env, event.instanceId), run), env, { sleep }));
  }
}

/** Checkup notes: a written analysis of each flagged metric, read against the current and earlier filings. */
export class CheckupWorkflow extends WorkflowEntrypoint<AnalysisEnv, CheckupWorkflowParams> {
  async run(event: WorkflowEvent<CheckupWorkflowParams>, step: WorkflowStep) {
    const env = await companyPolicyEnvironment(this.env);
    const run = { env, kind: "checkup" as const, ticker: event.payload.ticker, runId: event.instanceId };
    return trackRun(run, () => executeCheckupWorkflow(event.payload, trackSteps(durableSteps(step, env, event.instanceId), run), env));
  }
}

export class FindingsWorkflow extends WorkflowEntrypoint<AnalysisEnv, FindingsWorkflowParams> {
  async run(event: WorkflowEvent<FindingsWorkflowParams>, step: WorkflowStep) {
    const env = await companyPolicyEnvironment(this.env);
    const run = { env, kind: "findings" as const, ticker: event.payload.ticker, runId: event.instanceId };
    return trackRun(run, () => executeFindingsWorkflow(event.payload, trackSteps(durableSteps(step, env, event.instanceId), run), env));
  }
}

/** The analysis of each due row of one company's filings rail; every model turn and outside read is a durable step. */
export class ItemsWorkflow extends WorkflowEntrypoint<AnalysisEnv, ItemsParams> {
  async run(event: WorkflowEvent<ItemsParams>, step: WorkflowStep) {
    const env = await companyPolicyEnvironment(this.env);
    return executeItemsWorkflow(event.payload, durableSteps(step, env, event.instanceId), env, event.instanceId);
  }
}

export class GuidanceWorkflow extends WorkflowEntrypoint<AnalysisEnv, GuidanceWorkflowParams> {
  async run(event: WorkflowEvent<GuidanceWorkflowParams>, step: WorkflowStep) {
    const env = await companyPolicyEnvironment(this.env);
    const run = { env, kind: "guidance" as const, ticker: event.payload.ticker, runId: event.instanceId };
    const durable = trackSteps(durableSteps(step, env, event.instanceId), run);
    // Waiting for the daily model budget sleeps the instance; a sleeping Workflow uses no CPU.
    const sleep = trackSleep((name, ms) => step.sleep(name, Math.max(1000, Math.round(ms))), run);
    return trackRun(run, () => executeGuidanceWorkflow(event.payload, { do: durable.do, sleep }, env, { runId: event.instanceId }));
  }
}

export class SecMemoryWorkflow extends WorkflowEntrypoint<AnalysisEnv, SecMemoryWorkflowParams> {
  async run(event: WorkflowEvent<SecMemoryWorkflowParams>, step: WorkflowStep) {
    const env = await companyPolicyEnvironment(this.env);
    assertTrackedTicker(env,event.payload.ticker);
    return executeSecMemoryWorkflow(event.payload, event.instanceId, durableSteps(step, env, event.instanceId), env);
  }
}

export class CompanyAnalysisWorkflow extends WorkflowEntrypoint<AnalysisEnv, CompanyAnalysisWorkflowParams> {
  async run(event: WorkflowEvent<CompanyAnalysisWorkflowParams>, step: WorkflowStep) {
    const env = await companyPolicyEnvironment(this.env);
    assertTrackedTicker(env,event.payload.ticker);
    return executeCompanyAnalysisWorkflow(
      event.payload,
      event.instanceId,
      event.timestamp,
      step as unknown as CompanyWorkflowStep,
      env,
    );
  }
}

/**
 * The request and Cron handler lives in `./worker.ts` so it can be imported — and therefore tested
 * — without `cloudflare:workers`, which only resolves inside the Workers runtime. The Workflow
 * entrypoints above genuinely need that module, so they stay here, and this file remains the one
 * Wrangler points `main` at.
 */
export { StageAgent } from "./stage/agent.ts";

/** A report a reader of the stage asked for (docs/stage-agent-design.md §6.3), started by their StageAgent. */
export class ReportWorkflow extends WorkflowEntrypoint<AnalysisEnv, ReportParams> {
  async run(event: WorkflowEvent<ReportParams>, step: WorkflowStep) {
    const env = await companyPolicyEnvironment(this.env);
    return executeReportWorkflow(event.payload, durableSteps(step, env, event.instanceId), env as AnalysisEnv & { StageAgent?: DurableObjectNamespace }, event.instanceId);
  }
}

/**
 * The stage's door (docs/stage-agent-design.md §3.1): the business map reaches it over its own Service Binding to
 * this named entrypoint, never from the public internet.
 */
export class StageGateway extends WorkerEntrypoint<AnalysisEnv> {
  async fetch(request: Request) {
    try { return await handleStageRequest(request, this.env as AnalysisEnv & { StageAgent?: DurableObjectNamespace }); }
    catch (error) {
      console.error(JSON.stringify({ event: "stage-gateway", outcome: "error", path: new URL(request.url).pathname, error: error instanceof Error ? error.message : String(error) }));
      return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
    }
  }
}

export default worker;
