import type { BusinessExplainer } from "../../../../shared/analysis-contract/business-explainer.ts";
import type { CompanyNarrative } from "../../../../shared/analysis-contract/business-narrative.ts";
import type { FindingsPublication } from "../../../../shared/analysis-contract/findings.ts";
import type { GuidancePublication } from "../../../../shared/analysis-contract/guidance.ts";
import type { OperatingMetricsPublication } from "../../../../shared/analysis-contract/operating-metrics.ts";
import { readBusinessExplainer } from "../../../../shared/analysis-runtime/business-explainer.ts";
import { readCompanyNarrative } from "../../../../shared/analysis-runtime/business-narrative.ts";
import { readFindingsPublication } from "../../../../shared/analysis-runtime/findings.ts";
import { readGuidancePublication } from "../../../../shared/analysis-runtime/guidance.ts";
import { readOperatingMetrics } from "../../../../shared/analysis-runtime/operating-metrics.ts";
import { AiRunStore, quietly } from "../ai-runs/store.ts";
import { businessExplainerCacheKey, explainerNodes } from "../business-explainer/workflow.ts";
import { findSecurity } from "../catalog/security-directory.ts";
import { sha256 } from "../company-analysis/api.ts";
import { assertTrackedTicker, requireDb, trackedTickersFor } from "../core.ts";
import { readCompletePublicationForTicker } from "../financial-data/publication.ts";
import { findingsCacheKey } from "../findings/read.ts";
import { guidanceCacheKey } from "../guidance/workflow.ts";
import { operatingMetricsCacheKey } from "../operating-metrics/read.ts";
import { callWorkerSecModel, type SecPipelineEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { SecFilingFeed } from "../sec/sec.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { collectNarrativeMaterials } from "./materials.ts";
import { narrativeCacheKey } from "./read.ts";
import { NARRATIVE_WRITER_VERSION, writeNarrative } from "./writer.ts";

export type NarrativeWorkflowParams = { ticker: string; fingerprint: string };

/**
 * What a narrative is written from, all stored: the explainer (which businesses exist and what they
 * sell), the flow's nodes, the operating metrics, the guidance, the findings, and the SEC feed whose
 * newest filings become the materials. The fingerprint moves when any of it does.
 */
async function readInput(env: SecPipelineEnv, ticker: string) {
  const db = requireDb(env);
  const repository = new D1SecRepository(db);
  const [explainerRow, metricsRow, guidanceRow, findingsRow, feedRow, publication] = await Promise.all([
    repository.getCache<unknown>(businessExplainerCacheKey(ticker)), repository.getCache<unknown>(operatingMetricsCacheKey(ticker)), repository.getCache<unknown>(guidanceCacheKey(ticker)),
    repository.getCache<unknown>(findingsCacheKey(ticker)), repository.getCache<SecFilingFeed>(`sec:filings:${ticker}`), readCompletePublicationForTicker(db, ticker),
  ]);
  const explainer = explainerRow ? readBusinessExplainer(explainerRow.payload, ticker) : null;
  const feed = feedRow?.payload ?? null;
  const flow = publication.status === "ready" ? publication.flow : null;
  const newest = [...flow?.quarters ?? []].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  if (!explainer || !feed || !newest) return null;
  const nodes = explainerNodes(flow).map(n => ({ nodeId: n.nodeId, name: n.name, parentId: n.parentId }));
  const metrics = metricsRow ? readOperatingMetrics(metricsRow.payload, ticker) : null;
  const guidance = guidanceRow ? readGuidancePublication(guidanceRow.payload, ticker) : null;
  const findings = findingsRow ? readFindingsPublication(findingsRow.payload, ticker) : null;
  const filings = [...feed.filings].sort((a, b) => b.filingDate.localeCompare(a.filingDate)).slice(0, 16).map(f => f.accessionNumber);
  // Content digests, not timestamps: the metrics set republishes every time a filing is read, and that must not rewrite a narrative whose inputs did not change.
  const metricsDigest = metrics ? metrics.metrics.map(m => `${m.key}:${m.observations.map(o => `${o.asOf}=${o.value}`).join(",")}`).sort().join(";") : null;
  const fingerprint = await sha256(JSON.stringify({ version: NARRATIVE_WRITER_VERSION, ticker, explainer: explainer.fingerprint, periodEnd: newest.periodEnd, filings, metrics: metricsDigest, guidance: guidance?.updatedAt ?? null, findings: findings?.fingerprint ?? findings?.generatedAt ?? null }));
  return { explainer, feed, nodes, periodEnd: newest.periodEnd, metrics, guidance, findings, fingerprint };
}

/** The state a run would write for now; null when the company has no explainer or no complete report yet. */
export async function narrativeFingerprint(env: SecPipelineEnv, ticker: string): Promise<string | null> {
  return (await readInput(env, ticker))?.fingerprint ?? null;
}

/** Starts at most one run per tick, for a company whose stored narrative was written from an older state; a failed run retries weekly. */
export async function runNarrativeSweep(env: SecPipelineEnv, now = Date.now()): Promise<{ checked: number; started: string[]; failed: string[] }> {
  const result = { checked: 0, started: [] as string[], failed: [] as string[] };
  if (!env.NARRATIVE_WORKFLOW || !env.DB || env.NARRATIVE_ENABLED !== "true") return result;
  const repository = new D1SecRepository(env.DB);
  for (const ticker of trackedTickersFor(env)) {
    result.checked++;
    try {
      const input = await readInput(env, ticker);
      if (!input) continue;
      const stored = await repository.getCache<CompanyNarrative>(narrativeCacheKey(ticker));
      if (stored?.payload?.fingerprint === input.fingerprint) continue;
      const week = Math.floor(now / (7 * 24 * 60 * 60_000));
      const id = `narrative-${ticker.replace(/[^A-Za-z0-9]/g, "-")}-${input.fingerprint.slice(0, 16)}-${week}`;
      await env.NARRATIVE_WORKFLOW.create({ id, params: { ticker, fingerprint: input.fingerprint } });
      await quietly(() => new AiRunStore(env.DB!).start({ kind: "narrative", ticker, runId: id, trigger: "schedule" }, new Date(now).toISOString()));
      result.started.push(ticker);
      return result;
    } catch (error) {
      if (!/already exists|duplicate/i.test(String(error))) result.failed.push(ticker);
    }
  }
  return result;
}

export async function executeNarrativeWorkflow(params: NarrativeWorkflowParams, step: WorkflowStepLike, env: SecPipelineEnv, fetcher: typeof fetch = fetch) {
  assertTrackedTicker(env, params.ticker);
  const modelVersion = env.SEC_REASONING_MODEL || env.SEC_ANALYSIS_MODEL || "deepseek-flash";
  const companyName = findSecurity(params.ticker)?.name ?? params.ticker;
  const now = await step.do("narrative-time", async () => new Date().toISOString());
  const input = await step.do("narrative-input", () => readInput(env, params.ticker));
  if (!input) return { status: "empty" };
  if (input.fingerprint !== params.fingerprint) return { status: "superseded" };
  // Materials are fetched once and stored with the step, so a retried write re-reads the same text.
  const materials = await step.do("narrative-materials", () => collectNarrativeMaterials(input.feed, companyName, fetcher, env.SEC_USER_AGENT));
  if (!materials.length) return { status: "empty", reason: "no readable material" };
  const written = await writeNarrative({
    ticker: params.ticker, companyName, periodEnd: input.periodEnd, explainer: input.explainer as BusinessExplainer, nodes: input.nodes, materials,
    metrics: input.metrics as OperatingMetricsPublication | null, guidance: input.guidance as GuidancePublication | null, findings: input.findings as FindingsPublication | null,
    modelVersion, fingerprint: params.fingerprint, now,
  }, (stage, system, payload) => callWorkerSecModel(env, fetcher, stage, system, payload, modelVersion, 5 * 60_000, true), (name, run) => step.do(`narrative-${name}`, run));
  const narrative = written.narrative;
  if (!narrative || !readCompanyNarrative(narrative, params.ticker)) return { status: "empty", reason: "nothing verifiable", issues: written.issues };
  await step.do("narrative-publish", async () => {
    await new D1SecRepository(requireDb(env)).setCache(narrativeCacheKey(params.ticker), narrative, now);
    await new AiRunStore(requireDb(env)).saveVersion("narrative", params.ticker, narrative, now);
  });
  return { status: "ready", businesses: narrative.businesses.length, sources: narrative.sources.length, materials: materials.length, issues: written.issues };
}
