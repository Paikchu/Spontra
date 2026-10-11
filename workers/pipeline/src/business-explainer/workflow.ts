import type { BusinessExplainerResponse } from "../../../../shared/analysis-contract/business-explainer.ts";
import type { PublicBusinessFlow } from "../../../../shared/analysis-contract/business-flow.ts";
import { readBusinessExplainer } from "../../../../shared/analysis-runtime/business-explainer.ts";
import { sha256 } from "../company-analysis/api.ts";
import { findSecurity } from "../catalog/security-directory.ts";
import { assertTrackedTicker, requireDb } from "../core.ts";
import { readCompletePublicationForTicker } from "../financial-data/publication.ts";
import { callWorkerSecModel, type SecPipelineEnv } from "../operations.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { researchSearch } from "../web-search/research-search.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { AiRunStore } from "../ai-runs/store.ts";
import { nodeHint, runBusinessExplainer, type ExplainerNode } from "./agent.ts";
import { outboxStatement } from "../pipeline/outbox.ts";

/** Changing the prompt or output contract regenerates every company once. */
export const BUSINESS_EXPLAINER_VERSION = "business-explainer.sections.v3";
export const businessExplainerCacheKey = (ticker: string) => `business-explainer:v1:${ticker}`;
export type BusinessExplainerParams = { ticker: string; fingerprint: string };

/** Every business the newest quarter discloses, in any non-geographic, non-customer partition. */
export function explainerNodes(flow: PublicBusinessFlow | null): ExplainerNode[] {
  const quarter = [...flow?.quarters ?? []].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  if (!quarter) return [];
  const nodes = new Map<string, ExplainerNode>();
  const add = (nodeId: string, name: string, parentId: string | null) => {
    if (!nodes.has(nodeId)) nodes.set(nodeId, { nodeId, name, parentId, hint: nodeHint(nodeId, name) });
  };
  for (const segment of quarter.segments) {
    add(segment.id, segment.name, null);
    for (const child of segment.children ?? []) add(child.id, child.name, segment.id);
  }
  for (const breakdown of quarter.revenueBreakdowns ?? []) {
    if (breakdown.kind === "geography" || breakdown.kind === "customer") continue;
    for (const node of breakdown.nodes) add(node.id, node.name, node.parentId);
  }
  return [...nodes.values()].slice(0, 24);
}

export async function explainerFingerprint(ticker: string, nodes: ExplainerNode[]): Promise<string> {
  return sha256(JSON.stringify({ version: BUSINESS_EXPLAINER_VERSION, ticker, nodes: nodes.map(n => [n.nodeId, n.name, n.parentId]).sort() }));
}

async function readInput(env: SecPipelineEnv, ticker: string) {
  const publication = await readCompletePublicationForTicker(requireDb(env), ticker);
  const flow = publication.status === "ready" ? publication.flow : null;
  const nodes = explainerNodes(flow);
  const newest = [...flow?.quarters ?? []].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  const filings = (newest?.sources ?? []).map(s => ({ url: s.url, title: s.title, publishedAt: s.publishedAt ?? null }));
  return { nodes, filings, fingerprint: nodes.length ? await explainerFingerprint(ticker, nodes) : null };
}

/** The business list a run would explain now; null when the company has no complete report yet. */
export async function businessExplainerFingerprint(env: SecPipelineEnv, ticker: string): Promise<string | null> {
  return (await readInput(env, ticker)).fingerprint;
}

export async function executeBusinessExplainerWorkflow(params: BusinessExplainerParams, step: WorkflowStepLike, env: SecPipelineEnv, fetcher: typeof fetch = fetch) {
  assertTrackedTicker(env, params.ticker);
  const modelVersion = env.SEC_REASONING_MODEL || env.SEC_ANALYSIS_MODEL || "deepseek-flash";
  const now = await step.do("explainer-time", async () => new Date().toISOString());
  const input = await step.do("explainer-input", () => readInput(env, params.ticker));
  // The business list changed after scheduling; the next sweep starts a run for the new list.
  if (input.fingerprint !== params.fingerprint) return { status: "superseded" };
  const explainer = await runBusinessExplainer({
    ticker: params.ticker, companyName: findSecurity(params.ticker)?.name ?? params.ticker, nodes: input.nodes,
    filings: input.filings, search: researchSearch(env), modelVersion, fingerprint: params.fingerprint, now,
    model: (stage, system, payload) => callWorkerSecModel(env, fetcher, stage, system, payload, modelVersion, 5 * 60_000),
    stage: (name, callback) => step.do(`explainer-${name}`, callback),
  });
  if (!readBusinessExplainer(explainer, params.ticker)) throw new Error("Business explainer failed its public contract.");
  await step.do("explainer-publish", async () => {
    const db = requireDb(env);
    // The publication and its event commit together.
    await db.batch([
      db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
        .bind(businessExplainerCacheKey(params.ticker), JSON.stringify(explainer), now),
      outboxStatement(db, { type: "explainer.published", ticker: params.ticker }, now),
    ]);
    await new AiRunStore(requireDb(env)).saveVersion("explainer", params.ticker, explainer, now);
  });
  return { status: "ready", businesses: explainer.businesses.length, sources: explainer.sources.length };
}

/** Read-only: never starts research. A stored document that fails validation reads as preparing. */
export async function readBusinessExplainerResponse(db: D1Database, rawTicker: string): Promise<BusinessExplainerResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) throw new AnalysisRequestError("INVALID_TICKER", "Invalid company ticker.");
  const stored = await new D1SecRepository(db).getCache<unknown>(businessExplainerCacheKey(ticker));
  const explainer = stored ? readBusinessExplainer(stored.payload, ticker) : null;
  return { schemaVersion: "business-explainer-response.v1", status: explainer ? "ready" : "preparing", explainer };
}
