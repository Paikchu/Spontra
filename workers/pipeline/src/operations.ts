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
import { normalizeEditorialIssues, editorialRequirements } from "./sec/editorial.ts";
import { EDITORIAL_REVIEW_PROMPT, identifyReaderMarketSnapshot } from "./sec/reader.ts";
import { refreshFiscalPeriods, readFiscalPeriod } from "./sec/fiscal-period.ts";
import { attachDiscovery, auditDisclosureCoverage, discoveryChunkCount, scanDisclosureChunk, type DiscoveryChunk } from "./sec/discovery.ts";
import { buildEarningsGroups, classificationKey, combineEarningsDocuments, earningsKey, identifyEarningsPeriod, isPeriodic } from "./sec/earnings.ts";
import type { SecEarningsGroup } from "../../../shared/analysis-contract/report.ts";
import { buildSecOutline } from "./sec/report.ts";
import {
  analyzePreparedSecNode,
  buildPreparedSecBrief,
  failedSecNode,
  discoverSecTicker,
  PRESENTATION_FALLBACK_WARNING,
  planPreparedSecFiling,
  prepareSecFiling,
  reviewPreparedSecAnalysis,
  summarizePreparedSecEvent,
  summarizePreparedSecFiling,
  type PreparedSecFiling,
  type PreparedSecFilingMeta,
  type SecModelCall,
} from "./sec/pipeline.ts";
import { SEC_PRESENTATION_SCHEMA } from "../../../shared/analysis-contract/sec-presentation.ts";
import { buildSecTrends, composeSecPresentation } from "./sec/presentation.ts";
import { figureCatalog } from "./sec/figures.ts";
import { D1SecRepository } from "./sec/d1.ts";
import type { SecAnalysisArtifact } from "./sec/types.ts";
import { cleanSecAccession, cleanSecTicker, type SecFiling, type SecFilingFeed, type SecFilingSummary, type SecNodePlan, type SecNodeResult, type SecNodeSpec } from "./sec/sec.ts";
import { SEC_ANALYSIS_SCHEMA_VERSION, type FilingBlock, type ManagerReview, type SecHistorySnapshot } from "./sec/analysis.ts";
import { normalizeCompanyFacts } from "./sec/history.ts";
import { secFundamentalsKey } from "./fundamentals/sec-fundamentals.ts";
import { assertTrackedTicker, requireDb, type SecCronEnv } from "./core.ts";
import type { AnalysisReadEnv } from "./read-api/router.ts";
import type { EventMessage, TaskMessage } from "./pipeline/messages.ts";
import { outboxStatement } from "./pipeline/outbox.ts";
import { SEC_MODEL_EXECUTION_BUDGET_MS, SEC_MODEL_FIRST_RESPONSE_MS, SEC_MODEL_OUTPUT_TOKENS, SEC_MODEL_STALL_MS, type SecModelExecution, SEC_FALLBACK_MODEL } from "./retry-policy.ts";
import type { PreparedFilingReference, SecPipelineOperations, WorkflowJobUpdate } from "./workflow-core.ts";
import { jobAnalysisVersionFor } from "./workflow-core.ts";

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

