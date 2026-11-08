import { readReportInputs, reportOpening, type ReportOutcome, type ReportSpec } from "./sec/report-agent.ts";
import { runRecipeSession } from "./pi/runs.ts";
import Anthropic from "@anthropic-ai/sdk";
import { aiToolSetting, reasoningFor, type ReasoningEffort } from "./ai-config.ts";
import { boundedModelIO } from "./model-io.ts";
import { aiUsageFromMetrics, recordAiUsage } from "./ai-runs/usage.ts";
import { readModelContent, parseModelJson, SecModelOutputError } from "./model-stream.ts";
import { recoverModelJson, SecModelHttpError, type ModelRequestOptions, type ModelCheckpoint, type ModelCheckpointStore } from "./model-recovery.ts";
export { readModelContent } from "./model-stream.ts";
export { SecModelHttpError } from "./model-recovery.ts";
import { fiscalPeriodInput } from "./sec/fiscal-period-ai.ts";
import { fetchSecMarketSnapshot } from "./sec/market.ts";
import { fiscalPeriodKey, fiscalPeriodsFromCompanyFacts, readFiscalPeriod } from "./sec/fiscal-period.ts";
import { fiscalPeriodsInSequence } from "./sec/fiscal-sequence.ts";
import { attachDiscovery, DISCOVERY_VERSION, discoveryChunkCount, discoveryChunkRequest, scanDisclosureChunk, type DiscoveryChunk } from "./sec/discovery.ts";
import { buildEarningsGroups, classificationKey, combineEarningsDocuments, earningsKey, identifyEarningsPeriod, isPeriodic } from "./sec/earnings.ts";
import type { SecEarningsGroup } from "../../../shared/analysis-contract/report.ts";
import { buildSecOutline } from "./sec/report.ts";
import {
  buildPreparedSecBrief,
  discoverSecTicker,
  prepareSecFiling,
  summarizePreparedSecEvent,
  type PreparedSecFiling,
  type PreparedSecFilingMeta,
  type SecModelCall,
} from "./sec/pipeline.ts";
import { D1SecRepository } from "./sec/d1.ts";
import type { SecAnalysisArtifact } from "./sec/types.ts";
import { cleanSecAccession, cleanSecTicker, type SecFiling, type SecFilingFeed, type SecFilingSummary } from "./sec/sec.ts";
import { coverAmendmentNote, coverAmendmentSummary, type CoverAmendment } from "./sec/amendment.ts";
import { SEC_ANALYSIS_SCHEMA_VERSION, type FilingBlock, type SecHistorySnapshot } from "./sec/analysis.ts";
import { normalizeCompanyFacts } from "./sec/history.ts";
import { archivedFiling, archiveHolds, archiveUnsupported, edgarListings, type EdgarListings } from "./sec-archive/index.ts";
import { secFundamentalsKey } from "./fundamentals/sec-fundamentals.ts";
import { assertTrackedTicker, requireDb, type SecCronEnv } from "./core.ts";
import type { AnalysisReadEnv } from "./read-api/router.ts";
import type { EventMessage, TaskMessage } from "./pipeline/messages.ts";
import { outboxStatement } from "./pipeline/outbox.ts";
import { SEC_MODEL_EXECUTION_BUDGET_MS, SEC_MODEL_FIRST_RESPONSE_MS, SEC_MODEL_OUTPUT_TOKENS, type SecModelExecution, SEC_FALLBACK_MODEL } from "./retry-policy.ts";
import type { PreparedFilingReference, AnalysisOperations, WorkflowJobUpdate } from "./workflow-core.ts";
import { jobAnalysisVersionFor } from "./workflow-core.ts";
import type { MarkdownConverter } from "./web-search/page.ts";
import { sha256 } from "./sha256.ts";

type R2ObjectLike = { etag?: string; text(): Promise<string> };
type R2BucketLike = {
  get(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string }; onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }): Promise<unknown>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string; uploaded: Date }>; truncated: boolean; cursor?: string }>;
  delete(keys: string[]): Promise<unknown>;
};

/** `get` reads an instance's engine status; the admin view uses it to settle runs that ended without a record. */
export type AiWorkflowBinding<P> = {
  create(options: { id: string; params: P }): Promise<unknown>;
  get?(id: string): Promise<{ status(): Promise<{ status: string; error?: unknown }> }>;
};

/** The slice of the Workers AI binding the tags use. */
export type TagEmbedder = { run(model: string, input: { text: string[] }): Promise<unknown> };
/** The slice of a Vectorize index the tags use. */
export type TagIndex = {
  upsert(vectors: Array<{ id: string; values: number[]; namespace?: string; metadata?: Record<string, string> }>): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
  query(vector: number[], options: { topK: number; namespace?: string; returnValues?: boolean; returnMetadata?: "none" | "indexed" | "all" }): Promise<{ matches: Array<{ id: string; score: number; namespace?: string }> }>;
};

