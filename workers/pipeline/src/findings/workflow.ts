import type { ExplainerSource } from "../../../../shared/analysis-contract/business-explainer.ts";
import { readFindingFundamentals, type FindingData } from "../../../../shared/analysis-runtime/findings.ts";
import { sha256 } from "../company-analysis/api.ts";
import { D1CompanyAnalysisRepository } from "../company-analysis/repository.ts";
import { findSecurity } from "../catalog/security-directory.ts";
import { assertTrackedTicker, requireDb } from "../core.ts";
import { readMapDerived } from "../financial-data/derived.ts";
import { readCompletePublicationForTicker } from "../financial-data/publication.ts";
import { parseFundamentalApiQuery } from "../fundamentals/fundamentals-api.ts";
import { getSecFundamentals } from "../fundamentals/sec-fundamentals.ts";
import { readGuidanceResponse } from "../guidance/workflow.ts";
import { callWorkerSecModel, type SecPipelineEnv } from "../operations.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { AiRunStore } from "../ai-runs/store.ts";
import { buildLedger, type Ledger } from "./ledger.ts";
import { findingsCacheKey } from "./read.ts";
import { writeFindings, type FindingsModel } from "./writer.ts";
import { outboxStatement } from "../pipeline/outbox.ts";

/** Changing the prompt or the ledger regenerates every company once. */
export const FINDINGS_VERSION = "findings.writer.v5";
export type FindingsWorkflowParams = { ticker: string; fingerprint: string };
export type FindingsDeps = { model?: FindingsModel; fetcher?: typeof fetch };

/** The model reasons at length before it writes, and the provider counts that against the output limit; the default limit leaves room. */
const MODEL_BUDGET_MS = 8 * 60_000, CONTEXT_CHARS = 12_000;

type Input = { data: FindingData; ledger: Ledger; context: string | null; fingerprint: string } | null;

/**
 * Everything the writer sees, from stored projections only: no SEC fetch, no model call. The older quarters and the
 * capital structure come from the map's prepared snapshot, the same data the map verifies findings against; until
 * the snapshot matches the current publication there is nothing to write from.
 */
async function readInput(env: SecPipelineEnv, ticker: string): Promise<Input> {
  const db = requireDb(env);
  const publication = await readCompletePublicationForTicker(db, ticker);
  const flow = publication.status === "ready" ? publication.flow : null;
  const newest = [...flow?.quarters ?? []].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  if (!flow || !newest) return null;
  const snapshot = await readMapDerived(db, flow);
  if (!snapshot) return null;
  const quarters = [...new Map([...(snapshot.reports?.quarters ?? []), ...flow.quarters].map(q => [q.periodEnd, q])).values()];
  const capital = snapshot.capital;
  const [fundamentals, guidance, analysis] = await Promise.all([
    getSecFundamentals(db, parseFundamentalApiQuery(ticker, new URLSearchParams({ periodCount: "12" }))).then(r => readFindingFundamentals(r, ticker)).catch(() => null),
    readGuidanceResponse(db, ticker).then(r => r.guidance).catch(() => null),
    new D1CompanyAnalysisRepository(db).getLatestPublication(ticker).catch(() => null),
  ]);
  const data: FindingData = { quarters, history: publication.history ?? null, capital, fundamentals, guidance };
  const sources = new Map<string, ExplainerSource>();
  for (const q of quarters) for (const s of q.sources) if (/^https:\/\/www\.sec\.gov\//.test(s.url) && !sources.has(s.id)) sources.set(s.id, { id: s.id, title: s.title, url: s.url, kind: "sec", publishedAt: s.publishedAt ?? null });
  for (const s of guidance?.sources ?? []) if (!sources.has(s.id)) sources.set(s.id, { id: s.id, title: s.title, url: s.url, kind: s.sourceKind === "sec" ? "sec" : "web", publishedAt: s.publishedAt });
  const ledger = buildLedger(data, newest.periodEnd, [...sources.values()].slice(0, 40));
  const overview = analysis?.overview;
  const context = overview ? [overview.headline, overview.introduction, ...overview.highlights.map(h => `${h.title}：${h.body}`), ...(overview.deepDive?.sections ?? []).flatMap(s => [s.title, ...s.paragraphs.map(p => p.text)])].join("\n").slice(0, CONTEXT_CHARS) : null;
  // The periods the snapshot covers and the newest backlog, not when the snapshot was rebuilt: a daily re-collection
  // that changes nothing must not rewrite the findings.
  const fingerprint = await sha256(JSON.stringify({ version: FINDINGS_VERSION, ticker, periodEnd: newest.periodEnd, guidance: guidance?.updatedAt ?? null, analysis: analysis?.generatedAt ?? null,
    quarters: quarters.map(q => q.periodEnd).sort(), capital: capital?.quarters.map(q => q.periodEnd).sort() ?? [], rpo: capital?.quarters.find(q => q.periodEnd === newest.periodEnd)?.rpo?.total ?? null }));
  return { data, ledger, context, fingerprint };
}

/** The state a run would write for now; null when the company has no complete report yet. */
export async function findingsFingerprint(env: SecPipelineEnv, ticker: string): Promise<string | null> {
  return (await readInput(env, ticker))?.fingerprint ?? null;
}

export async function executeFindingsWorkflow(params: FindingsWorkflowParams, step: WorkflowStepLike, env: SecPipelineEnv, deps: FindingsDeps = {}) {
  assertTrackedTicker(env, params.ticker);
  const fetcher = deps.fetcher ?? fetch;
  const modelVersion = env.SEC_REASONING_MODEL || env.SEC_ANALYSIS_MODEL || "deepseek-flash";
  const now = await step.do("findings-time", async () => new Date().toISOString());
  const input = await step.do("findings-input", () => readInput(env, params.ticker));
  // The report, guidance or narrative moved on after scheduling; the next sweep starts a run for the new state.
  if (!input || input.fingerprint !== params.fingerprint) return { status: "superseded" as const };
  const model: FindingsModel = deps.model ?? ((stage, system, payload) => callWorkerSecModel(env, fetcher, stage, system, payload, modelVersion, MODEL_BUDGET_MS, true));
  const outcome = await writeFindings({
    ticker: params.ticker, companyName: findSecurity(params.ticker)?.name ?? params.ticker, ledger: input.ledger, context: input.context, data: input.data,
    model, modelVersion, fingerprint: params.fingerprint, now, stage: (name, callback) => step.do(`findings-${name}`, callback),
  });
  // Nothing verifiable is not a publication: whatever is stored (an authored set, an older run) keeps serving.
  if (!outcome.publication) return { status: "empty" as const, withheld: outcome.withheld };
  const publication = outcome.publication;
  await step.do("findings-publish", async () => {
    const db = requireDb(env);
    // The publication and its event commit together.
    await db.batch([
      db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
        .bind(findingsCacheKey(params.ticker), JSON.stringify(publication), now),
      outboxStatement(db, { type: "findings.published", ticker: params.ticker }, now),
    ]);
    await new AiRunStore(requireDb(env)).saveVersion("findings", params.ticker, publication, now);
  });
  return { status: "ready" as const, findings: publication.findings.length, withheld: outcome.withheld };
}
