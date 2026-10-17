import { modelFor, reasoningFor } from "../ai-config.ts";
import type { BusinessTree, BusinessTreeResponse } from "../../../../shared/analysis-contract/business-tree.ts";
import type { PublicBusinessFlow } from "../../../../shared/analysis-contract/business-flow.ts";
import { issuerNames, readBusinessTree } from "../../../../shared/analysis-runtime/business-tree.ts";
import { sha256 } from "../company-analysis/api.ts";
import { findSecurity } from "../catalog/security-directory.ts";
import { requireDb } from "../core.ts";
import { featureTickersFor } from "../financial-data/company-policy.ts";
import { readCompletePublicationForTicker } from "../financial-data/publication.ts";
import { SecModelOutputError } from "../model-stream.ts";
import { callWorkerSecModel, type SecPipelineEnv } from "../operations.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { researchSearch } from "../web-search/research-search.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { AiRunStore } from "../ai-runs/store.ts";
import { runBusinessTree, type TreeBusiness } from "./agent.ts";
import { treeLibrary } from "../filing-library/tree-source.ts";
import { outboxStatement } from "../pipeline/outbox.ts";

/** Changing the prompt, the harness or the output contract researches every company once more. */
export const BUSINESS_TREE_VERSION = "business-tree.react.v4";
export const businessTreeCacheKey = (ticker: string) => `business-tree:v1:${ticker}`;
export type BusinessTreeParams = { ticker: string; fingerprint: string };

/** Companies whose businesses are broken down: the `tree` feature's list after the admin's switches (company-policy.ts). */
export function treeTickersFor(env: Pick<SecPipelineEnv, "BUSINESS_TREE_TICKERS" | "BUSINESS_TREE_ENABLED" | "FEATURE_RESOLVED" | "SEC_TRACKED_TICKERS" | "SEC_DATA_TICKERS" | "SEC_AI_TICKERS" | "SEC_AI_ENABLED">): string[] {
  return featureTickersFor(env, "tree");
}

/** A region is where a business sells, not what it sells: breaking it into products would repeat the product lines once per region. */
const REGION = /americas|europe|emea|asia|pacific|china|japan|international|domestic|united\s?states|north\s?america|latin\s?america|geograph|region/i;

/**
 * The businesses the map draws for the newest quarter: its top-level segments with the children the
 * statement discloses under them. Regions are left out, and statements drawn as a bank or an insurer
 * are not broken down here.
 */
export function treeBusinesses(flow: PublicBusinessFlow | null): { periodEnd: string; businesses: TreeBusiness[] } | null {
  const quarter = [...flow?.quarters ?? []].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  if (!quarter || quarter.incomeModel === "financial" || quarter.incomeModel === "insurance") return null;
  const businesses = quarter.segments.filter(s => !REGION.test(`${s.id} ${s.name}`))
    .map(s => ({ flowNodeId: s.id, name: s.name, children: (s.children ?? []).filter(c => !REGION.test(`${c.id} ${c.name}`)).map(c => ({ flowNodeId: c.id, name: c.name })) }));
  return businesses.length ? { periodEnd: quarter.periodEnd, businesses: businesses.slice(0, 8) } : null;
}

export async function treeFingerprint(ticker: string, businesses: TreeBusiness[]): Promise<string> {
  return sha256(JSON.stringify({ version: BUSINESS_TREE_VERSION, ticker, businesses: businesses.map(b => [b.flowNodeId, b.name, b.children.map(c => [c.flowNodeId, c.name])]).sort() }));
}

async function readInput(env: SecPipelineEnv, ticker: string) {
  const publication = await readCompletePublicationForTicker(requireDb(env), ticker);
  const flow = publication.status === "ready" ? publication.flow : null;
  const found = treeBusinesses(flow);
  const newest = [...flow?.quarters ?? []].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  const filings = (newest?.sources ?? []).map(s => ({ url: s.url, title: s.title, publishedAt: s.publishedAt ?? null }));
  return { periodEnd: found?.periodEnd ?? null, businesses: found?.businesses ?? [], filings, fingerprint: found ? await treeFingerprint(ticker, found.businesses) : null };
}