export type AnalysisEnv = SecCronEnv & AnalysisReadEnv & {
  /** The Pi sessions of the durable run executing this task (durable-runs/runner.ts); absent elsewhere. */
  PI?: import("./pi/runs.ts").PiRuns;
  BUSINESS_EXPLAINER_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  GUIDANCE_WORKFLOW?: AiWorkflowBinding<{ ticker: string; accession: string; eventDate: string; manual?: boolean }>;
  FINDINGS_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  ITEMS_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  ANALYST_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  ANALYST_ENABLED?: string;
  ANALYST_DAILY_TURNS?: string;
  /** The checkup notes Workflow; runs with the analyst switch. */
  CHECKUP_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  /** Model turns per UTC day for checkup notes across all companies (default 240). */
  CHECKUP_DAILY_TURNS?: string;
  /** Model calls per UTC day for judging income statements no calculation or statement row balances (default 60). */
  PRESENTATION_DAILY_CALLS?: string;
  /** Read-note model calls per UTC day (pipeline/financial-tasks.ts); default 120. */
  READ_NOTE_DAILY_CALLS?: string;
  BUSINESS_TREE_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  /** The valuation assessment Workflow. */
  VALUATION_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string; generation: number }>;
  /** "false" pauses valuation runs; the admin's global switch overrides it. */
  VALUATION_ENABLED?: string;
  LIBRARY_CARDS_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  LIBRARY_LINKS_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  TRANSLATE_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  /** "false" pauses translating publications into Chinese; unset or anything else runs it. */
  TRANSLATION_ENABLED?: string;
  /** Model calls the translator may make per UTC day across all companies; unset means 300. */
  TRANSLATION_DAILY_CALLS?: string;
  /** Browser Rendering: draws the lens agent's html pictures so the agent reads what a reader would see (`browser`). */
  BROWSER?: import("@cloudflare/puppeteer").BrowserWorker;
  /** The AI Search namespace the filing library's recall layer lives in (`ai_search_namespaces`). */
  AI_SEARCH?: AiSearchNamespace;
  /** "false" pauses uploading library sections to AI Search; unset or anything else runs it. */
  LIBRARY_SEARCH_ENABLED?: string;
  /** "false" pauses the daily storage sweep; unset or anything else runs it. */
  STORAGE_SWEEP_ENABLED?: string;
  /** "false" pauses splitting archived filings into the library; unset or anything else runs it. */
  FILING_LIBRARY_ENABLED?: string;
  /** "false" pauses writing index cards for library sections; unset or anything else runs it. */
  LIBRARY_CARDS_ENABLED?: string;
  BUSINESS_TAGS_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  /** "false" pauses writing business tags; unset or anything else runs it. */
  BUSINESS_TAGS_ENABLED?: string;
  /** Workers AI, for embedding business tags and turning fetched pages into Markdown. */
  AI?: TagEmbedder & Partial<MarkdownConverter>;
  /** The Vectorize index of business tags, one namespace per sector and facet. */
  TAGS_INDEX?: TagIndex;
  /** JSON such as {"same":0.8,"near":0.68}: the cosine scores at which two tags count as the same or a near business. */
  PEER_TAG_THRESHOLDS?: string;
  /** JSON overriding an AI tool's reasoning level, e.g. {"library-cards":"high"}; see `ai-config.ts`. */
  AI_REASONING?: string;
  /** The admin's model and effort per AI tool (JSON), set only by `aiToolEnvironment`. */
  AI_TOOL_SETTINGS?: string;
  /** "false" pauses the business-tree sweep; unset or anything else runs it. The admin's global switch overrides it. */
  BUSINESS_TREE_ENABLED?: string;
  /** The four feature lists and global switches after the admin's switches (JSON), set only by `companyPolicyEnvironment`. */
  FEATURE_RESOLVED?: string;
  /** "true" lets the sweep start findings runs for AI-enabled companies; anything else leaves it off. */
  FINDINGS_ENABLED?: string;
  /** "false" pauses the deterministic events sweep (8-K and Form 4); unset or anything else runs it. */
  EVENTS_ENABLED?: string;
  /** "true" starts guidance extraction for AI-enabled companies; anything else leaves it off. */
  GUIDANCE_ENABLED?: string;
  /** "false" turns off the IR-site deck search fallback. */
  GUIDANCE_DECK_SEARCH?: string;
  GUIDANCE_DAILY_MODEL_CALLS?: string;
  /** Alpha Vantage key for earnings-call transcripts; optional. */
  ALPHA_VANTAGE_API_KEY?: string;
  TRANSCRIPTS_ENABLED?: string;
  /** Shared daily transcript request budget; defaults to the free tier's 25 requests. */
  GUIDANCE_DAILY_TRANSCRIPT_CALLS?: string;
  SEC_FILINGS: R2BucketLike;
  SEC_USER_AGENT: string;
  /** Every model call and web search goes to DeepSeek's Anthropic-format API with this key. */
  DEEPSEEK_API_KEY?: string;
  SEC_ANALYSIS_MODEL?: string;
  /** Optional stronger model for planning, review and synthesis. Unset means one model everywhere. */
  SEC_REASONING_MODEL?: string;
  /** Event routing and task runs. Optional so a partial environment simply emits nothing. */
  PIPELINE_EVENTS?: Queue<EventMessage>;
  PIPELINE_TASKS?: Queue<TaskMessage>;
  /** Which deployment is running; task versions only ever move forward to a newer one. */
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
};


/** Planning, review and synthesis carry the judgement; node extraction is mechanical. */
const REASONING_STAGE = /^(manager|synthesis|discovery-audit|editorial-review|editorial-revision)/;

export function modelForStage(env: AnalysisEnv, stage: string, override?: string): string | undefined {
  if (override) return override;
  return REASONING_STAGE.test(stage) ? env.SEC_REASONING_MODEL || undefined : undefined;
}

/** A retry pins the fallback model; otherwise the admin's choice for the SEC analysis, then the stage's deployment model. */
function secModelFor(env: AnalysisEnv, stage: string, execution?: SecModelExecution): string {
  return execution?.model || aiToolSetting(env, "sec-analysis").model || modelForStage(env, stage) || env.SEC_ANALYSIS_MODEL || SEC_FALLBACK_MODEL;
}

const sha256Hex = (value: unknown): Promise<string> => sha256(JSON.stringify(value));

/**
 * A completed discovery chunk, stored under the filing by everything its model call depends on (prompt, chunk text,
 * model, effort), so a later Workflow run of the same filing reads it instead of asking again.
 */
async function discoveryCacheKey(env: AnalysisEnv, reference: PreparedFilingReference, request: { stage: string; system: string; payload: unknown }, execution?: SecModelExecution): Promise<string> {
  const fingerprint = await sha256Hex({ version: DISCOVERY_VERSION, model: secModelFor(env, request.stage, execution), effort: reasoningFor(env, "sec-analysis"), system: request.system, payload: request.payload });
  return `${reference.key}/discovery-cache/${DISCOVERY_VERSION}/${fingerprint}.json`;
}

