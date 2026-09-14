import {
  COMPANY_ANALYSIS_PROMPT_VERSION,
  COMPANY_ANALYSIS_SCHEMA_VERSION,
  normalizeCompanyAnalysisPublication,
} from "./company-analysis/contracts.ts";
import { COMPANY_FEATURE_FORMULA_VERSION } from "./company-analysis/feature-engine.ts";
import { buildCompanyAnalysisPacket, type CompanyAnalysisPacket } from "./company-analysis/packet.ts";
import { D1CompanyAnalysisRepository, type CompanyAnalysisRunUpdate } from "./company-analysis/repository.ts";
import { sha256 } from "./company-analysis/api.ts";
import { hashString } from "./sec/analysis.ts";
import { assertTrackedTicker, requireDb, type CompanyAnalysisWorkflowParams } from "./core.ts";
import { runCompanyAnalysisAgent } from "./company-analysis-agent.ts";
import { syncFundamentals } from "./fundamentals.ts";
import type { SecPipelineEnv } from "./operations.ts";
import { SEC_WORKFLOW_STEP_TIMEOUT } from "./retry-policy.ts";

const READINESS_DELAYS = [0, 15 * 60_000, 2 * 60 * 60_000, 8 * 60 * 60_000, 24 * 60 * 60_000, 48 * 60 * 60_000] as const;

export type CompanyWorkflowStep = {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: CompanyWorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: number): Promise<void>;
};

type CompanyWorkflowStepConfig = {
  retries: {
    limit: number;
    delay: string;
    backoff: "exponential";
  };
  timeout: string;
};

/** Each model turn is a durable checkpoint; one logical Agent session can exceed a single step. */
export const COMPANY_AGENT_MODEL_STEP_CONFIG = {
  retries: {
    limit: 3,
    delay: "1 minute",
    backoff: "exponential",
  },
  timeout: SEC_WORKFLOW_STEP_TIMEOUT,
} as const satisfies CompanyWorkflowStepConfig;

