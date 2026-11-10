import Anthropic from "@anthropic-ai/sdk";
import { type ReasoningEffort } from "./ai-config.ts";
import { aiUsageFromMetrics, recordAiUsage } from "./ai-runs/usage.ts";
import { readModelContent, parseModelJson, SecModelOutputError } from "./model-stream.ts";
import { SecModelHttpError, type ModelRequestOptions } from "./model-recovery.ts";
export { readModelContent } from "./model-stream.ts";
export { SecModelHttpError } from "./model-recovery.ts";
import { fiscalPeriodKey, fiscalPeriodsFromCompanyFacts } from "./sec/fiscal-period.ts";
import { fiscalPeriodsInSequence } from "./sec/fiscal-sequence.ts";
import {
  discoverSecTicker,
} from "./sec/pipeline.ts";
import { D1SecRepository } from "./sec/d1.ts";
import { cleanSecTicker, type SecFiling, type SecFilingFeed } from "./sec/sec.ts";
import { normalizeCompanyFacts } from "./sec/history.ts";
import { edgarListings, type EdgarListings } from "./sec-archive/index.ts";
import { secFundamentalsKey } from "./fundamentals/sec-fundamentals.ts";
import { assertTrackedTicker, requireDb, type SecCronEnv } from "./core.ts";
import type { AnalysisReadEnv } from "./read-api/router.ts";
import type { EventMessage, TaskMessage } from "./pipeline/messages.ts";
import { outboxStatement } from "./pipeline/outbox.ts";
import { SEC_MODEL_EXECUTION_BUDGET_MS, SEC_MODEL_FIRST_RESPONSE_MS, SEC_MODEL_OUTPUT_TOKENS, SEC_FALLBACK_MODEL } from "./retry-policy.ts";
import type { AnalysisOperations, WorkflowJobUpdate } from "./workflow-core.ts";
import type { MarkdownConverter } from "./web-search/page.ts";

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
  FINDINGS_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  ANALYST_WORKFLOW?: AiWorkflowBinding<{ ticker: string; fingerprint: string }>;
  ANALYST_ENABLED?: string;
  ANALYST_DAILY_TURNS?: string;
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
  /** "false" turns off the IR-site deck search fallback. */
  /** Alpha Vantage key for earnings-call transcripts; optional. */
  ALPHA_VANTAGE_API_KEY?: string;
  TRANSCRIPTS_ENABLED?: string;
  /** Shared daily transcript request budget; defaults to the free tier's 25 requests. */
  TRANSCRIPT_DAILY_CALLS?: string;
  SEC_FILINGS: R2BucketLike;
  SEC_USER_AGENT: string;
  /** Every model call and web search goes to DeepSeek's Anthropic-format API with this key. */
  DEEPSEEK_API_KEY?: string;
  /** Anthropic's API, for the artifact arbiter and visual review (artifact/anthropic.ts). */
  ANTHROPIC_API_KEY?: string;
  /** The business map's public origin, where the visual review loads an artifact draft in the real stage. */
  BUSINESS_SITE_ORIGIN?: string;
  /** Signs artifact preview links; the admin password's secret doubles as the key material. */
  REPORT_ADMIN_PASSWORD?: string;
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

export function createAnalysisOperations(env: AnalysisEnv, fetcher: typeof fetch = fetch, workflowInstanceId = "standalone"): AnalysisOperations {
  const repository = () => new D1SecRepository(requireDb(env));
  // EDGAR is read for listings only; every filing's text comes from the archive (docs/sec-archive.md).
  const listings = (): EdgarListings => edgarListings(env, { fetcher });
  const archive = () => ({ DB: requireDb(env), SEC_FILINGS: env.SEC_FILINGS, SEC_USER_AGENT: env.SEC_USER_AGENT });
  return {
    loadFiling: async (ticker, accession) => {
      assertTrackedTicker(env, ticker);
      const saved = await repository().getPublicFiling(ticker, accession);
      if (!saved) return null;
      // Publication snapshots must carry source identity, never nest the old analysis recursively.
      return { ticker: saved.ticker, cik: saved.cik, cikNumber: saved.cikNumber, companyName: saved.companyName,
        form: saved.form, filingDate: saved.filingDate, reportDate: saved.reportDate, accessionNumber: saved.accessionNumber,
        primaryDocument: saved.primaryDocument, description: saved.description, items: saved.items,
        documentUrl: saved.documentUrl, indexUrl: saved.indexUrl };
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
      // The indexed list, the fiscal periods and their event commit together.
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

function toStoredFiling(filing: SecFilingFeed["filings"][number]): SecFiling {
  return {
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