export function createAnalysisOperations(env: AnalysisEnv, fetcher: typeof fetch = fetch, workflowInstanceId = "standalone"): AnalysisOperations {
  const repository = () => new D1SecRepository(requireDb(env));
  // EDGAR is read for listings only; every filing's text comes from the archive (docs/sec-archive.md).
  const listings = (): EdgarListings => edgarListings(env, { fetcher });
  const archive = () => ({ DB: requireDb(env), SEC_FILINGS: env.SEC_FILINGS, SEC_USER_AGENT: env.SEC_USER_AGENT });
  // A filing is prepared only once the archive holds it whole: half a filing (its body before its exhibits) would
  // classify and cache wrongly, and `shouldAnalyze` runs after the classification.
  const prepared_ = async (filing: SecFiling) => {
    const stored = await archivedFiling(archive(), cleanSecTicker(filing.ticker), filing.accessionNumber, filing.documentUrl);
    return prepareSecFiling(filing, stored?.complete ? stored : null);
  };
  const modelFor = (ticker: string, execution?: SecModelExecution): SecModelCall => {
    const deadline = Date.now() + SEC_MODEL_EXECUTION_BUDGET_MS;
    return async (stage, system, payload) => {
      if (Date.now() >= deadline) throw new Error("Editorial step execution budget exhausted; resume from saved draft");
      const selectedModel = secModelFor(env, stage, execution);
      const fallbackModel = SEC_FALLBACK_MODEL;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ stage, system, payload }))));
      const fingerprint = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
      const key = `model-recovery/v1/${encodeURIComponent(workflowInstanceId)}/${fingerprint}.json`;
      let checkpointEtag: string | undefined;
      let checkpointDisabled = false;
      const checkpoint: ModelCheckpointStore = {
        async load() {
          try {
            const saved = await boundedModelIO(env.SEC_FILINGS.get(key), "checkpoint-load");
            checkpointEtag = saved?.etag;
            if (!saved) return null;
            const value = JSON.parse(await boundedModelIO(saved.text(), "checkpoint-body")) as ModelCheckpoint | null;
            return value?.version === "model-recovery.v1" && typeof value.content === "string" && ["continue", "repair"].includes(value.mode) ? value : null;
          } catch { console.warn(JSON.stringify({ event: "sec-model-checkpoint", action: "load", outcome: "unavailable", stage })); return null; }
        },
        async save(value) {
          if (checkpointDisabled) return;
          try {
            const saved = await boundedModelIO(env.SEC_FILINGS.put(key, JSON.stringify(value), {
              httpMetadata: { contentType: "application/json" }, onlyIf: checkpointEtag ? { etagMatches: checkpointEtag } : { etagDoesNotMatch: "*" },
            }), "checkpoint-save");
            if (saved === null) throw new Error("Checkpoint version changed");
            if (saved && typeof saved === "object" && "etag" in saved && typeof saved.etag === "string") checkpointEtag = saved.etag;
          }
          catch { checkpointDisabled = true; console.warn(JSON.stringify({ event: "sec-model-checkpoint", action: "save", outcome: "unavailable", stage })); }
        },
      };
      return recoverModelJson({ stage, model: selectedModel, fallbackModel, checkpoint,
        heartbeat: async () => {
          if (workflowInstanceId !== "standalone" && env.DB) {
            try { await boundedModelIO(env.DB.prepare("UPDATE sec_analysis_jobs SET updated_at = ? WHERE workflow_instance_id = ? AND status = 'running'")
              .bind(new Date().toISOString(), workflowInstanceId).run(), "job-heartbeat", 5000); }
            catch { console.warn(JSON.stringify({ event: "sec-model-heartbeat", workflowInstanceId, stage, outcome: "unavailable" })); }
          }
        },
        log: (event) => console.log(JSON.stringify({ ...event, workflowInstanceId })),
        request: (options) => requestWorkerSecModelContent(env, fetcher, stage, system, payload, options.model,
          Math.max(1, deadline - Date.now()), { ...options, workflowInstanceId, reasoning: reasoningFor(env, "sec-analysis"), ticker, runId: workflowInstanceId, kind: "sec-analysis" }),
      });
    };
  };
  return {
    loadFiling: async (ticker, accession) => {
      assertTrackedTicker(env, ticker);
      const saved = await repository().getPublicFiling(ticker, accession);
      if (!saved) return null;
      // Publication snapshots must carry source identity, never nest the old analysis recursively.
      return { ticker: saved.ticker, cik: saved.cik, cikNumber: saved.cikNumber, companyName: saved.companyName,
        form: saved.form, filingDate: saved.filingDate, reportDate: saved.reportDate, accessionNumber: saved.accessionNumber,
        primaryDocument: saved.primaryDocument, description: saved.description, items: saved.items,
        documentUrl: saved.documentUrl, indexUrl: saved.indexUrl, ...(saved.earningsGroup ? { earningsGroup: saved.earningsGroup } : {}) };
    },
    restoreAnalysis: async (filing, reference) => {
      const key = `${reference.key.replace(/^filings\//, "analysis/")}/${SEC_ANALYSIS_SCHEMA_VERSION}/synthesis.json`;
      const object = await env.SEC_FILINGS.get(key);
      if (!object) return null;
      const cached = JSON.parse(await object.text()) as { artifact: SecAnalysisArtifact; summary?: SecFilingSummary };
      const { artifact, summary } = cached;
      const meta = await readMeta(env.SEC_FILINGS, reference);
      const sourceIds = (ids: string[]) => ids.filter(id => id.startsWith("ev:")).sort();
      // Block IDs include content hashes. A changed source set/content invalidates reuse.
      if (!artifact || !summary?.plan?.nodes.length || !summary.nodes?.length || !artifact.managerReview
        || artifact.filing.ticker !== filing.ticker || artifact.filing.accessionNumber !== filing.accessionNumber
        || artifact.filing.reportDate !== filing.reportDate || !sourceIds(artifact.validEvidenceIds ?? []).length
        || artifact.filing.earningsGroup?.inputKey !== filing.earningsGroup?.inputKey
        || JSON.stringify(sourceIds(artifact.validEvidenceIds ?? [])) !== JSON.stringify(sourceIds(meta.blockIds))) return null;
      if (summary.discovery) await putJson(env.SEC_FILINGS, `${reference.key}/meta.json`, { ...meta, discovery: summary.discovery });
      return { plan: summary.plan, nodes: summary.nodes.filter(n => n.id !== "historical-judgment-review"), review: artifact.managerReview, rounds: summary.repairRounds ?? 0 };
    },
    classifyEarnings: async (filing, execution) => {
      // A filing the archive gave up on (over the size cap, never served) heads no group: its period's readable
      // release reports on its own instead of being merged into a report that can never be prepared.
      if (await archiveUnsupported(archive(), cleanSecTicker(filing.ticker), filing.accessionNumber)) return null;
      if (isPeriodic(filing.form)) return filing.reportDate || null;
      const cached = await repository().getCache<{ periodEnd: string | null }>(classificationKey(filing));
      if (cached) return cached.payload.periodEnd;
      const periodEnd = await identifyEarningsPeriod(await prepared_(filing), modelFor(filing.ticker, execution));
      await repository().setCache(classificationKey(filing), { periodEnd }, new Date().toISOString());
      return periodEnd;
    },
    groupEarnings: async (filings, periods) => {
      const known = new Map(filings.map((filing) => [filing.accessionNumber, filing]));
      // Keep confirmed older releases when the SEC discovery window rolls forward.
      for (const filing of filings) {
        const prior = await repository().getCache<SecEarningsGroup>(earningsKey(filing.ticker, filing.accessionNumber));
        if (!prior || prior.payload.periodEnd !== periods.get(filing.accessionNumber)) continue;
        for (const source of prior.payload.sources) {
          if (!known.has(source.accessionNumber)) known.set(source.accessionNumber, source);
          periods.set(source.accessionNumber, prior.payload.periodEnd);
        }
      }
      const grouped = buildEarningsGroups([...known.values()], periods);
      await repository().saveEarningsGroups(grouped);
      return grouped;
    },
    discover: (ticker) => discoverSecTicker(ticker, { listings: listings() }),
    publishFeed: async (feed) => {
      const typedFeed = feed as SecFilingFeed;
      const ticker = cleanSecTicker(typedFeed.ticker);
      if (!ticker) throw new Error("Invalid SEC filing index data.");
      assertTrackedTicker(env, ticker);
      const normalizedFeed = { ...typedFeed, ticker, filings: typedFeed.filings.map(toStoredFiling) };
      const store = repository();
      const db = requireDb(env), indexedAt = typedFeed.fetchedAt ?? new Date().toISOString();
      // One Company Facts read gives each periodic filing's fiscal focus and the fundamentals. Retried on every
      // discovery sweep: Company Facts can arrive after the filing index.
      const cik = normalizedFeed.company?.cik ?? normalizedFeed.filings[0]?.cik;
      const facts = cik ? await listings().companyFacts(cik).catch((error) => {
        console.warn("SEC Company Facts read failed", { ticker, error: error instanceof Error ? error.message : String(error) });
        return null;
      }) : null;
      // An issuer's DEI can repeat last year's fiscal year (Oracle's 2026-08-31 10-Q says FY2026 Q1); the stored label is the one in sequence.
      const periods = facts ? fiscalPeriodsInSequence(fiscalPeriodsFromCompanyFacts(facts, normalizedFeed.filings)) : [];
      // The indexed list, the fiscal periods guidance dates its items by, and their event commit together.
      await db.batch([
        db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
          .bind(`sec:filings:${ticker}`, JSON.stringify(normalizedFeed), indexedAt),
        ...periods.map((period) => db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at WHERE sec_cache.payload IS NOT excluded.payload")
          .bind(fiscalPeriodKey({ ticker, accessionNumber: period.sourceAccession }), JSON.stringify(period), indexedAt)),
        outboxStatement(db, { type: "filings.indexed", ticker, cik: normalizedFeed.company?.cik ?? null, causeId: null }, indexedAt),
      ]);
      await Promise.all(normalizedFeed.filings.map((filing) => store.upsertFilingIndex(filing)));
      // Publish one complete snapshot atomically; failures leave the last good snapshot intact.
      if (cik && facts) {
        try {
          const history = normalizeCompanyFacts(ticker, facts);
          if (history.series.some((series) => series.seriesId === "revenue" && series.quarters.length)) {
            const at = new Date().toISOString();
            await db.batch([
              db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
                .bind(secFundamentalsKey(ticker), JSON.stringify(history), at),
              outboxStatement(db, { type: "fundamentals.updated", ticker, cik, causeId: null }, at),
            ]);
          }
        } catch (error) {
          console.warn("SEC fundamentals refresh failed", { ticker, error: error instanceof Error ? error.message : String(error) });
        }
      }
    },
    shouldAnalyze: async (filing, requestedBy) => {
      try { assertTrackedTicker(env, filing.ticker); } catch { return false; }
      if (requestedBy === "manual") return true;
      const ticker = cleanSecTicker(filing.ticker);
      if (!ticker) throw new Error("Invalid SEC job lookup.");
      assertTrackedTicker(env, ticker);
      // A filing the archive does not hold yet is analysed by the run its `filing.archived` event starts.
      if (!await archiveHolds(archive(), ticker, filing.accessionNumber, filing.documentUrl)) return false;
      if (filing.earningsGroup) {
        const summary = await repository().getSummary(ticker, filing.accessionNumber);
        if (summary?.earningsGroup?.inputKey !== filing.earningsGroup.inputKey) {
          const active = await repository().getAnalysisJobStatus(ticker, filing.accessionNumber, jobAnalysisVersionFor(filing.form));
          return active !== "running" && active !== "queued";
        }
      }
      const status = await repository().getAnalysisJobStatus(ticker, filing.accessionNumber, jobAnalysisVersionFor(filing.form));
      if (status === "complete") {
        const summary = await repository().getSummary(ticker, filing.accessionNumber);
        // The note is the filing's own statement. It does not age out with the discovery schema.
        if (summary?.source === "filing") return false;
        return summary?.discovery?.version !== "sec-discovery.v1";
      }
      return status === null || status === "failed";
    },
    getContext: async (filing, reference) => {
      const history = reference ? await readHistory(env.SEC_FILINGS, reference) : EMPTY_HISTORY;
      const ticker = cleanSecTicker(filing.ticker);
      if (!ticker || !filing.accessionNumber) throw new Error("Invalid SEC filing.");
      assertTrackedTicker(env, ticker);
      const normalizedFiling = { ...filing, ticker };
      const store = repository();
      await store.saveHistory(normalizedFiling, history);
      const context = await store.getAnalysisContext(normalizedFiling);
      const finalHistory = context.history ?? history;
      const marketSnapshot = await fetchSecMarketSnapshot(normalizedFiling, finalHistory, fetcher);
      return { ...context, history: finalHistory, marketSnapshot };
    },
    prepare: async (filing) => {
      let prepared = await prepared_(filing);
      if (filing.earningsGroup) {
        const supplements: PreparedSecFiling[] = [], left: string[] = [];
        for (const source of filing.earningsGroup.sources) {
          if (source.accessionNumber === filing.accessionNumber) continue;
          // A source the archive gave up on (over the size cap, never served) is left out, named; one not archived yet
          // still fails the run, which comes back once it is.
          const reason = await archiveUnsupported(archive(), cleanSecTicker(filing.ticker), source.accessionNumber);
          if (reason) { left.push(`${source.form} ${source.accessionNumber}: ${reason}`); continue; }
          supplements.push(await prepared_(source));
        }
        prepared = combineEarningsDocuments(prepared, supplements);
        if (left.length) prepared.materialWarnings = [...(prepared.materialWarnings ?? []), ...left.map(l => `Earnings source not read: ${l}.`)];
        prepared.outline = buildSecOutline(prepared.document);
      }
      prepared.fiscalSourceExcerpts = fiscalPeriodInput(prepared.document.text);
      prepared.reportedFiscalPeriod = env.DB ? await readFiscalPeriod(repository(), filing).catch(() => null) : null;
      const history = await fetchCompanyHistory(filing.cik, filing.ticker, listings()).catch(() => EMPTY_HISTORY);
      const key = preparedKey(filing.ticker, filing.accessionNumber);
      const { blocks, document, ...meta } = prepared;
      await Promise.all([
        putJson(env.SEC_FILINGS, `${key}/meta.json`, meta),
        putJson(env.SEC_FILINGS, `${key}/text.json`, { document, blocks }),
        putJson(env.SEC_FILINGS, `${key}/history.json`, history),
      ]);
      const coverAmendment = coverAmendmentNote(filing.form, document.text);
      return { key, filing, discoveryChunks: discoveryChunkCount(document.text.length), ...(coverAmendment ? { coverAmendment } : {}) };
    },
    scanDisclosures: async (_filing, reference, index, execution) => {
      const prepared = await readPrepared(env.SEC_FILINGS, reference);
      // An invalid index has no request; the scan below reports it as before.
      const cacheKey = await Promise.resolve().then(() => discoveryCacheKey(env, reference, discoveryChunkRequest(prepared, index), execution)).catch(() => null);
      const stored = cacheKey ? await env.SEC_FILINGS.get(cacheKey).then(o => o ? o.text() : null).then(t => t ? JSON.parse(t) as DiscoveryChunk : null).catch(() => null) : null;
      let chunk: DiscoveryChunk;
      if (stored?.status === "complete" && stored.index === index) chunk = stored;
      else {
        try { chunk = await scanDisclosureChunk(prepared, index, modelFor(reference.filing.ticker, execution)); }
        catch (error) {
          if (!execution?.finalAttempt) throw error;
          chunk = {index,start:0,end:0,status:"failed",disclosures:[],rejected:0};
        }
        // Only a chunk that passed validation is reused; a failed one is asked again next run.
        if (cacheKey && chunk.status === "complete") await putJson(env.SEC_FILINGS, cacheKey, chunk).catch(() => undefined);
      }
      await putArtifact(env.SEC_FILINGS, reference, `discovery/chunk-${index}`, chunk);
      return chunk;
    },
    finishDiscovery: async (_filing, reference, chunks) => {
      const prepared = await readPrepared(env.SEC_FILINGS, reference);
      const { document, blocks, ...meta } = prepared;
      void blocks;
      const enriched = attachDiscovery(meta, document.text.length, chunks);
      await putJson(env.SEC_FILINGS, `${reference.key}/meta.json`, enriched);
      await putArtifact(env.SEC_FILINGS, reference, "discovery/final", enriched.discovery);
      return {groundedDisclosures:enriched.discovery?.disclosures.length ?? 0};
    },
    buildBrief: async (_filing, reference, context) => {
      const meta = await readMeta(env.SEC_FILINGS, reference);
      const history = context.history ?? await readHistory(env.SEC_FILINGS, reference);
      const brief = buildPreparedSecBrief(meta, context, history);
      await putArtifact(env.SEC_FILINGS, reference, "brief", brief);
      return brief;
    },
    summarizeEvent: async (filing, reference, execution) => ({
      ...await summarizePreparedSecEvent(await readPrepared(env.SEC_FILINGS, reference), modelFor(reference.filing.ticker, execution), new Date(), await readHistory(env.SEC_FILINGS, reference)),
      ...(filing.earningsGroup ? { earningsGroup: filing.earningsGroup } : {}),
    }),
    writeReport: async (filing, reference, context, brief, restored, step) => {
      const operationId = `report:${reference.filing.accessionNumber}`;
      await step.do(`${operationId}:inputs`, async () => {
        await Promise.all([putArtifact(env.SEC_FILINGS, reference, "context", context), putArtifact(env.SEC_FILINGS, reference, "brief", brief)]);
      });
      const { prepared } = await readReportInputs(env, reference);
      const spec: ReportSpec = { reference, workflowInstanceId, restored };
      const outcome = await runRecipeSession<ReportOutcome>(env, step, "sec-report", spec, reportOpening(prepared, brief, restored), operationId);
      const written = outcome.output;
      if (!written.passed || !written.plan || !written.review) {
        throw new Error(written.issues.length ? `Reader report failed editorial review: ${written.issues.join("; ").slice(0, 1000)}`
          : `Synthesis did not finish: the report session ended (${outcome.reason}) without a passed report`);
      }
      const passed = written.passed;
      const result = await step.do(`${operationId}:result`, async () => {
        const stored = await readJson<{ artifact: SecAnalysisArtifact; summary: SecFilingSummary }>(env.SEC_FILINGS, passed.resultKey);
        stored.artifact.report.editorialReview = { status: "passed", reviewedAt: passed.reviewedAt, ...(passed.notes.length ? { notes: passed.notes } : {}) };
        return { ...stored, artifact: { ...stored.artifact, blocks: [], artifactKeys: collectArtifactKeys(reference, passed.resultKey) } };
      });
      return { plan: written.plan, nodes: written.nodes, managerReview: written.review, rounds: written.rounds, result };
    },
    publish: async (artifact, summary) => {
      if (artifact.report.reader && artifact.report.editorialReview?.status !== "passed") throw new Error("Reader report has not passed editorial review");
      const reference = { key: preparedKey(artifact.filing.ticker, artifact.filing.accessionNumber), filing: artifact.filing };
      if (artifact.report.reader) await putArtifact(env.SEC_FILINGS, reference, "synthesis", { artifact, summary });
      const ticker = cleanSecTicker(artifact.filing.ticker);
      const accessionNumber = cleanSecAccession(artifact.filing.accessionNumber);
      if (!accessionNumber || !ticker) throw new Error("Invalid SEC analysis result.");
      assertTrackedTicker(env, ticker);
      const store = repository();
      if (artifact.filing.earningsGroup) {
        const latest = await store.getCache<SecEarningsGroup>(earningsKey(ticker, accessionNumber));
        if (latest?.payload.inputKey !== artifact.filing.earningsGroup.inputKey) throw new Error("Earnings sources changed during analysis; retry with the current group");
      }
      const normalizedFiling = { ...artifact.filing, ticker, accessionNumber };
      const normalizedArtifact = { ...artifact, filing: normalizedFiling };
      await store.saveAnalysis(normalizedArtifact, false);
      if (artifact.report.dataQuality.verificationStatus === "failed") return {};
      if (!summary) throw new Error("SEC publication is missing the report summary.");
      const memoryJobId = await store.commitFinalPublication(normalizedArtifact, summary);
      return { memoryJobId };
    },
    enqueueMemory: async (jobId, ticker) => {
      if (!env.SEC_MEMORY_WORKFLOW) return;
      await env.SEC_MEMORY_WORKFLOW.create({ id: `memory-${crypto.randomUUID()}`, params: { jobId, ticker } });
    },
    publishAmendment: async (filing, note: CoverAmendment) => {
      const ticker = cleanSecTicker(filing.ticker);
      const accessionNumber = cleanSecAccession(filing.accessionNumber);
      const summary = coverAmendmentSummary({ ...filing, ticker, accessionNumber }, note);
      if (!ticker || !accessionNumber || summary.source !== "filing" || !/^(?:10-[KQ]|20-F|40-F)\/A$/.test(summary.form)) throw new Error("Invalid amendment note.");
      assertTrackedTicker(env, ticker);
      const previous = await repository().getSummary(ticker, accessionNumber);
      if (previous?.generatedAt) await repository().setCache(`admin:summary:${ticker}:${accessionNumber}:${previous.generatedAt}`, previous, previous.generatedAt);
      await repository().setSummary({ ticker, accessionNumber, form: summary.form }, summary);
    },
    publishEvent: async (summary) => {
      const identity = summaryIdentity(summary);
      const eventTicker = cleanSecTicker(identity.ticker);
      const eventAccession = cleanSecAccession(identity.accessionNumber);
      const validEvent = /^(8-K|6-K)(\/A)?$/.test(identity.form)
        && Boolean(eventTicker)
        && summary.source !== "error"
        && summary.ticker === eventTicker
        && summary.form === identity.form
        && summary.accessionNumber === eventAccession;
      if (!validEvent) throw new Error("Invalid SEC event summary.");
      assertTrackedTicker(env, eventTicker);
      // Compact event reports also retain versions when their current summary is replaced.
      const previous = await repository().getSummary(eventTicker, eventAccession);
      if (previous?.generatedAt) await repository().setCache(`admin:summary:${eventTicker}:${eventAccession}:${previous.generatedAt}`, previous, previous.generatedAt);
      await repository().setCache(`admin:summary:${eventTicker}:${eventAccession}:${summary.generatedAt}`, summary, summary.generatedAt);
      await repository().setSummary(
        { ticker: eventTicker, accessionNumber: eventAccession, form: identity.form },
        { ...summary, ticker: eventTicker, accessionNumber: eventAccession },
      );
    },
    updateJob: async (job: WorkflowJobUpdate) => {
      const ticker = cleanSecTicker(job.ticker);
      if (!ticker || !job.jobId || !job.accessionNumber) throw new Error("Invalid SEC job status.");
      assertTrackedTicker(env, ticker);
      await repository().upsertAnalysisJob({ ...job, ticker });
    },
    markJobStage: async (jobId: string, stage: string) => {
      if (!env.DB) return;
      await env.DB.prepare("UPDATE sec_analysis_jobs SET current_stage = ?, updated_at = ? WHERE job_id = ? AND status = 'running'")
        .bind(stage, new Date().toISOString(), jobId).run();
    },
  };
}

