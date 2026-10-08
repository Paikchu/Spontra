import type { ExplainerSource } from "../../../../shared/analysis-contract/business-explainer.ts";
import type { FindingsPublication } from "../../../../shared/analysis-contract/findings.ts";
import { readFindingFundamentals, type FindingData } from "../../../../shared/analysis-runtime/findings.ts";
import { sha256 } from "../company-analysis/api.ts";
import { D1CompanyAnalysisRepository } from "../company-analysis/repository.ts";
import { findSecurity } from "../catalog/security-directory.ts";
import { assertTrackedTicker, requireDb, trackedTickersFor } from "../core.ts";
import { readArchivedCapital } from "../financial-data/capital-history.ts";
import { readCompletePublicationForTicker } from "../financial-data/publication.ts";
import type { ReportArchive } from "../financial-data/report-history.ts";
import { parseFundamentalApiQuery } from "../fundamentals/fundamentals-api.ts";
import { getSecFundamentals } from "../fundamentals/sec-fundamentals.ts";
import { readGuidanceResponse } from "../guidance/workflow.ts";
import { callWorkerSecModel, type SecPipelineEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { buildLedger, type Ledger } from "./ledger.ts";
import { findingsCacheKey } from "./read.ts";
import { writeFindings, type FindingsModel } from "./writer.ts";

/** Changing the prompt or the ledger regenerates every company once. */
export const FINDINGS_VERSION = "findings.writer.v3";
export type FindingsWorkflowParams = { ticker: string; fingerprint: string };
export type FindingsDeps = { model?: FindingsModel; fetcher?: typeof fetch };

/** The model reasons at length before it writes, and the provider counts that against the output limit; the default limit leaves room. */
const MODEL_BUDGET_MS = 8 * 60_000, CONTEXT_CHARS = 12_000;

type Input = { data: FindingData; ledger: Ledger; context: string | null; fingerprint: string } | null;

/** Everything the writer and the verifier see, from stored projections only: no SEC fetch, no model call. */
async function readInput(env: SecPipelineEnv, ticker: string): Promise<Input> {
  const db = requireDb(env);
  const publication = await readCompletePublicationForTicker(db, ticker);
  const flow = publication.status === "ready" ? publication.flow : null;
  const newest = [...flow?.quarters ?? []].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  if (!flow || !newest) return null;
  const quarters = [...new Map([...(publication.reports?.quarters ?? []), ...flow.quarters].map(q => [q.periodEnd, q])).values()];
  const [capital, fundamentals, guidance, analysis] = await Promise.all([
    env.SEC_FILINGS ? readArchivedCapital(db, env.SEC_FILINGS as unknown as ReportArchive, flow).catch(() => null) : Promise.resolve(null),
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
  const fingerprint = await sha256(JSON.stringify({ version: FINDINGS_VERSION, ticker, periodEnd: newest.periodEnd, guidance: guidance?.updatedAt ?? null, analysis: analysis?.generatedAt ?? null, rpo: capital?.quarters.find(q => q.periodEnd === newest.periodEnd)?.rpo?.total ?? null }));
  return { data, ledger, context, fingerprint };
}

/**
 * Starts at most one run per tick, only for AI-enabled companies whose newest report (or the guidance
 * and narrative around it) has no model-written findings yet. The instance id carries the week, so a
 * failed run retries weekly rather than every tick, and a running one is never duplicated.
 */
export async function runFindingsSweep(env: SecPipelineEnv, now = Date.now()): Promise<{ checked: number; started: string[]; failed: string[] }> {
  const result = { checked: 0, started: [] as string[], failed: [] as string[] };
  if (!env.FINDINGS_WORKFLOW || !env.DB || env.FINDINGS_ENABLED !== "true") return result;
  const repository = new D1SecRepository(env.DB);
  for (const ticker of trackedTickersFor(env)) {
    result.checked++;
    try {
      const input = await readInput(env, ticker);
      if (!input) continue;
      const stored = await repository.getCache<FindingsPublication>(findingsCacheKey(ticker));
      if (stored?.payload?.fingerprint === input.fingerprint) continue;
      const week = Math.floor(now / (7 * 24 * 60 * 60_000));
      await env.FINDINGS_WORKFLOW.create({ id: `findings-${ticker.replace(/[^A-Za-z0-9]/g, "-")}-${input.fingerprint.slice(0, 16)}-${week}`, params: { ticker, fingerprint: input.fingerprint } });
      result.started.push(ticker);
      return result;
    } catch (error) {
      if (!/already exists|duplicate/i.test(String(error))) result.failed.push(ticker);
    }
  }
  return result;
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
  await step.do("findings-publish", () => new D1SecRepository(requireDb(env)).setCache(findingsCacheKey(params.ticker), publication, now));
  return { status: "ready" as const, findings: publication.findings.length, withheld: outcome.withheld };
}
