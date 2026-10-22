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
import type Anthropic from "@anthropic-ai/sdk";
import { callWorkerSecModel, callWorkerToolModel, type AnalysisEnv } from "../operations.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { researchSearch } from "../web-search/research-search.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { AiRunStore } from "../ai-runs/store.ts";
import { runBusinessTree, type TreeBusiness } from "./agent.ts";
import { treeLibrary } from "../filing-library/tree-source.ts";
import { outboxStatement } from "../pipeline/outbox.ts";

/** Changing the prompt, the harness or the output contract researches every company once more. */
/**
 * v14: after the review, a describe stage writes the descriptions that are missing or were struck from the read passages
 * naming each node, and a second review judges them. v13: names match word for word with punctuation ignored (`("SASE") platform`), and a name loses a leading "Our".
 * v12: a product's passage may name its category line by the line's own words, a name refused twice is told to be left
 * out, up to eight calls run per turn, and lines with fewer than two products are asked once for more. v11: a list sharing its last word names each member ("online and physical stores"), the company's own filing names the
 * company, products carry proper names, rejections say which check failed, and lines that charge are still asked for
 * products. v10: the loop acts through Claude tools, its exchange only growing. v9 asked for a JSON decision in text, which Claude
 * wrapped in prose or answered with a tool call (invalid_json, ended with tool_use); v7 and v8 asked for a written
 * "thought", which it declined as extracting its reasoning (refusal, reasoning_extraction).
 */
export const BUSINESS_TREE_VERSION = "business-tree.react.v14";
export const businessTreeCacheKey = (ticker: string) => `business-tree:v1:${ticker}`;
export type BusinessTreeParams = { ticker: string; fingerprint: string };

/** Companies whose businesses are broken down: the `tree` feature's list after the admin's switches (company-policy.ts). */
export function treeTickersFor(env: Pick<AnalysisEnv, "BUSINESS_TREE_TICKERS" | "BUSINESS_TREE_ENABLED" | "FEATURE_RESOLVED" | "SEC_TRACKED_TICKERS" | "SEC_DATA_TICKERS" | "SEC_AI_TICKERS" | "SEC_AI_ENABLED">): string[] {
  return featureTickersFor(env, "tree");
}

/** A region is where a business sells, not what it sells: breaking it into products would repeat the product lines once per region. */
const REGION = /americas|europe|emea|asia|pacific|china|japan|international|domestic|united\s?states|north\s?america|latin\s?america|geograph|region/i;

/**
 * The businesses the map draws for the newest quarter: its top-level segments with the children the statement discloses
 * under them. Regions are left out only when every segment at that level is one (a company organised purely by geography
 * sells the same lines everywhere); a company mixing regional and product segments (AMZN: North America, International,
 * AWS) has each broken down. Statements drawn as a bank or an insurer are not broken down here.
 */
export function treeBusinesses(flow: PublicBusinessFlow | null): { periodEnd: string; businesses: TreeBusiness[] } | null {
  const quarter = [...flow?.quarters ?? []].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  if (!quarter || quarter.incomeModel === "financial" || quarter.incomeModel === "insurance") return null;
  const notAllRegions = <T extends { id: string; name: string }>(list: T[]) => list.every(s => REGION.test(`${s.id} ${s.name}`)) ? [] : list;
  const businesses = notAllRegions(quarter.segments)
    .map(s => ({ flowNodeId: s.id, name: s.name, children: notAllRegions(s.children ?? []).map(c => ({ flowNodeId: c.id, name: c.name })) }));
  return businesses.length ? { periodEnd: quarter.periodEnd, businesses: businesses.slice(0, 8) } : null;
}

export async function treeFingerprint(ticker: string, businesses: TreeBusiness[]): Promise<string> {
  return sha256(JSON.stringify({ version: BUSINESS_TREE_VERSION, ticker, businesses: businesses.map(b => [b.flowNodeId, b.name, b.children.map(c => [c.flowNodeId, c.name])]).sort() }));
}

async function readInput(env: AnalysisEnv, ticker: string) {
  const publication = await readCompletePublicationForTicker(requireDb(env), ticker);
  const flow = publication.status === "ready" ? publication.flow : null;
  const found = treeBusinesses(flow);
  const newest = [...flow?.quarters ?? []].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  const filings = (newest?.sources ?? []).map(s => ({ url: s.url, title: s.title, publishedAt: s.publishedAt ?? null }));
  return { periodEnd: found?.periodEnd ?? null, businesses: found?.businesses ?? [], filings, fingerprint: found ? await treeFingerprint(ticker, found.businesses) : null };
}

/** The business list a run would break down now; null when the company has nothing to break down yet. */
export async function businessTreeFingerprint(env: AnalysisEnv, ticker: string): Promise<string | null> {
  return (await readInput(env, ticker)).fingerprint;
}

export async function executeBusinessTreeWorkflow(params: BusinessTreeParams, step: WorkflowStepLike, env: AnalysisEnv, fetcher: typeof fetch = fetch, runId?: string) {
  // Switched off in the admin after the run was scheduled: nothing to write, and nothing that failed.
  if (!treeTickersFor(env).includes(params.ticker) || env.BUSINESS_TREE_ENABLED === "false") return { status: "superseded" };
  const modelVersion = modelFor(env, "tree");
  const tuning = { reasoning: reasoningFor(env, "tree"), ticker: params.ticker, runId };
  const now = await step.do("tree-time", async () => new Date().toISOString());
  const input = await step.do("tree-input", () => readInput(env, params.ticker));
  // The business list changed after scheduling; the next sweep starts a run for the new list.
  if (input.fingerprint !== params.fingerprint || !input.periodEnd) return { status: "superseded" };
  const tree = await runBusinessTree({
    ticker: params.ticker, companyName: issuerNames(findSecurity(params.ticker)?.name ?? params.ticker)[0]!, periodEnd: input.periodEnd, businesses: input.businesses,
    filings: input.filings, search: researchSearch(env), modelVersion, fingerprint: params.fingerprint, now,
    // SEC filings are read from the filing library; the web search is left for vendor pages.
    filingLibrary: treeLibrary(requireDb(env), params.ticker, input.filings),
    // A broken or stalled reply is the turn gone wrong, which the loop answers; HTTP failures and timeouts still retry the step.
    model: {
      act: async (stage, system, tools, messages) => {
        try { return await callWorkerToolModel(env, fetcher, stage, { system, tools: tools as Anthropic.Beta.BetaTool[], messages: messages as Anthropic.Beta.BetaMessageParam[] }, modelVersion, 5 * 60_000, tuning); }
        catch (error) { if (error instanceof SecModelOutputError) return { error: `${error.code}: ${error.message}`.slice(0, 300) }; throw error; }
      },
      judge: async (stage, system, payload) => {
        try { return await callWorkerSecModel(env, fetcher, stage, system, payload, modelVersion, 5 * 60_000, true, tuning); }
        catch (error) { if (error instanceof SecModelOutputError) return {}; throw error; }
      },
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