const EMPTY_HISTORY: SecHistorySnapshot = { registryVersion: "sec-canonical-series.v1", series: [] };

function toStoredFiling(filing: SecFilingFeed["filings"][number]): SecFiling {
  return {
    ...(filing.earningsGroup ? { earningsGroup: filing.earningsGroup } : {}),
    ticker: filing.ticker,
    cik: filing.cik,
    cikNumber: filing.cikNumber,
    companyName: filing.companyName,
    form: filing.form,
    filingDate: filing.filingDate,
    reportDate: filing.reportDate,
    accessionNumber: filing.accessionNumber,
    primaryDocument: filing.primaryDocument,
    description: filing.description,
    items: filing.items,
    documentUrl: filing.documentUrl,
    indexUrl: filing.indexUrl,
  };
}

async function readJson<T>(bucket: R2BucketLike, key: string): Promise<T> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`Prepared filing not found: ${key}`);
  return JSON.parse(await object.text()) as T;
}

async function putJson(bucket: R2BucketLike, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
}

function readMeta(bucket: R2BucketLike, reference: PreparedFilingReference): Promise<PreparedSecFilingMeta> {
  return readJson<PreparedSecFilingMeta>(bucket, `${reference.key}/meta.json`);
}

function readHistory(bucket: R2BucketLike, reference: PreparedFilingReference): Promise<SecHistorySnapshot> {
  return readJson<SecHistorySnapshot>(bucket, `${reference.key}/history.json`).catch(() => EMPTY_HISTORY);
}

