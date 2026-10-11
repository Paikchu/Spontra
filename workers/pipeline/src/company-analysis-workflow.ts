import { reasoningFor } from "./ai-config.ts";
import {
  COMPANY_ANALYSIS_PROMPT_VERSION,
  COMPANY_ANALYSIS_SCHEMA_VERSION,
  normalizeCompanyAnalysisPublication,
} from "./company-analysis/contracts.ts";
import { buildCompanyAnalysisPacket, type CompanyAnalysisPacket } from "./company-analysis/packet.ts";
import { D1CompanyAnalysisRepository, type CompanyAnalysisRunUpdate } from "./company-analysis/repository.ts";
import { sha256 } from "./company-analysis/api.ts";
import { hashString } from "./sec/analysis.ts";
import { assertTrackedTicker, requireDb, type CompanyAnalysisWorkflowParams } from "./core.ts";
import { runBusinessModelAgent } from "./company-analysis/business-agent.ts";
import { createBusinessResearchTools } from "./company-analysis/business-tools.ts";
import { findSecurity } from "./catalog/security-directory.ts";
import { researchSearch } from "./web-search/research-search.ts";
import { callWorkerSecModel } from "./operations.ts";
import type { SecPipelineEnv } from "./operations.ts";
import { SEC_WORKFLOW_STEP_TIMEOUT } from "./retry-policy.ts";
import { FUNDAMENTALS_STALE_AFTER_MS } from "../../../shared/analysis-contract/fundamentals.ts";
import { D1FundamentalsRepository } from "./fundamentals/fundamentals-d1.ts";
import { syncFundamentals } from "./fundamentals.ts";

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

async function refreshFundamentalsIfStale(env: SecPipelineEnv, ticker: string): Promise<{ refreshed: boolean; error?: string }> {
  const [freshness] = await new D1FundamentalsRepository(requireDb(env)).listFundamentalsFreshness([ticker]);
  if (freshness?.fetchedAt && Date.now() - Date.parse(freshness.fetchedAt) < FUNDAMENTALS_STALE_AFTER_MS) return { refreshed: false };
  try { await syncFundamentals(requireDb(env), ticker); return { refreshed: true }; }
  catch (error) { return { refreshed: false, error: error instanceof Error ? error.message.slice(0, 200) : "sync failed" }; }
}

export async function executeCompanyAnalysisWorkflow(
  params: CompanyAnalysisWorkflowParams,
  workflowInstanceId: string,
  _createdAt: Date,
  step: CompanyWorkflowStep,
  env: SecPipelineEnv,
  fetcher: typeof fetch = fetch,
) {
  const analysisId = params.analysisId || `company:${params.ticker}:${hashString(`${params.triggerRef}:${workflowInstanceId}`)}`;
  const modelVersion = env.SEC_REASONING_MODEL || env.SEC_ANALYSIS_MODEL || "deepseek-flash";
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
    // The Yahoo fundamentals in the packet are refreshed here, when an analysis needs them, rather than on a
    // schedule. A failed refresh keeps the last good snapshot: SEC reports and business evidence are the main inputs.
    await step.do("fundamentals-refresh", () => refreshFundamentalsIfStale(env, params.ticker));
    const packet = await step.do("business-packet", () => readPacket(env, params, "cross_period"));
    const generatedAt = await step.do("company-generation-time", async () => new Date().toISOString());
    const tools = createBusinessResearchTools({
      database: requireDb(env), search: researchSearch(env), ticker: params.ticker,
      reportDate: packet.reportDate, now: generatedAt,
    });
    const availableSecReports = await step.do("business-sec-versions", () => tools.availableReports());
    const fundamentalsDataVersion = packet.fundamentalsDataVersion ?? "fundamentals-unavailable";
    const inputHash = await sha256(JSON.stringify({
      ticker: params.ticker,
      periodId: params.periodId,
      triggerRef: params.triggerRef,
      memoryVersion: params.memoryVersion,
      fundamentalsDataVersion,
      secReportVersions: availableSecReports,
      skillVersion: COMPANY_ANALYSIS_PROMPT_VERSION,
      modelVersion,
      schemaVersion: COMPANY_ANALYSIS_SCHEMA_VERSION,
    }));
    await step.do("company-run-analyzing", () => updateStatus(env, {
      ...statusBase,
      analysisId,
      inputHash,
      fundamentalsDataVersion,
      status: "analyzing",
    }));
    const output = await runBusinessModelAgent({
      ticker: params.ticker, companyName: findSecurity(params.ticker)?.name ?? params.ticker,
      reportDate: packet.reportDate, now: generatedAt, tools,
      model: (stage, system, payload) => callWorkerSecModel(env, fetcher, stage, system, payload, modelVersion, 5 * 60_000, true, { reasoning: reasoningFor(env, "company-analysis") }),
      runStage: (name, callback) => step.do(`business-agent-${name}`, COMPANY_AGENT_MODEL_STEP_CONFIG, callback),
    });
    await step.do("company-run-validating", () => updateStatus(env, {
      ...statusBase,
      analysisId,
      inputHash,
      fundamentalsDataVersion,
      status: "validating",
    }));

    const runKey = `company-analysis/${params.ticker}/${analysisId}/run.json`;
    await step.do("company-artifact", () => env.SEC_FILINGS.put(runKey, JSON.stringify({
      params,
      inputHash,
      packet,
      sources: output.overview.deepDive?.sources,
      observations: output.observations,
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
      periodEnd: packet.targetPeriodEnd ?? packet.reportDate,
      reportLabel: formatReportLabel(packet.reportDate),
      inputHash,
      memoryVersion: params.memoryVersion,
      fundamentalsDataVersion,
      status: "ready",
      coverageStatus: output.overview.deepDive?.sources.some((source) => source.kind === "sec")
        && output.overview.deepDive.sources.some((source) => source.kind === "web")
        && !output.overview.deepDive.limitations.length ? "complete" : "partial",
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

function formatReportLabel(periodEnd: string): string {
  const date = new Date(`${periodEnd}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? `As of ${periodEnd}` : `As of ${new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(date)}`;
}