/** The business list a run would break down now; null when the company has nothing to break down yet. */
export async function businessTreeFingerprint(env: SecPipelineEnv, ticker: string): Promise<string | null> {
  return (await readInput(env, ticker)).fingerprint;
}

export async function executeBusinessTreeWorkflow(params: BusinessTreeParams, step: WorkflowStepLike, env: SecPipelineEnv, fetcher: typeof fetch = fetch, runId?: string) {
  // Switched off in the admin after the run was scheduled: nothing to write, and nothing that failed.
  if (!treeTickersFor(env).includes(params.ticker) || env.BUSINESS_TREE_ENABLED === "false") return { status: "superseded" };
  const modelVersion = modelFor(env, "tree");
  const now = await step.do("tree-time", async () => new Date().toISOString());
  const input = await step.do("tree-input", () => readInput(env, params.ticker));
  // The business list changed after scheduling; the next sweep starts a run for the new list.
  if (input.fingerprint !== params.fingerprint || !input.periodEnd) return { status: "superseded" };
  const tree = await runBusinessTree({
    ticker: params.ticker, companyName: issuerNames(findSecurity(params.ticker)?.name ?? params.ticker)[0]!, periodEnd: input.periodEnd, businesses: input.businesses,
    filings: input.filings, search: researchSearch(env), modelVersion, fingerprint: params.fingerprint, now,
    // SEC filings are read from the filing library; the web search is left for vendor pages.
    filingLibrary: treeLibrary(requireDb(env), params.ticker, input.filings),
    // A reply that is not JSON is the model's turn gone wrong, answered in the next observation; transport errors still retry the step.
    model: async (stage, system, payload) => {
      try { return await callWorkerSecModel(env, fetcher, stage, system, payload, modelVersion, 5 * 60_000, true, { reasoning: reasoningFor(env, "tree"), ticker: params.ticker, runId }); }
      catch (error) { if (error instanceof SecModelOutputError) return { action: "invalid" }; throw error; }
    },
    stage: (name, callback) => step.do(`tree-${name}`, callback),
  });
  if (!readBusinessTree(tree, params.ticker, { research: true })) throw new Error("Business tree failed its public contract.");
  await step.do("tree-publish", async () => {
    const db = requireDb(env);
    // The publication and its event commit together.
    await db.batch([
      db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
        .bind(businessTreeCacheKey(params.ticker), JSON.stringify(tree), now),
      outboxStatement(db, { type: "tree.published", ticker: params.ticker }, now),
    ]);
    await new AiRunStore(requireDb(env)).saveVersion("tree", params.ticker, tree, now);
  });
  const nodes = (list: BusinessTree["branches"][number]["children"]): number => list.reduce((sum, n) => sum + 1 + nodes(n.children), 0);
  return { status: "ready", businesses: tree.branches.length, nodes: tree.branches.reduce((sum, b) => sum + nodes(b.children), 0), sources: tree.sources.length };
}


/**
 * Read-only: never starts research. A stored tree that fails validation reads as preparing. The operator's trace is left
 * out. `hidden` (the admin's switch is off, decided by the read route) answers hidden; the tree stays stored.
 */
export async function readBusinessTreeResponse(db: D1Database, rawTicker: string, options: { research?: boolean; hidden?: boolean } = {}): Promise<BusinessTreeResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) throw new AnalysisRequestError("INVALID_TICKER", "Invalid company ticker.");
  if (options.hidden) return { schemaVersion: "business-tree-response.v1", status: "hidden", tree: null };
  const stored = await new D1SecRepository(db).getCache<unknown>(businessTreeCacheKey(ticker));
  const tree = stored ? readBusinessTree(stored.payload, ticker, options) : null;
  return { schemaVersion: "business-tree-response.v1", status: tree ? "ready" : "preparing", tree };
}