export type SecPipelineEnv = SecCronEnv & AnalysisReadEnv & {
  BUSINESS_EXPLAINER_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  GUIDANCE_WORKFLOW?: AiWorkflowBinding<{ ticker: string; accession: string; eventDate: string; manual?: boolean }>;
  FINDINGS_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  ANALYST_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  ANALYST_ENABLED?: string;
  ANALYST_DAILY_TURNS?: string;
  /** Model calls per UTC day for judging income statements no calculation or statement row balances (default 60). */
  PRESENTATION_DAILY_CALLS?: string;
  BUSINESS_TREE_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  LIBRARY_CARDS_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  LIBRARY_LINKS_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  TRANSLATE_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  /** "false" pauses translating publications into Chinese; unset or anything else runs it. */
  TRANSLATION_ENABLED?: string;
  /** Model calls the translator may make per UTC day across all companies; unset means 300. */
  TRANSLATION_DAILY_CALLS?: string;
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
  /** Workers AI, for embedding business tags (docs/peer-similarity-design.md). */
  AI?: TagEmbedder;
  /** The Vectorize index of business tags, one namespace per sector and facet. */
  TAGS_INDEX?: TagIndex;
  /** JSON such as {"same":0.8,"near":0.68}: the cosine scores at which two tags count as the same or a near business. */
  PEER_TAG_THRESHOLDS?: string;
  /** JSON overriding an AI tool's reasoning level, e.g. {"library-cards":"high"}; see `ai-config.ts`. */
  AI_REASONING?: string;
  /** The admin's model and effort per AI tool (JSON), set only by `aiToolEnvironment`. */
  AI_TOOL_SETTINGS?: string;
  /** Companies whose businesses the ReAct agent breaks down; unset falls back to the AI list. */
  BUSINESS_TREE_TICKERS?: string;
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
  ANTHROPIC_API_KEY?: string;
  /** The Claude workspace the key belongs to; a key not scoped to a workspace must name one on every request. */
  ANTHROPIC_WORKSPACE_ID?: string;
  SEC_ANALYSIS_MODEL?: string;
  /** Optional stronger model for planning, review and synthesis. Unset means one model everywhere. */
  SEC_REASONING_MODEL?: string;
  /** Event routing and task runs (docs/pipeline-events.md). Optional so a partial environment simply emits nothing. */
  PIPELINE_EVENTS?: Queue<EventMessage>;
  PIPELINE_TASKS?: Queue<TaskMessage>;
  /** Which deployment is running; task versions only ever move forward to a newer one. */
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
};


/** Planning, review and synthesis carry the judgement; node extraction is mechanical. */
const REASONING_STAGE = /^(manager|synthesis|discovery-audit|editorial-review|editorial-revision)/;

export function modelForStage(env: SecPipelineEnv, stage: string, override?: string): string | undefined {
  if (override) return override;
  return REASONING_STAGE.test(stage) ? env.SEC_REASONING_MODEL || undefined : undefined;
}