async function readPrepared(bucket: R2BucketLike, reference: PreparedFilingReference): Promise<PreparedSecFiling> {
  const [meta, body] = await Promise.all([
    readMeta(bucket, reference),
    readJson<{ document: PreparedSecFiling["document"]; blocks: FilingBlock[] }>(bucket, `${reference.key}/text.json`),
  ]);
  return { ...meta, document: body.document, blocks: body.blocks };
}

function preparedKey(ticker: string, accessionNumber: string) {
  return `filings/${ticker}/${accessionNumber}`;
}

function summaryIdentity(summary: SecFilingSummary) {
  return {
    ticker: summary.ticker,
    form: summary.form,
    filingDate: summary.filingDate,
    accessionNumber: summary.accessionNumber,
  };
}

async function fetchCompanyHistory(cik: string, ticker: string, listings: EdgarListings) {
  return normalizeCompanyFacts(ticker, await listings.companyFacts(cik));
}

async function putArtifact(bucket: R2BucketLike, reference: PreparedFilingReference, name: string, value: unknown): Promise<string> {
  const key = `${reference.key.replace(/^filings\//, "analysis/")}/${SEC_ANALYSIS_SCHEMA_VERSION}/${name}.json`;
  await bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
  return key;
}

function collectArtifactKeys(reference: PreparedFilingReference, synthesisKey: string): Record<string, string> {
  const prefix = `${reference.key.replace(/^filings\//, "analysis/")}/${SEC_ANALYSIS_SCHEMA_VERSION}`;
  return {
    brief: `${prefix}/brief.json`,
    plan: `${prefix}/manager-plan.json`,
    "manager-review": `${prefix}/manager-review/final.json`,
    nodes: `${prefix}/nodes/final.json`,
    synthesis: synthesisKey,
  };
}