export async function executeCompanyAnalysisWorkflow(
  params: CompanyAnalysisWorkflowParams,
  workflowInstanceId: string,
  _createdAt: Date,
  step: CompanyWorkflowStep,
  env: SecPipelineEnv,
  fetcher: typeof fetch = fetch,
) {
  const analysisId = params.analysisId || `company:${params.ticker}:${hashString(`${params.triggerRef}:${workflowInstanceId}`)}`;
  const modelVersion = env.SEC_REASONING_MODEL || env.SEC_ANALYSIS_MODEL || "qwen3.8-flash";
  const statusBase = {
    analysisId,
    ticker: params.ticker,
    triggerRef: params.triggerRef,
    periodId: params.periodId,
    memoryVersion: params.memoryVersion,
    modelVersion,
    promptVersion: COMPANY_ANALYSIS_PROMPT_VERSION,
    workflowInstanceId,
  };
  try {
    const claimed = await step.do("company-run-created", () => {
      assertTrackedTicker(env, params.ticker);
      return new D1CompanyAnalysisRepository(requireDb(env)).beginRun({
        ...statusBase, status: "waiting_fundamentals", updatedAt: new Date().toISOString(),
      }, params.recoveryAttempt ?? 0, params.expectedUpdatedAt);
    });
    if (!claimed) return { status: "superseded", analysisId };
    let currentPacket: CompanyAnalysisPacket | null = null;
    for (let index = 0; index < READINESS_DELAYS.length; index += 1) {
      const delay = READINESS_DELAYS[index]!;
      if (delay > 0) {
        // Relative durable sleeps cannot target the past after queue delays or step retries.
        // Fixed intervals and names also preserve the same execution path on Workflow replay.
        await step.sleep(`yahoo-readiness-${readinessLabel(delay)}`, delay - READINESS_DELAYS[index - 1]!);
      }
      try {
        await step.do(`yahoo-refresh-${String(index).padStart(2, "0")}`, () => {
          // Staging deliberately has no production D1 binding.
          if (!env.DB) throw new Error("Pipeline has no D1 binding — fundamentals cannot be synced from this environment");
          return syncFundamentals(env.DB, params.ticker);
        });
      } catch {
        // A failed refresh does not invalidate a previously accepted Yahoo snapshot. The packet
        // below still enforces the target quarter; absent data waits instead of running the Agent.
        console.warn(JSON.stringify({ event: "company-analysis-yahoo-refresh-failed", ticker: params.ticker, index }));
      }
      currentPacket = await step.do(`current-quarter-packet-${String(index).padStart(2, "0")}`, () => readPacket(env, params, "current_quarter"));
      if (currentPacket.ready) break;
    }
    if (!currentPacket?.ready || !currentPacket.features || !currentPacket.fundamentalsDataVersion) {
      await step.do("company-run-insufficient", () => updateStatus(env, {
        ...statusBase,
        status: "insufficient_data",
        errorCode: currentPacket?.reason || "yahoo_target_period_missing",
      }));
      return { status: "insufficient_data", reason: currentPacket?.reason ?? "yahoo_target_period_missing" };
    }

    const crossPeriodPacket = await step.do("cross-period-packet", () => readPacket(env, params, "cross_period"));
    if (!crossPeriodPacket.ready || !crossPeriodPacket.features) throw new Error("Cross-period packet is not ready.");
    const inputHash = await sha256(JSON.stringify({
      ticker: params.ticker,
      periodId: params.periodId,
      memoryVersion: params.memoryVersion,
      fundamentalsDataVersion: currentPacket.fundamentalsDataVersion,
      featureFormulaVersion: COMPANY_FEATURE_FORMULA_VERSION,
      skillVersion: COMPANY_ANALYSIS_PROMPT_VERSION,
      modelVersion,
      schemaVersion: COMPANY_ANALYSIS_SCHEMA_VERSION,
    }));
    const generatedAt = await step.do("company-generation-time", async () => new Date().toISOString());
    await step.do("company-run-analyzing", () => updateStatus(env, {
      ...statusBase,
      analysisId,
      inputHash,
      fundamentalsDataVersion: currentPacket!.fundamentalsDataVersion!,
      status: "analyzing",
    }));
    const output = await runCompanyAnalysisAgent({
      env,
      fetcher,
      currentPacket: currentPacket!,
      crossPeriodPacket,
      analysisId,
      generatedAt,
      runStage: (stage, callback) => step.do(`company-agent-${stage}`, COMPANY_AGENT_MODEL_STEP_CONFIG, callback),
    });
    await step.do("company-run-validating", () => updateStatus(env, {
      ...statusBase,
      analysisId,
      inputHash,
      fundamentalsDataVersion: currentPacket!.fundamentalsDataVersion!,
      status: "validating",
    }));

    const runKey = `company-analysis/${params.ticker}/${analysisId}/run.json`;
    await step.do("company-artifact", () => env.SEC_FILINGS.put(runKey, JSON.stringify({
      params,
      inputHash,
      currentPacket,
      crossPeriodPacket,
      diagnostic: output.diagnostic,
      decision: output.decision,
      overview: output.overview,
      rounds: output.rounds,
      generatedAt,
    }), { httpMetadata: { contentType: "application/json" } }).then(() => undefined));
    const publication = normalizeCompanyAnalysisPublication({
      schemaVersion: COMPANY_ANALYSIS_SCHEMA_VERSION,
      analysisId,
      ticker: params.ticker,
      triggerRef: params.triggerRef,
      periodId: params.periodId,
      periodEnd: currentPacket.targetPeriodEnd,
      reportLabel: formatReportLabel(currentPacket.targetPeriodEnd!),
      inputHash,
      memoryVersion: params.memoryVersion,
      fundamentalsDataVersion: currentPacket.fundamentalsDataVersion,
      status: "ready",
      coverageStatus: currentPacket.features.missingMetricKeys.length ? "partial" : "complete",
      overview: output.overview,
      modelVersion,
      promptVersion: COMPANY_ANALYSIS_PROMPT_VERSION,
      generatedAt,
    });
    const published = await step.do("company-publish", () => {
      assertTrackedTicker(env, publication.ticker);
      return new D1CompanyAnalysisRepository(requireDb(env)).publish(publication);
    });
    return { status: published.duplicate ? "duplicate" : "ready", analysisId, inputHash, rounds: output.rounds };
  } catch (error) {
    await step.do("company-run-failed", () => updateStatus(env, {
      ...statusBase,
      status: "failed",
      errorCode: error instanceof Error ? error.name : "COMPANY_ANALYSIS_FAILED",
      errorDetail: error instanceof Error ? error.message : String(error),
    })).catch(() => undefined);
    throw error;
  }
}

function readPacket(
  env: SecPipelineEnv,
  params: CompanyAnalysisWorkflowParams,
  packetStage: "current_quarter" | "cross_period",
): Promise<CompanyAnalysisPacket> {
  assertTrackedTicker(env, params.ticker);
  return buildCompanyAnalysisPacket({
    database: requireDb(env),
    rawTicker: params.ticker,
    periodId: params.periodId,
    memoryVersion: params.memoryVersion,
    stage: packetStage,
  });
}

function updateStatus(env: SecPipelineEnv, value: Omit<CompanyAnalysisRunUpdate, "updatedAt">): Promise<void> {
  assertTrackedTicker(env, value.ticker);
  return new D1CompanyAnalysisRepository(requireDb(env)).upsertRun({ ...value, updatedAt: new Date().toISOString() });
}

function readinessLabel(delay: number): string {
  if (delay === 15 * 60_000) return "15m";
  if (delay === 2 * 60 * 60_000) return "02h";
  if (delay === 8 * 60 * 60_000) return "08h";
  if (delay === 24 * 60 * 60_000) return "24h";
  return "48h";
}

function formatReportLabel(periodEnd: string): string {
  const [year, month, day] = periodEnd.split("-");
  return `截至 ${year}年${Number(month)}月${Number(day)}日`;
}
