import type { BusinessExplainer } from "../../../../shared/analysis-contract/business-explainer.ts";
import type { PlannedFigures, PlannedFiguresResponse } from "../../../../shared/analysis-contract/business-figures.ts";
import type { CompanyNarrative } from "../../../../shared/analysis-contract/business-narrative.ts";
import { readBusinessExplainer } from "../../../../shared/analysis-runtime/business-explainer.ts";
import { readPlannedFigures } from "../../../../shared/analysis-runtime/business-figures.ts";
import { readCompanyNarrative } from "../../../../shared/analysis-runtime/business-narrative.ts";
import { readOperatingMetrics } from "../../../../shared/analysis-runtime/operating-metrics.ts";
import { AiRunStore, quietly } from "../ai-runs/store.ts";
import { businessExplainerCacheKey } from "../business-explainer/workflow.ts";
import { findSecurity } from "../catalog/security-directory.ts";
import { sha256 } from "../company-analysis/api.ts";
import { assertTrackedTicker, requireDb, trackedTickersFor } from "../core.ts";
import { narrativeCacheKey } from "../narrative/read.ts";
import { operatingMetricsCacheKey } from "../operating-metrics/read.ts";
import { findingsCacheKey } from "../findings/read.ts";
import { readFindingsPublication } from "../../../../shared/analysis-runtime/findings.ts";
import { callWorkerSecModel, type SecPipelineEnv } from "../operations.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { businessNames, companyNames, FIGURES_PLANNER_VERSION, planFigures } from "./planner.ts";

export const figuresCacheKey = (ticker: string) => `figures:v1:${ticker}`;
export type FiguresWorkflowParams = { ticker: string; fingerprint: string };

/** What a plan is made from; the plan is re-made when any of it moves. */
async function readInput(env: SecPipelineEnv, ticker: string) {
  const repository = new D1SecRepository(requireDb(env));
  const [explainerRow, metricsRow, narrativeRow, findingsRow] = await Promise.all([
    repository.getCache<unknown>(businessExplainerCacheKey(ticker)), repository.getCache<unknown>(operatingMetricsCacheKey(ticker)), repository.getCache<unknown>(narrativeCacheKey(ticker)), repository.getCache<unknown>(findingsCacheKey(ticker)),
  ]);
  const explainer = explainerRow ? readBusinessExplainer(explainerRow.payload, ticker) : null;
  if (!explainer) return null;
  const metrics = metricsRow ? readOperatingMetrics(metricsRow.payload, ticker) : null;
  const narrative = narrativeRow ? readCompanyNarrative(narrativeRow.payload, ticker) : null;
  const findings = findingsRow ? readFindingsPublication(findingsRow.payload, ticker) : null;
  const fingerprint = await sha256(JSON.stringify({ version: FIGURES_PLANNER_VERSION, ticker, explainer: explainer.fingerprint, generatedAt: explainer.generatedAt, metrics: metrics?.generatedAt ?? null, narrative: narrative?.generatedAt ?? null, findings: findings?.generatedAt ?? null }));
  return { explainer, metrics, narrative, findings, fingerprint };
}

/** Starts at most one plan per tick, for a company whose explainer, metrics or narrative moved since its last plan. */
export async function runFiguresSweep(env: SecPipelineEnv, now = Date.now()): Promise<{ checked: number; started: string[]; failed: string[] }> {
  const result = { checked: 0, started: [] as string[], failed: [] as string[] };
  if (!env.FIGURES_WORKFLOW || !env.DB || env.FIGURES_ENABLED !== "true") return result;
  const repository = new D1SecRepository(env.DB);
  for (const ticker of trackedTickersFor(env)) {
    result.checked++;
    try {
      const input = await readInput(env, ticker);
      if (!input) continue;
      const stored = await repository.getCache<PlannedFigures>(figuresCacheKey(ticker));
      if (stored?.payload?.fingerprint === input.fingerprint) continue;
      const week = Math.floor(now / (7 * 24 * 60 * 60_000));
      const id = `figures-${ticker.replace(/[^A-Za-z0-9]/g, "-")}-${input.fingerprint.slice(0, 16)}-${week}`;
      await env.FIGURES_WORKFLOW.create({ id, params: { ticker, fingerprint: input.fingerprint } });
      await quietly(() => new AiRunStore(env.DB!).start({ kind: "figures", ticker, runId: id, trigger: "schedule" }, new Date(now).toISOString()));
      result.started.push(ticker);
      return result;
    } catch (error) {
      if (!/already exists|duplicate/i.test(String(error))) result.failed.push(ticker);
    }
  }
  return result;
}

export async function executeFiguresWorkflow(params: FiguresWorkflowParams, step: WorkflowStepLike, env: SecPipelineEnv, fetcher: typeof fetch = fetch) {
  assertTrackedTicker(env, params.ticker);
  const modelVersion = env.SEC_ANALYSIS_MODEL || "deepseek-flash";
  const now = await step.do("figures-time", async () => new Date().toISOString());
  const input = await step.do("figures-input", () => readInput(env, params.ticker));
  if (!input) return { status: "empty" };
  if (input.fingerprint !== params.fingerprint) return { status: "superseded" };
  const plan = await step.do("figures-plan", () => planFigures({
    ticker: params.ticker, companyName: findSecurity(params.ticker)?.name ?? input.explainer.companyName, explainer: input.explainer, metrics: input.metrics, narrative: input.narrative, findings: input.findings,
    fingerprint: params.fingerprint, modelVersion, now,
    // The default output budget, as the findings writer uses: an explicit cap is spent by the model's reasoning before any plan is written.
  }, (stage, system, payload) => callWorkerSecModel(env, fetcher, stage, system, payload, modelVersion, 5 * 60_000, true)));
  const names = { company: companyNames(input.explainer, input.narrative), business: (nodeId: string) => businessNames(input.explainer, input.narrative, nodeId) };
  const verified = readPlannedFigures(plan, params.ticker, names);
  await step.do("figures-publish", async () => {
    const repository = new D1SecRepository(requireDb(env));
    // An empty plan is still recorded under its fingerprint, so the sweep does not re-plan the same input every week.
    await repository.setCache(figuresCacheKey(params.ticker), verified ?? plan, now);
    if (verified) await new AiRunStore(requireDb(env)).saveVersion("figures", params.ticker, verified, now);
  });
  return { status: verified ? "ready" : "empty", company: verified?.company.length ?? 0, businesses: verified?.businesses.length ?? 0 };
}

/** Read-only. Names come from the stored explainer and narrative, exactly as the planner saw them. */
export async function readPlannedFiguresResponse(db: D1Database, rawTicker: string): Promise<PlannedFiguresResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) throw new AnalysisRequestError("INVALID_TICKER", "Invalid company ticker.");
  const repository = new D1SecRepository(db);
  const [stored, explainerRow, narrativeRow] = await Promise.all([repository.getCache<unknown>(figuresCacheKey(ticker)), repository.getCache<BusinessExplainer>(businessExplainerCacheKey(ticker)), repository.getCache<CompanyNarrative>(narrativeCacheKey(ticker))]);
  const explainer = explainerRow ? readBusinessExplainer(explainerRow.payload, ticker) : null;
  const narrative = narrativeRow ? readCompanyNarrative(narrativeRow.payload, ticker) : null;
  const figures = stored && explainer ? readPlannedFigures(stored.payload, ticker, { company: companyNames(explainer, narrative), business: nodeId => businessNames(explainer, narrative, nodeId) }) : null;
  return { schemaVersion: "business-figures-response.v1", status: figures ? "ready" : "preparing", figures };
}