export async function callWorkerSecModel(
  env: AnalysisEnv, fetcher: typeof fetch, stage: string, system: string, payload: unknown,
  modelOverride?: string, executionBudgetMs = SEC_MODEL_EXECUTION_BUDGET_MS,
  tuning?: ModelCallTuning,
): Promise<Record<string, unknown>> {
  return parseModelJson(await requestWorkerSecModelContent(env, fetcher, stage, system, payload, modelOverride, executionBudgetMs, tuning));
}

/**
 * Per-call limits for narrow extraction stages, the AI tool's reasoning level, and the provider-reported usage when the
 * call ends. `ticker`, `runId` and `kind` only label the row in the `ai_usage` ledger; the kind is read from the stage
 * name when a caller leaves it out.
 */
export type ModelCallTuning = {
  maxTokens?: number; reasoning?: ReasoningEffort; onMetrics?: (metrics: Readonly<Record<string, unknown>>) => void;
  ticker?: string; runId?: string; kind?: string;
  /** The reader and conversation a stage call served, for the ledger. */
  userHash?: string; conversationId?: string;
};

async function requestWorkerSecModelContent(
  env: AnalysisEnv,
  fetcher: typeof fetch,
  stage: string,
  system: string,
  payload: unknown,
  modelOverride?: string,
  executionBudgetMs = SEC_MODEL_EXECUTION_BUDGET_MS,
  options?: Partial<ModelRequestOptions> & Pick<ModelCallTuning, "onMetrics" | "reasoning" | "ticker" | "runId" | "kind">,
): Promise<string> {
  const apiKey = await resolveWorkerModelKey(env, fetcher);
  const started = Date.now();
  const controller = new AbortController();
  let timeoutKind = "execution-budget";
  const budgetTimer = setTimeout(() => { timeoutKind = "execution-budget"; controller.abort(); }, executionBudgetMs);
  const firstTimer = setTimeout(() => { timeoutKind = "first-response"; controller.abort(); }, SEC_MODEL_FIRST_RESPONSE_MS);
  const model = modelOverride || env.SEC_ANALYSIS_MODEL || SEC_FALLBACK_MODEL;
  const metrics: Record<string, unknown> = { stage, model, inputCharacters: JSON.stringify(payload).length };
  if (options?.workflowInstanceId) metrics.workflowInstanceId = options.workflowInstanceId;
  // Pings count as liveness: an adaptive-thinking model can think for minutes without emitting a visible delta.
  let liveAt = Date.now();
  const client = modelClient(apiKey, executionBudgetMs, fetcher, metrics, () => { liveAt = Date.now(); });
  try {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: JSON.stringify(payload) }];
  if (options?.continuation) messages.push(
    { role: "assistant", content: options.continuation },
    { role: "user", content: "The response was interrupted. Continue this exact JSON at the next character, including inside an unfinished string. Output only the missing suffix: no prefix repetition, no markdown. Preserve all completed content and evidence references. Finish the entire required object." },
  );
  if (options?.repair) messages.push(
    { role: "assistant", content: options.repair },
    { role: "user", content: "Repair the previous response into one complete JSON object matching the original schema. Preserve its substantive analysis and evidence; fix syntax and complete missing fields from the original inputs. Do not replace the report with a summary. Output the complete repaired object only." },
  );
  metrics.maxTokens = options?.maxTokens ?? SEC_MODEL_OUTPUT_TOKENS;
  metrics.reasoning = options?.reasoning ?? "high";
  metrics.mode = options?.continuation ? "continuation" : options?.repair ? "repair" : "initial";
  // The Anthropic format has no JSON response mode short of a schema; the system prompt asks for one object and `parseModelJson` holds it to that.
  let stream: AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent> & { controller: AbortController };
  try {
    stream = await client.beta.messages.create({
      model,
      // A stable system block lets repeated calls of the same stage read it from the prompt cache.
      system: [{ type: "text", text: `${system}\nReturn one valid JSON object only.`, cache_control: { type: "ephemeral" } }],
      messages,
      // Adaptive thinking is the default; effort sets how deep it goes.
      output_config: { effort: options?.reasoning ?? "high" },
      max_tokens: options?.maxTokens ?? SEC_MODEL_OUTPUT_TOKENS,
      // Streaming keeps bytes flowing on long generations and lets a stalled connection be detected.
      stream: true,
    }, { signal: controller.signal }) as typeof stream;
  } catch (error) {
    if (!(error instanceof Anthropic.APIError) || error instanceof Anthropic.APIUserAbortError) throw error;
    // Transport failures carry no status; the recovery loop retries them as it retries a failed fetch.
    if (error instanceof Anthropic.APIConnectionError || error.status === undefined) throw new TypeError(`Model ${model} ${stage} transport: ${error.message}`);
    const failure = httpFailure(error, model, stage, apiKey);
    metrics.providerCode = failure.providerCode;
    throw failure;
  }
  clearTimeout(firstTimer);
  metrics.headersMs = Date.now() - started;
  return await readModelContent(stream, stage, () => {
    metrics.firstTokenMs ??= Date.now() - started;
    metrics.lastTokenMs = Date.now() - started;
  }, metrics, undefined, {
    signal: controller.signal, liveAt: () => liveAt, cancel: () => stream.controller.abort(),
    checkpoint: options?.checkpoint, heartbeat: options?.heartbeat,
  });
  } catch (error) {
    metrics.error = controller.signal.aborted ? `model-timeout:${timeoutKind}` : error instanceof SecModelHttpError ? `http:${error.status}` : error instanceof SecModelOutputError ? error.code : error instanceof Error ? error.name : "unknown";
    if (controller.signal.aborted) throw new Error(`model-timeout:${timeoutKind} stage=${stage} elapsedMs=${Date.now() - started}`);
    throw error;
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(budgetTimer);
    await recordModelCall(env, metrics, started, { ...options, runId: options?.runId ?? (options?.workflowInstanceId && options.workflowInstanceId !== "standalone" ? options.workflowInstanceId : undefined) });
  }
}

