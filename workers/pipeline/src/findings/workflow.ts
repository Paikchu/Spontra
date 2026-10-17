import { modelFor, reasoningFor } from "../ai-config.ts";
import type { ExplainerSource } from "../../../../shared/analysis-contract/business-explainer.ts";
import { issuerNames } from "../../../../shared/analysis-runtime/business-tree.ts";
import { readFindingFundamentals, readFindingsPublication, type FindingData } from "../../../../shared/analysis-runtime/findings.ts";
import type { FindingRecordEntry, FindingsPublication } from "../../../../shared/analysis-contract/findings.ts";
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
import { buildHighlightTable, buildLedger, type Ledger } from "./ledger.ts";
import { mergeHighlights, writeHighlights } from "./highlights.ts";
import { authoredFindings, findingsCacheKey } from "./read.ts";
import { writeFindings, type FindingsModel } from "./writer.ts";
import { writeLensDocuments, type LensTrace } from "../lens/agent.ts";
import { SecModelOutputError } from "../model-stream.ts";
import { outboxStatement } from "../pipeline/outbox.ts";
import { D1SecRepository } from "../sec/d1.ts";

/** Changing the prompt or the ledger regenerates every company once. */
export const FINDINGS_VERSION = "findings.writer.v9";
/** Changing the lens agent's prompt, grammar or harness redraws every company's findings once (through the findings fingerprint). */
export const LENS_VERSION = "lens.agent.v1";
export type FindingsWorkflowParams = { ticker: string; fingerprint: string };
export type FindingsDeps = { model?: FindingsModel; fetcher?: typeof fetch };

/** The model reasons at length before it writes, and the provider counts that against the output limit; the default limit leaves room. */
const MODEL_BUDGET_MS = 8 * 60_000, CONTEXT_CHARS = 12_000;

export type Input = { data: FindingData; ledger: Ledger; context: string | null; fingerprint: string } | null;

/**
 * Everything the writer sees, from stored projections only: no SEC fetch, no model call. The older quarters and the
 * capital structure come from the map's prepared snapshot, the same data the map verifies findings against; until
 * the snapshot matches the current publication there is nothing to write from.
 */
export async function findingsInput(env: SecPipelineEnv, ticker: string): Promise<Input> {
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
  const context = overview ? [overview.headline, overview.introduction, ...overview.highlights.map(h => `${h.title}: ${h.body}`), ...(overview.deepDive?.sections ?? []).flatMap(s => [s.title, ...s.paragraphs.map(p => p.text)])].join("\n").slice(0, CONTEXT_CHARS) : null;
  // The periods the snapshot covers and the newest backlog, not when the snapshot was rebuilt: a daily re-collection
  // that changes nothing must not rewrite the findings.
  const fingerprint = await sha256(JSON.stringify({ version: FINDINGS_VERSION, lens: LENS_VERSION, ticker, periodEnd: newest.periodEnd, guidance: guidance?.updatedAt ?? null, analysis: analysis?.generatedAt ?? null,
    quarters: quarters.map(q => q.periodEnd).sort(), capital: capital?.quarters.map(q => q.periodEnd).sort() ?? [], rpo: capital?.quarters.find(q => q.periodEnd === newest.periodEnd)?.rpo?.total ?? null }));
  return { data, ledger, context, fingerprint };
}

/** The state a run would write for now; null when the company has no complete report yet. */
export async function findingsFingerprint(env: SecPipelineEnv, ticker: string): Promise<string | null> {
  return (await findingsInput(env, ticker))?.fingerprint ?? null;
}

/**
 * The watches of every finding published before this one for the company (stored versions plus what served until now),
 * each stamped with its report and publication time; at most the newest 24, and never a watch of this publication.
 */
export async function priorWatches(store: AiRunStore, ticker: string, previous: FindingsPublication | null, current: FindingsPublication): Promise<FindingRecordEntry[]> {
  const entries = new Map<string, FindingRecordEntry>();
  const add = (p: FindingsPublication | null) => { for (const f of p?.findings ?? []) if (f.watch && p && p.generatedAt !== current.generatedAt) entries.set(`${p.periodEnd}:${f.id}`, { findingId: f.id, title: f.title, kind: f.kind, periodEnd: p.periodEnd, publishedAt: p.generatedAt, watch: f.watch }); };
  for (const e of previous?.record ?? []) entries.set(`${e.periodEnd}:${e.findingId}`, e);
  add(previous);
  const versions = await store.versions("findings", ticker).catch(() => []);
  for (const v of versions.slice(0, 12)) { const stored = await store.version("findings", ticker, v.id).catch(() => null); add(stored ? readFindingsPublication(stored.publication, ticker) : null); }
  return [...entries.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)).slice(-24);
}