export function createSecPipelineOperations(env: SecPipelineEnv, fetcher: typeof fetch = fetch, workflowInstanceId = "standalone"): SecPipelineOperations {
  const repository = () => new D1SecRepository(requireDb(env));
  const modelFor = (execution?: SecModelExecution): SecModelCall => {
    const deadline = Date.now() + SEC_MODEL_EXECUTION_BUDGET_MS;
    return async (stage, system, payload) => {
      if (Date.now() >= deadline) throw new Error("Editorial step execution budget exhausted; resume from saved draft");
      // A retry pins the fallback model; otherwise the admin's choice for the SEC analysis, then the stage's deployment model.
      const selectedModel = execution?.model || aiToolSetting(env, "sec-analysis").model || modelForStage(env, stage) || env.SEC_ANALYSIS_MODEL || SEC_FALLBACK_MODEL;
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
      return recoverModelJson({ stage, model: selectedModel, fallbackModel, jsonMode: (execution?.attempt ?? 1) === 1, checkpoint,
        heartbeat: async () => {
          if (workflowInstanceId !== "standalone" && env.DB) {
            try { await boundedModelIO(env.DB.prepare("UPDATE sec_analysis_jobs SET updated_at = ? WHERE workflow_instance_id = ? AND status = 'running'")
              .bind(new Date().toISOString(), workflowInstanceId).run(), "job-heartbeat", 5000); }
            catch { console.warn(JSON.stringify({ event: "sec-model-heartbeat", workflowInstanceId, stage, outcome: "unavailable" })); }
          }
        },
        log: (event) => console.log(JSON.stringify({ ...event, workflowInstanceId })),
        request: (options) => requestWorkerSecModelContent(env, fetcher, stage, system, payload, options.model,
          Math.max(1, deadline - Date.now()), options.jsonMode, { ...options, workflowInstanceId, reasoning: reasoningFor(env, "sec-analysis"), kind: "sec-analysis" }),
      });
    };
  };
  const draftCheckpoint = (reference: PreparedFilingReference, round: number) => {
    const name = `editorial/${encodeURIComponent(workflowInstanceId)}/round-${round}/candidate`;
    const key = `${reference.key.replace(/^filings\//, "analysis/")}/${SEC_ANALYSIS_SCHEMA_VERSION}/${name}.json`;
    return {
      async load(): Promise<Record<string, unknown> | undefined> {
        const saved = await env.SEC_FILINGS.get(key);
        return saved ? JSON.parse(await saved.text()) as Record<string, unknown> : undefined;
      },
      async saveCandidate(candidate: Record<string, unknown>) { await putArtifact(env.SEC_FILINGS, reference, name, candidate); },
    };
  };
  const primaryEvidence = async (reference: PreparedFilingReference, nodes: SecNodeResult[]) => {
    const prepared = await readPrepared(env.SEC_FILINGS, reference);
    const ids = new Set(nodes.flatMap((n) => [...(n.evidenceIds ?? []), ...(n.facts ?? []).flatMap((f) => f.evidenceIds)]));
    let remaining = 160_000;
    return prepared.blocks.filter((b) => ids.has(`ev:${b.blockId}`) || ids.has(b.blockId)).map((b) => {
      const text = b.body.slice(0, Math.max(0, Math.min(remaining, 12_000)));
      remaining -= text.length;
      return { evidenceId: `ev:${b.blockId}`, heading: b.heading, text, truncated: text.length < b.body.length };
    });
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
      if (isPeriodic(filing.form)) return filing.reportDate || null;
      const cached = await repository().getCache<{ periodEnd: string | null }>(classificationKey(filing));
      if (cached) return cached.payload.periodEnd;
      const prepared = await prepareSecFiling(filing, { userAgent: env.SEC_USER_AGENT, fetcher });
      const periodEnd = await identifyEarningsPeriod(prepared, modelFor(execution));
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
    discover: (ticker) => discoverSecTicker(ticker, { userAgent: env.SEC_USER_AGENT, fetcher }),
    publishFeed: async (feed) => {
      const typedFeed = feed as SecFilingFeed;
      const ticker = cleanSecTicker(typedFeed.ticker);
      if (!ticker) throw new Error("Invalid SEC filing index data.");
      assertTrackedTicker(env, ticker);
      const normalizedFeed = { ...typedFeed, ticker, filings: typedFeed.filings.map(toStoredFiling) };
      const store = repository();
      const db = requireDb(env), indexedAt = typedFeed.fetchedAt ?? new Date().toISOString();
      // The indexed list and its event commit together; guidance reads this list for the filings it extracts from.
      await db.batch([
        db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
          .bind(`sec:filings:${ticker}`, JSON.stringify(normalizedFeed), indexedAt),
        outboxStatement(db, { type: "filings.indexed", ticker, cik: normalizedFeed.company?.cik ?? null, causeId: null }, indexedAt),
      ]);
      await Promise.all(normalizedFeed.filings.map((filing) => store.upsertFilingIndex(filing)));
      await refreshFiscalPeriods(store, normalizedFeed.filings, env.SEC_USER_AGENT, fetcher);
      // Retry on every discovery sweep: Company Facts can arrive after the filing index.
      // Publish one complete snapshot atomically; failures leave the last good snapshot intact.
      const cik = normalizedFeed.company?.cik ?? normalizedFeed.filings[0]?.cik;
      if (cik) {
        try {
          const history = await fetchCompanyHistory(cik, ticker, env.SEC_USER_AGENT, fetcher);
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
      let prepared = await prepareSecFiling(filing, { userAgent: env.SEC_USER_AGENT, fetcher });
      if (filing.earningsGroup) {
        const supplements: PreparedSecFiling[] = [];
        for (const source of filing.earningsGroup.sources) {
          if (source.accessionNumber !== filing.accessionNumber) supplements.push(await prepareSecFiling(source, { userAgent: env.SEC_USER_AGENT, fetcher }));
        }
        prepared = combineEarningsDocuments(prepared, supplements);
        prepared.outline = buildSecOutline(prepared.document);
      }
      prepared.fiscalSourceExcerpts = fiscalPeriodInput(prepared.document.text);
      prepared.reportedFiscalPeriod = env.DB ? await readFiscalPeriod(repository(), filing).catch(() => null) : null;
      const history = await fetchCompanyHistory(filing.cik, filing.ticker, env.SEC_USER_AGENT, fetcher).catch(() => EMPTY_HISTORY);
      const key = preparedKey(filing.ticker, filing.accessionNumber);
      const { blocks, document, ...meta } = prepared;
      await Promise.all([
        putJson(env.SEC_FILINGS, `${key}/meta.json`, meta),
        putJson(env.SEC_FILINGS, `${key}/text.json`, { document, blocks }),
        putJson(env.SEC_FILINGS, `${key}/history.json`, history),
      ]);
      return { key, filing, discoveryChunks: discoveryChunkCount(document.text.length) };
    },
    scanDisclosures: async (_filing, reference, index, execution) => {
      const prepared = await readPrepared(env.SEC_FILINGS, reference);
      let chunk: DiscoveryChunk;
      try { chunk = await scanDisclosureChunk(prepared, index, modelFor(execution)); }
      catch (error) {
        if (!execution?.finalAttempt) throw error;
        chunk = {index,start:0,end:0,status:"failed",disclosures:[],rejected:0};
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
    auditDisclosures: async (_filing, reference, plan, nodes, execution) => {
      const meta = await readMeta(env.SEC_FILINGS, reference);
      try {
        const tasks = await auditDisclosureCoverage(meta, plan, nodes, modelFor(execution));
        await putArtifact(env.SEC_FILINGS, reference, "discovery/audit", tasks);
        await putJson(env.SEC_FILINGS, `${reference.key}/meta.json`, meta);
        return tasks;
      } catch (error) {
        if (!execution?.finalAttempt) throw error;
        const warning = "The disclosure omission audit did not finish, so complete coverage of important items cannot be confirmed.";
        if (meta.discovery) meta.discovery.warnings.push(warning);
        meta.materialWarnings = [...(meta.materialWarnings ?? []), warning];
        await putJson(env.SEC_FILINGS, `${reference.key}/meta.json`, meta);
        return [];
      }
    },
    buildBrief: async (_filing, reference, context) => {
      const meta = await readMeta(env.SEC_FILINGS, reference);
      const history = context.history ?? await readHistory(env.SEC_FILINGS, reference);
      const brief = buildPreparedSecBrief(meta, context, history);
      await putArtifact(env.SEC_FILINGS, reference, "brief", brief);
      return brief;
    },
    plan: async (_filing, reference, brief, execution): Promise<SecNodePlan> => {
      const plan = await planPreparedSecFiling(await readMeta(env.SEC_FILINGS, reference), modelFor(execution), brief);
      await putArtifact(env.SEC_FILINGS, reference, "manager-plan", plan);
      return plan;
    },
    analyzeNode: async (spec: SecNodeSpec, _filing, reference, brief, round = 0, execution): Promise<SecNodeResult> => {
      const prepared = await readPrepared(env.SEC_FILINGS, reference);
      let result: SecNodeResult;
      try {
        result = await analyzePreparedSecNode(prepared, spec, modelFor(execution), brief);
      } catch (error) {
        // Rethrow so the Workflow step retries and escalates to the fallback model; only the
        // final attempt degrades to an error node so one flaky response cannot lose the filing.
        if (execution && !execution.finalAttempt) throw error;
        result = failedSecNode(spec, error);
      }
      await putArtifact(env.SEC_FILINGS, reference, `nodes/round-${round}/${spec.id}`, result);
      return result;
    },
    review: async (_filing, reference, brief, plan, nodes, round, execution): Promise<ManagerReview> => {
      const result = await reviewPreparedSecAnalysis(await readMeta(env.SEC_FILINGS, reference), brief, plan, nodes, round, modelFor(execution));
      await putArtifact(env.SEC_FILINGS, reference, `manager-review/round-${round}`, result);
      return result;
    },
    summarizeEvent: async (filing, reference, execution) => ({
      ...await summarizePreparedSecEvent(await readPrepared(env.SEC_FILINGS, reference), modelFor(execution), new Date(), await readHistory(env.SEC_FILINGS, reference)),
      ...(filing.earningsGroup ? { earningsGroup: filing.earningsGroup } : {}),
    }),
    summarize: async (_filing, reference, context, plan, nodes, brief, review, execution) => {
      await putArtifact(env.SEC_FILINGS, reference, "nodes/final", nodes);
      if (review) await putArtifact(env.SEC_FILINGS, reference, "manager-review/final", review);
      const checkpoint = draftCheckpoint(reference, 0);
      const result = await summarizePreparedSecFiling(await readMeta(env.SEC_FILINGS, reference), context, modelFor(execution), new Date(), plan, nodes, brief, review, undefined,
        { candidate: await checkpoint.load(), saveCandidate: checkpoint.saveCandidate, primaryEvidence: await primaryEvidence(reference, nodes) });
      if (!result.artifact.report.reader) throw new Error("Synthesis did not produce the required reader report");
      if (result.summary && _filing.earningsGroup) result.summary.earningsGroup = _filing.earningsGroup;
      const synthesisKey = await putArtifact(env.SEC_FILINGS, reference, "synthesis", result);
      return { ...result, artifact: { ...result.artifact, blocks: [], artifactKeys: collectArtifactKeys(reference, synthesisKey) } };
    },
    auditReport: async (reference, nodes, brief, result, round, execution, context) => {
      if (!result.artifact.report.reader || !result.summary) throw new Error("Publication requires a complete reader report");
      const marketSnapshot = await identifyReaderMarketSnapshot(result.artifact.filing.ticker, result.artifact.report.marketSnapshot);
      const audit = await modelFor(execution)(`editorial-review:${round}`, EDITORIAL_REVIEW_PROMPT, {
          headline: result.summary.headline, bullets: result.summary.bullets, analystView: result.summary.analystView,
          reader: result.artifact.report.reader, availableCharts: result.artifact.report.trends ?? [], availableFigures: figureCatalog(result.artifact.report.figures ?? []), financialLens: result.artifact.report.financialLens, marketSnapshot,
          facts: brief.currentFacts, comparisons: brief.comparisons, history: brief.history, historicalReports: brief.reportContinuity,
          nodes: nodes.map(({ id, title, facts, evidence, narrative, findings }) => ({ id, title, facts, evidence, narrative, findings })),
          limitations: result.artifact.report.dataQuality,
          requiredTopics: context ? editorialRequirements(context.plan, nodes, result.artifact.managerReview) : [],
          previousIssues: context?.previousIssues ?? [],
          primaryEvidence: context ? await primaryEvidence(reference, nodes) : [],
          renderedComponents: { cashBridge: result.artifact.report.financialLens?.cashBridge,
            standardFCFVisible: Boolean(result.artifact.report.financialLens?.cashBridge),
            adjustedFCFVisible: result.artifact.report.financialLens?.cashBridge?.adjustedFCF !== undefined,
            placement: "Only fields that actually exist are shown; when adjustedFCFVisible=false the page has no second FCF, and the text must not claim both are shown side by side" },
      });
      await putArtifact(env.SEC_FILINGS, reference, `editorial-review/${round}`, audit);
      const allowed = new Set([...brief.currentFacts.flatMap((f) => f.evidenceIds), ...nodes.flatMap((n) => n.evidenceIds ?? []), ...(marketSnapshot?.evidenceId ? [marketSnapshot.evidenceId] : [])]);
      const findings = normalizeEditorialIssues(audit, allowed);
      return { findings, issues: findings.filter((i) => i.severity !== "minor" && i.category !== "presentation").map((i) => `${i.id}: ${i.detail} Acceptance: ${i.acceptance}`), reviewedAt: new Date().toISOString() };
    },
    reviseReport: async (filing, reference, context, plan, nodes, brief, review, issues, execution, revision) => {
      if (!revision?.draft.summary || !revision.draft.artifact.report.reader) throw new Error("Editorial revision requires the reviewed draft");
      const checkpoint = draftCheckpoint(reference, revision.round);
      const saved = await checkpoint.load();
      const original = { ...revision.draft.summary, ...revision.draft.artifact.report, readerReport: revision.draft.artifact.report.reader, report: "" };
      const result = await summarizePreparedSecFiling(await readMeta(env.SEC_FILINGS, reference), context, modelFor(execution), new Date(), plan, nodes, brief, review, issues,
        { candidate: saved ?? original, patch: !saved, issues: revision.findings ?? issues, saveCandidate: checkpoint.saveCandidate, primaryEvidence: await primaryEvidence(reference, nodes) });
      if (!result.artifact.report.reader) throw new Error("Editorial revision did not produce a reader report");
      delete result.artifact.report.editorialReview;
      if (filing.earningsGroup) result.summary.earningsGroup = filing.earningsGroup;
      const key = await putArtifact(env.SEC_FILINGS, reference, `editorial/${encodeURIComponent(workflowInstanceId)}/round-${revision.round}/result`, result);
      result.artifact.artifactKeys = collectArtifactKeys(reference, key);
      return result;
    },
    composePresentation: async (filing, reference, report, nodes, brief, execution) => {
      const trends = buildSecTrends(brief, filing.filingDate, filing.reportDate);
      const usableNodes = nodes.filter((node) => node.status === "complete" && (node.narrative || node.findings.length));
      if (!usableNodes.length) return report;
      try {
        const candidate = await modelFor(execution)("presentation", "You are the editor of a company business research report. Design only the reading structure for the completed analysis; never generate facts, body text or data. Output exactly one JSON object following the schema, with density and sections at the top level. Cover every node in requiredNodeIds; a node without narrative uses findings and must not be left out. Do not repeat the same node's text as both narrative and callout. A chart directly follows the narrative/findings/callout of the same node. When an available trend relates directly to a business question, choose at least one chart that helps explain it; never let company-wide revenue stand in for segment or customer data. Use only the IDs and block types provided. Write section titles in plain, concise English.", {
          schema: SEC_PRESENTATION_SCHEMA,
          requiredNodeIds: usableNodes.map((node) => node.id),
          nodes: usableNodes.map((node) => ({
            nodeId: node.id, title: node.title, summary: node.narrative.slice(0, 500), findings: node.findings,
            allowedBlocks: [...(node.narrative ? ["narrative"] : []), ...(node.narrative || node.findings.length ? ["callout"] : []), ...(node.findings.length ? ["findings"] : []), ...(node.evidence.length ? ["evidence"] : []), ...(trends.length ? ["chart"] : [])],
          })),
          availableMetrics: report.keyMetrics.filter((metric) => metric.status === "verified" || metric.status === "derived").map((metric) => metric.metricKey),
          availableCharts: trends,
        });
        await putArtifact(env.SEC_FILINGS, reference, "presentation/candidate", candidate);
        const presentation = composeSecPresentation(candidate.presentation ?? candidate, usableNodes, report.keyMetrics, trends);
        if (!presentation) throw new Error("Presentation references or coverage failed validation");
        await putArtifact(env.SEC_FILINGS, reference, "presentation/resolved", presentation);
        return { ...report, presentation, dataQuality: { ...report.dataQuality, warnings: report.dataQuality.warnings.filter((warning) => warning !== PRESENTATION_FALLBACK_WARNING) } };
      } catch (error) {
        if (!execution?.finalAttempt) throw error;
        return { ...report, dataQuality: { ...report.dataQuality, warnings: [...new Set([...report.dataQuality.warnings, "Report layout retries did not finish; the complete standard report is kept."])] } };
      }
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

async function fetchCompanyHistory(cik: string, ticker: string, userAgent: string, fetcher: typeof fetch) {
  const normalizedCik = String(cik).replace(/\D/g, "").padStart(10, "0");
  const response = await fetcher(`https://data.sec.gov/api/xbrl/companyfacts/CIK${normalizedCik}.json`, {
    cache: "no-store",
    headers: { accept: "application/json", "user-agent": userAgent },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`SEC Company Facts HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 20_000_000) throw new Error("SEC Company Facts payload exceeds 20 MB");
  return normalizeCompanyFacts(ticker, await response.json());
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
  env: SecPipelineEnv, fetcher: typeof fetch, stage: string, system: string, payload: unknown,
  modelOverride?: string, executionBudgetMs = SEC_MODEL_EXECUTION_BUDGET_MS, jsonMode = true,
  tuning?: ModelCallTuning,
): Promise<Record<string, unknown>> {
  return parseModelJson(await requestWorkerSecModelContent(env, fetcher, stage, system, payload, modelOverride, executionBudgetMs, jsonMode, tuning));
}

/**
 * Per-call limits for narrow extraction stages, the AI tool's reasoning level, and the provider-reported usage when the
 * call ends. `ticker`, `runId` and `kind` only label the row in the `ai_usage` ledger; the kind is read from the stage
 * name when a caller leaves it out.
 */
export type ModelCallTuning = {
  maxTokens?: number; reasoning?: ReasoningEffort; onMetrics?: (metrics: Readonly<Record<string, unknown>>) => void;
  ticker?: string; runId?: string; kind?: string;
};

async function requestWorkerSecModelContent(
  env: SecPipelineEnv,
  fetcher: typeof fetch,
  stage: string,
  system: string,
  payload: unknown,
  modelOverride?: string,
  executionBudgetMs = SEC_MODEL_EXECUTION_BUDGET_MS,
  jsonMode = true,
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
  const client = modelClient(env, apiKey, executionBudgetMs, fetcher, metrics, () => { liveAt = Date.now(); });
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
  // Claude has no JSON response mode short of a schema; the system prompt asks for one object and `parseModelJson` holds it to that.
  void jsonMode;
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
      ...serverFallback(model),
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

/** One agent turn taken through client tools: the reply's content blocks as they are to be sent back, and why it stopped. */
export type ToolTurnReply = { content: ContentBlock[]; stopReason: string | null; refusalCategory: string | null };
type ContentBlock = { type: string } & Record<string, unknown>;
/** A tool turn's thinking plus its calls; an `add` of eight nodes with anchors and revenue entries fits well inside. */
const TOOL_TURN_TOKENS = 32_000;

/**
 * One turn of an agent loop that acts through client tools. Claude Sonnet 5.5 and Opus 5.5 refuse a forced `tool_choice`,
 * so the tools are strict (arguments always match their schema) and the prompt asks for a call. `messages` must only ever
 * grow: a thinking block stays valid only while the system prompt, the tools and every earlier turn are sent unchanged.
 * HTTP failures throw as in `callWorkerSecModel`; a broken or stalled stream throws `SecModelOutputError`; a refusal or a
 * reply cut off at the token limit comes back with its stop reason, for the loop to decide.
 */
export async function callWorkerToolModel(
  env: SecPipelineEnv, fetcher: typeof fetch, stage: string,
  request: { system: string; tools: Anthropic.Beta.BetaTool[]; messages: Anthropic.Beta.BetaMessageParam[] },
  modelOverride?: string, executionBudgetMs = SEC_MODEL_EXECUTION_BUDGET_MS, tuning?: ModelCallTuning,
): Promise<ToolTurnReply> {
  const apiKey = await resolveWorkerModelKey(env, fetcher);
  const started = Date.now();
  const model = modelOverride || env.SEC_ANALYSIS_MODEL || SEC_FALLBACK_MODEL;
  const maxTokens = tuning?.maxTokens ?? TOOL_TURN_TOKENS;
  const metrics: Record<string, unknown> = { stage, model, inputCharacters: JSON.stringify(request.messages).length, maxTokens, reasoning: tuning?.reasoning ?? "high", mode: "tool-turn" };
  const controller = new AbortController();
  let timeoutKind = "execution-budget", liveAt = Date.now();
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const budgetTimer = setTimeout(() => { timeoutKind = "execution-budget"; controller.abort(); }, executionBudgetMs);
  const firstTimer = setTimeout(() => { timeoutKind = "first-response"; controller.abort(); }, SEC_MODEL_FIRST_RESPONSE_MS);
  const client = modelClient(env, apiKey, executionBudgetMs, fetcher, metrics, () => { liveAt = Date.now(); }, () => {
    // Headers are in: from here a connection silent for the stall window, pings included, has stalled.
    clearTimeout(firstTimer);
    metrics.headersMs ??= Date.now() - started;
    watchdog ??= setInterval(() => { if (Date.now() - liveAt >= SEC_MODEL_STALL_MS) { timeoutKind = "stream-stall"; controller.abort(); } }, 1_000);
  });
  try {
    const message = await client.beta.messages.stream({
      model,
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      tools: request.tools,
      messages: request.messages,
      // The exchange is cached up to its newest turn, so each turn reads every earlier one from the cache.
      cache_control: { type: "ephemeral" },
      output_config: { effort: tuning?.reasoning ?? "high" },
      max_tokens: maxTokens,
      ...serverFallback(model),
    }, { signal: controller.signal }).finalMessage();
    const refusalCategory = typeof message.stop_details?.category === "string" ? message.stop_details.category : null;
    Object.assign(metrics, { servedModel: message.model, usage: message.usage, finishReason: message.stop_reason, refusalCategory, outputCharacters: JSON.stringify(message.content).length });
    const fallbacks = message.content.filter(b => b.type === "fallback").length;
    if (fallbacks) metrics.fallbacks = fallbacks;
    return { content: echoable(JSON.parse(JSON.stringify(message.content)) as ContentBlock[]), stopReason: message.stop_reason, refusalCategory };
  } catch (error) {
    if (controller.signal.aborted) {
      metrics.error = `model-timeout:${timeoutKind}`;
      if (timeoutKind === "stream-stall") throw new SecModelOutputError("stream_stall", `Model ${stage} stream stalled: no bytes for ${SEC_MODEL_STALL_MS / 1000}s`);
      throw new Error(`model-timeout:${timeoutKind} stage=${stage} elapsedMs=${Date.now() - started}`);
    }
    if (error instanceof Anthropic.APIError && error.status !== undefined) {
      const failure = httpFailure(error, model, stage, apiKey);
      Object.assign(metrics, { error: `http:${error.status}`, providerCode: failure.providerCode });
      throw failure;
    }
    // An error event inside the stream (overloaded mid-reply) or a dropped connection: this turn has no reply.
    metrics.error = "stream_incomplete";
    throw new SecModelOutputError("stream_incomplete", `Model ${stage} stream interrupted: ${error instanceof Error ? error.message.replaceAll(apiKey, "[redacted]").slice(0, 300) : "transport error"}`);
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(budgetTimer);
    clearInterval(watchdog);
    await recordModelCall(env, metrics, started, tuning ?? {});
  }
}

/**
 * The reply as it may go back: after a fallback mid-reply, the declined model's thinking and tool calls before the last
 * switch point are not the served reply and cannot be echoed; its text, and everything after the switch, can.
 */
function echoable(content: ContentBlock[]): ContentBlock[] {
  const boundary = content.findLastIndex(b => b.type === "fallback");
  return boundary < 0 ? content : content.filter((b, i) => i > boundary || b.type === "text");
}

/** The client every model call uses: the workspace header, no SDK retries, and a body watcher for liveness. */
function modelClient(env: SecPipelineEnv, apiKey: string, timeout: number, fetcher: typeof fetch, metrics: Record<string, unknown>, onBytes: () => void, onHeaders?: () => void): Anthropic {
  return new Anthropic({
    apiKey, maxRetries: 0, timeout, defaultHeaders: anthropicWorkspaceHeaders(env.ANTHROPIC_WORKSPACE_ID),
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

/** A safety-classifier decline is re-run on Anthropic's recommended model inside the same call. */
function serverFallback(model: string) {
  return SERVER_FALLBACK_MODELS.test(model) ? { fallbacks: "default" as const, betas: ["server-side-fallback-2026-07-01"] } : {};
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
async function recordModelCall(env: SecPipelineEnv, metrics: Record<string, unknown>, started: number, tuning: Pick<ModelCallTuning, "onMetrics" | "ticker" | "runId" | "kind">): Promise<void> {
  console.log(JSON.stringify({ event: "sec-model-request", ...metrics, elapsedMs: Date.now() - started }));
  try { tuning.onMetrics?.(metrics); } catch { /* Usage accounting never fails a model call. */ }
  await recordAiUsage(env, aiUsageFromMetrics(metrics, {
    at: new Date(started).toISOString(), durationMs: Date.now() - started, provider: "anthropic",
    ticker: tuning.ticker, kind: tuning.kind, runId: tuning.runId,
  }));
}

/** The models that accept server-side `fallbacks` on the Claude API; Haiku has none. */
const SERVER_FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

/** `anthropic-workspace-id` when a workspace is configured; an API key that is not scoped to one is refused without it. */
export function anthropicWorkspaceHeaders(workspaceId: string | undefined): Record<string, string> {
  const id = workspaceId?.trim();
  return id ? { "anthropic-workspace-id": id } : {};
}

export async function resolveWorkerModelKey(env: SecPipelineEnv, fetcher: typeof fetch = fetch): Promise<string> {
  void fetcher;
  if (!env.ANTHROPIC_API_KEY) throw new Error("SEC pipeline ANTHROPIC_API_KEY is not configured");
  return env.ANTHROPIC_API_KEY;
}