/** DeepSeek's Anthropic-format endpoint, which the SDK speaks unchanged. */
export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";

/** The client every model call uses: DeepSeek's endpoint, no SDK retries, and a body watcher for liveness. */
function modelClient(apiKey: string, timeout: number, fetcher: typeof fetch, metrics: Record<string, unknown>, onBytes: () => void, onHeaders?: () => void): Anthropic {
  return new Anthropic({
    apiKey, baseURL: DEEPSEEK_ANTHROPIC_BASE_URL, maxRetries: 0, timeout,
    fetch: async (input, init) => {
      const response = await fetcher(input, init);
      onHeaders?.();
      if (!response.body) return response;
      const observed = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { onBytes(); metrics.wireBytes = Number(metrics.wireBytes ?? 0) + chunk.byteLength; controller.enqueue(chunk); },
      }));
      return new Response(observed, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
}

/** An HTTP failure with its status, provider code and retry-after, for the recovery loop; the key never reaches the message. */
function httpFailure(error: InstanceType<typeof Anthropic.APIError>, model: string, stage: string, apiKey: string): SecModelHttpError {
  const retryAfter = error.headers?.get("retry-after");
  const retryAfterMs = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())) : 0;
  const code = (error.error as { error?: { type?: unknown } } | undefined)?.error?.type;
  const providerCode = typeof code === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : undefined;
  return new SecModelHttpError(error.status!, `Model ${model} ${stage} HTTP ${error.status}: ${error.message.replaceAll(apiKey, "[redacted]").slice(0, 1000)}`, retryAfterMs, providerCode);
}

/** Every call, however it ended, is logged and is a row in the cost ledger; the write is bounded and never throws. */
async function recordModelCall(env: AnalysisEnv, metrics: Record<string, unknown>, started: number, tuning: Pick<ModelCallTuning, "onMetrics" | "ticker" | "runId" | "kind" | "userHash" | "conversationId">): Promise<void> {
  console.log(JSON.stringify({ event: "sec-model-request", ...metrics, elapsedMs: Date.now() - started }));
  try { tuning.onMetrics?.(metrics); } catch { /* Usage accounting never fails a model call. */ }
  await recordAiUsage(env, aiUsageFromMetrics(metrics, {
    at: new Date(started).toISOString(), durationMs: Date.now() - started, provider: "deepseek",
    ticker: tuning.ticker, kind: tuning.kind, runId: tuning.runId, userHash: tuning.userHash, conversationId: tuning.conversationId,
  }));
}

export async function resolveWorkerModelKey(env: AnalysisEnv, fetcher: typeof fetch = fetch): Promise<string> {
  void fetcher;
  if (!env.DEEPSEEK_API_KEY) throw new Error("SEC pipeline DEEPSEEK_API_KEY is not configured");
  return env.DEEPSEEK_API_KEY;
}