export async function executeFindingsWorkflow(params: FindingsWorkflowParams, step: WorkflowStepLike, env: SecPipelineEnv, deps: FindingsDeps = {}) {
  assertTrackedTicker(env, params.ticker);
  const fetcher = deps.fetcher ?? fetch;
  const modelVersion = modelFor(env, "findings");
  const now = await step.do("findings-time", async () => new Date().toISOString());
  const input = await step.do("findings-input", () => findingsInput(env, params.ticker));
  // The report, guidance or narrative moved on after scheduling; the next sweep starts a run for the new state.
  if (!input || input.fingerprint !== params.fingerprint) return { status: "superseded" as const };
  const model: FindingsModel = deps.model ?? ((stage, system, payload) => callWorkerSecModel(env, fetcher, stage, system, payload, modelVersion, MODEL_BUDGET_MS, true, { reasoning: reasoningFor(env, "findings"), ticker: params.ticker }));
  const companyName = issuerNames(findSecurity(params.ticker)?.name ?? params.ticker)[0]!;
  const stage = <T>(name: string, callback: () => Promise<T>) => step.do(`findings-${name}`, callback);
  const draft = await writeFindings({
    ticker: params.ticker, companyName, ledger: input.ledger, context: input.context, data: input.data,
    model, modelVersion, fingerprint: params.fingerprint, now, stage,
  });
  // Each verified finding's lens document, composed by the agent at low reasoning; a reply that is not JSON is its turn gone wrong, not a failed step.
  const lensModel: FindingsModel = deps.model ?? (async (stage, system, payload) => {
    try { return await callWorkerSecModel(env, fetcher, stage, system, payload, modelFor(env, "lens"), 3 * 60_000, true, { reasoning: reasoningFor(env, "lens"), ticker: params.ticker }); }
    catch (error) { if (error instanceof SecModelOutputError) return { action: "invalid" }; throw error; }
  });
  const lensed = draft.publication ? await writeLensDocuments({ publication: draft.publication, ledger: input.ledger, data: input.data, model: lensModel, version: LENS_VERSION, now, stage }).catch(() => null) : null;
  const outcome = lensed ? { ...draft, publication: lensed.publication } : draft;
  const lensTrace: LensTrace | null = lensed?.trace ?? null;
  // The headline figures of each statement view for this report; a failed call publishes the findings without them.
  const periodEnd = input.ledger.periodEnd;
  const written = await writeHighlights({
    ticker: params.ticker, companyName, periodEnd, table: buildHighlightTable(input.data, periodEnd), findings: outcome.publication?.findings.map(f => f.title) ?? [],
    data: input.data, model, stage,
  }).catch(() => ({ highlights: null, withheld: [] }));
  // Neither findings nor highlights verified: whatever is stored (an authored set, an older run) keeps serving.
  if (!outcome.publication && !written.highlights) return { status: "empty" as const, withheld: outcome.withheld };
  const published = await step.do("findings-publish", async () => {
    const db = requireDb(env);
    const stored = await new D1SecRepository(db).getCache<unknown>(findingsCacheKey(params.ticker));
    const previous = (stored ? readFindingsPublication(stored.payload, params.ticker) : null) ?? authoredFindings(params.ticker);
    // Earlier reports keep the highlights written when each was the newest.
    const highlights = mergeHighlights(written.highlights, previous?.highlights);
    // Findings that verified nothing fall back to the set published before (an older run or the authored set), so the
    // new highlights still land; it takes this run's fingerprint, so the same input is not written again.
    const base = outcome.publication ?? (previous ? { ...previous, fingerprint: params.fingerprint }
      : { schemaVersion: "findings.v1", ticker: params.ticker, periodEnd, generatedAt: now, model: modelVersion, fingerprint: params.fingerprint, findings: [], sources: input.ledger.sources });
    const publication = readFindingsPublication({ ...base, highlights }, params.ticker);
    if (!publication) return false;
    // Earlier publications' watches, oldest first, so the page can score each against the data as it stands now.
    const store = new AiRunStore(db);
    const record = { ...publication, record: await priorWatches(store, params.ticker, previous, publication), ...(lensTrace ? { lensTrace } : {}) };
    // The publication and its event commit together.
    await db.batch([
      db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
        .bind(findingsCacheKey(params.ticker), JSON.stringify(record), now),
      outboxStatement(db, { type: "findings.published", ticker: params.ticker }, now),
    ]);
    await new AiRunStore(requireDb(env)).saveVersion("findings", params.ticker, record, now);
    return true;
  });
  if (!published) return { status: "empty" as const, withheld: outcome.withheld };
  return { status: "ready" as const, findings: outcome.publication?.findings.length ?? 0, findingsFallback: !outcome.publication, withheld: outcome.withheld,
    lenses: lensTrace ? { composed: lensTrace.findings.filter(f => f.document).length, kept: lensTrace.findings.filter(f => !f.document).length, turns: lensTrace.findings.reduce((n, f) => n + f.turns.length, 0) } : null, highlights: written.highlights ? { cash: written.highlights.cash.length, profit: written.highlights.profit.length, balance: written.highlights.balance.length } : null, highlightsWithheld: written.withheld.length };
}
