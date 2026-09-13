import { buildEarningsGroups, classificationKey, combineEarningsDocuments, earningsKey, identifyEarningsPeriod, isPeriodic } from "./sec/earnings.ts";
import type { SecEarningsGroup } from "../../../shared/analysis-contract/report.ts";
import { buildSecOutline } from "./sec/report.ts";
import {
  analyzePreparedSecNode,
  buildPreparedSecBrief,
  failedSecNode,
  discoverSecTicker,
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
import { D1SecRepository } from "./sec/d1.ts";
import type { SecAnalysisArtifact } from "./sec/types.ts";
import { cleanSecAccession, cleanSecTicker, type SecFiling, type SecFilingFeed, type SecFilingSummary, type SecNodePlan, type SecNodeResult, type SecNodeSpec } from "./sec/sec.ts";
import { SEC_ANALYSIS_SCHEMA_VERSION, type FilingBlock, type ManagerReview, type SecHistorySnapshot } from "./sec/analysis.ts";
import { normalizeCompanyFacts } from "./sec/history.ts";
import { assertTrackedTicker, requireDb, type SecCronEnv } from "./core.ts";
import type { AnalysisReadEnv } from "./read-api/router.ts";
import type { SecModelExecution } from "./retry-policy.ts";
import type { PreparedFilingReference, SecPipelineOperations, WorkflowJobUpdate } from "./workflow-core.ts";
import { jobAnalysisVersionFor } from "./workflow-core.ts";

type R2ObjectLike = { text(): Promise<string> };
type R2BucketLike = {
  get(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
};

export type SecPipelineEnv = SecCronEnv & AnalysisReadEnv & {
  SEC_FILINGS: R2BucketLike;
  SEC_USER_AGENT: string;
  AI_API_KEY?: string;
  SEC_ANALYSIS_MODEL?: string;
  /** Optional stronger model for planning, review and synthesis. Unset means one model everywhere. */
  SEC_REASONING_MODEL?: string;
};

const PUBLISH_BLOCK_CHUNK_SIZE = 40;

/** Planning, review and synthesis carry the judgement; node extraction is mechanical. */
const REASONING_STAGE = /^(manager|synthesis)/;

export function modelForStage(env: SecPipelineEnv, stage: string, override?: string): string | undefined {
  if (override) return override;
  return REASONING_STAGE.test(stage) ? env.SEC_REASONING_MODEL || undefined : undefined;
}

export function createSecPipelineOperations(env: SecPipelineEnv, fetcher: typeof fetch = fetch): SecPipelineOperations {
  const repository = () => new D1SecRepository(requireDb(env));
  const modelFor = (execution?: SecModelExecution): SecModelCall => async (stage, system, payload) => {
    // Keep an in-step recovery below the Workflow's five-minute deadline.
    const deadline = Date.now() + 240_000;
    const requestBudget = REASONING_STAGE.test(stage) ? 240_000 : 180_000;
    const call = (nextStage: string, nextSystem: string, model?: string) =>
      callWorkerSecModel(env, fetcher, nextStage, nextSystem, payload, model, Math.max(1, Math.min(requestBudget, deadline - Date.now())));
    const selectedModel = modelForStage(env, stage, execution?.model);
    try {
      return await call(stage, system, selectedModel);
    } catch (error) {
      const primaryModel = env.SEC_ANALYSIS_MODEL || "glm-5.3-flash";
      // A shared fallback-provider rate limit must not trap every remaining attempt on that model.
      if (error instanceof SecModelHttpError && error.status === 429 && selectedModel && selectedModel !== primaryModel) {
        return call(`${stage}:rate-limit-recovery`, system, primaryModel);
      }
      if (!(error instanceof SyntaxError) && !String(error).includes("JSON object")) throw error;
      return call(`${stage}:schema-retry`, `${system}\nYour previous response violated the JSON schema. Return one valid JSON object only.`, selectedModel);
    }
  };
  return {
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
      if (!ticker) throw new Error("SEC 索引数据无效。");
      assertTrackedTicker(env, ticker);
      const normalizedFeed = { ...typedFeed, ticker, filings: typedFeed.filings.map(toStoredFiling) };
      const store = repository();
      await store.setCache(`sec:filings:${ticker}`, normalizedFeed, typedFeed.fetchedAt ?? new Date().toISOString());
      await Promise.all(normalizedFeed.filings.map((filing) => store.upsertFilingIndex(filing)));
    },
    shouldAnalyze: async (filing, requestedBy) => {
      if (requestedBy === "manual") return true;
      const ticker = cleanSecTicker(filing.ticker);
      if (!ticker) throw new Error("SEC 任务查询无效。");
      assertTrackedTicker(env, ticker);
      if (filing.earningsGroup) {
        const summary = await repository().getSummary(ticker, filing.accessionNumber);
        if (summary?.earningsGroup?.inputKey !== filing.earningsGroup.inputKey) {
          const active = await repository().getAnalysisJobStatus(ticker, filing.accessionNumber, jobAnalysisVersionFor(filing.form));
          return active !== "running" && active !== "queued";
        }
      }
      const status = await repository().getAnalysisJobStatus(ticker, filing.accessionNumber, jobAnalysisVersionFor(filing.form));
      return status === null || status === "failed";
    },
    getContext: async (filing, reference) => {
      const history = reference ? await readHistory(env.SEC_FILINGS, reference) : EMPTY_HISTORY;
      const ticker = cleanSecTicker(filing.ticker);
      if (!ticker || !filing.accessionNumber) throw new Error("SEC filing 无效。");
      assertTrackedTicker(env, ticker);
      const normalizedFiling = { ...filing, ticker };
      const store = repository();
      await store.saveHistory(normalizedFiling, history);
      const context = await store.getAnalysisContext(normalizedFiling);
      return { ...context, history: context.history ?? history };
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
      const history = await fetchCompanyHistory(filing.cik, filing.ticker, env.SEC_USER_AGENT, fetcher).catch(() => EMPTY_HISTORY);
      const key = preparedKey(filing.ticker, filing.accessionNumber);
      const { blocks, document, ...meta } = prepared;
      await Promise.all([
        putJson(env.SEC_FILINGS, `${key}/meta.json`, meta),
        putJson(env.SEC_FILINGS, `${key}/text.json`, { document, blocks }),
        putJson(env.SEC_FILINGS, `${key}/history.json`, history),
      ]);
      return { key, filing };
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
      const result = await summarizePreparedSecFiling(await readMeta(env.SEC_FILINGS, reference), context, modelFor(execution), new Date(), plan, nodes, brief, review);
      if (result.summary && _filing.earningsGroup) result.summary.earningsGroup = _filing.earningsGroup;
      const synthesisKey = await putArtifact(env.SEC_FILINGS, reference, "synthesis", result);
      return { ...result, artifact: { ...result.artifact, blocks: [], artifactKeys: collectArtifactKeys(reference, synthesisKey) } };
    },
    composePresentation: async (filing, reference, report, nodes, brief, execution) => {
      const trends = buildSecTrends(brief, filing.filingDate, filing.reportDate);
      const usableNodes = nodes.filter((node) => node.status === "complete" && (node.narrative || node.findings.length));
      if (!usableNodes.length) return report;
      try {
        const candidate = await modelFor(execution)("presentation", "你是公司业务研究报告的编辑。只为已完成的分析设计阅读结构，不生成事实、正文或数据。严格按 schema 输出一个 JSON 对象，顶层为 density 和 sections。必须覆盖 requiredNodeIds 中每个节点；没有 narrative 的节点使用 findings，不能遗漏。不要同时用 narrative 和 callout 重复同一节点正文。chart 紧跟同一节点的 narrative/findings/callout。可用趋势与业务问题直接相关时，应选择至少一张辅助解释的图表；不以全公司收入替代分部或客户数据。只使用提供的 ID 和可用块类型。", {
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
        return { ...report, presentation, dataQuality: { ...report.dataQuality, warnings: report.dataQuality.warnings.filter((warning) => warning !== "模型报告编排未通过校验，已保留完整标准报告。") } };
      } catch (error) {
        if (!execution?.finalAttempt) throw error;
        return { ...report, dataQuality: { ...report.dataQuality, warnings: [...new Set([...report.dataQuality.warnings, "报告编排重试未完成，已保留完整标准报告。"])] } };
      }
    },
    publish: async (artifact, summary) => {
      const reference = { key: preparedKey(artifact.filing.ticker, artifact.filing.accessionNumber), filing: artifact.filing };
      const prepared = await readPrepared(env.SEC_FILINGS, reference);
      const citedBlockIds = collectReferencedBlockIds(artifact);
      const citedBlocks = prepared.blocks.filter((block) => citedBlockIds.has(block.blockId));
      const ticker = cleanSecTicker(artifact.filing.ticker);
      const accessionNumber = cleanSecAccession(artifact.filing.accessionNumber);
      if (!accessionNumber || !ticker) throw new Error("SEC 分析结果无效。");
      assertTrackedTicker(env, ticker);
      const store = repository();
      if (artifact.filing.earningsGroup) {
        const latest = await store.getCache<SecEarningsGroup>(earningsKey(ticker, accessionNumber));
        if (latest?.payload.inputKey !== artifact.filing.earningsGroup.inputKey) throw new Error("Earnings sources changed during analysis; retry with the current group");
      }
      const normalizedFiling = { ...artifact.filing, ticker, accessionNumber };
      for (const blocks of chunks(citedBlocks, PUBLISH_BLOCK_CHUNK_SIZE)) {
        await store.saveFilingBlocks(normalizedFiling, blocks);
      }
      const normalizedArtifact = { ...artifact, filing: normalizedFiling };
      await store.saveAnalysis(normalizedArtifact, false);
      if (artifact.report.dataQuality.verificationStatus === "failed") return {};
      if (!summary) throw new Error("SEC 最终发布缺少报告摘要。");
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
        && summary.source === "deepseek"
        && summary.ticker === eventTicker
        && summary.form === identity.form
        && summary.accessionNumber === eventAccession;
      if (!validEvent) throw new Error("SEC 事件简析无效。");
      assertTrackedTicker(env, eventTicker);
      await repository().setSummary(
        { ticker: eventTicker, accessionNumber: eventAccession, form: identity.form },
        { ...summary, ticker: eventTicker, accessionNumber: eventAccession },
      );
    },
    updateJob: async (job: WorkflowJobUpdate) => {
      const ticker = cleanSecTicker(job.ticker);
      if (!ticker || !job.jobId || !job.accessionNumber) throw new Error("SEC 任务状态无效。");
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

function collectReferencedBlockIds(artifact: SecAnalysisArtifact): Set<string> {
  const blockIds = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "evidenceIds" && Array.isArray(child)) {
        child.forEach((evidenceId) => {
          if (typeof evidenceId === "string" && evidenceId.startsWith("ev:")) blockIds.add(evidenceId.slice(3));
        });
      } else {
        visit(child);
      }
    }
  };
  visit(artifact);
  return blockIds;
}

function summaryIdentity(summary: SecFilingSummary) {
  return {
    ticker: summary.ticker,
    form: summary.form,
    filingDate: summary.filingDate,
    accessionNumber: summary.accessionNumber,
  };
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
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

class SecModelHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function callWorkerSecModel(
  env: SecPipelineEnv,
  fetcher: typeof fetch,
  stage: string,
  system: string,
  payload: unknown,
  modelOverride?: string,
  timeoutMs = 180_000,
): Promise<Record<string, unknown>> {
  const apiKey = await resolveWorkerModelKey(env, fetcher);
  const response = await fetcher("https://api.b.ai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelOverride || env.SEC_ANALYSIS_MODEL || "glm-5.3-flash",
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      // Streaming keeps bytes flowing so the provider's proxy cannot time the request out at ~100s.
      stream: true,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new SecModelHttpError(response.status, `DeepSeek ${stage} HTTP ${response.status}: ${detail.slice(0, 300)}`);
  }
  return parseModelJson(await readModelContent(response, stage));
}

/**
 * Assembles the assistant message from an SSE stream, falling back to a whole-body completion for
 * gateways that ignore `stream: true`. Throws before parsing when the stream ends early, because a
 * truncated JSON body can still parse into a plausible but wrong object.
 */
export async function readModelContent(response: Response, stage: string): Promise<string> {
  const raw = await response.text();
  const lines = raw.split(/\r?\n/);
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (!dataLines.length) return nonStreamedContent(raw, stage);

  let content = "";
  let finishReason: string | null = null;
  let done = false;
  for (const line of dataLines) {
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const error = chunk.error;
    if (error) throw new Error(`DeepSeek ${stage} stream error: ${JSON.stringify(error).slice(0, 300)}`);
    const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) continue;
    const delta = choice.delta as { content?: unknown } | undefined;
    if (typeof delta?.content === "string") content += delta.content;
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
  }

  if (!done && !finishReason) {
    throw new Error(`DeepSeek ${stage} stream ended before completion after ${content.length} characters`);
  }
  if (finishReason === "length") {
    throw new Error(`DeepSeek ${stage} stream hit the output token limit after ${content.length} characters`);
  }
  if (!content) throw new Error(`DeepSeek ${stage} returned empty content`);
  return content;
}

function nonStreamedContent(raw: string, stage: string): string {
  let data: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    throw new Error(`DeepSeek ${stage} returned neither an event stream nor JSON: ${raw.slice(0, 200)}`);
  }
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content) throw new Error(`DeepSeek ${stage} returned empty content`);
  return content;
}

export async function resolveWorkerModelKey(env: SecPipelineEnv, fetcher: typeof fetch = fetch): Promise<string> {
  void fetcher;
  if (!env.AI_API_KEY) throw new Error("SEC pipeline AI_API_KEY is not configured");
  return env.AI_API_KEY;
}

function parseModelJson(content: string): Record<string, unknown> {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? content;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("DeepSeek did not return a JSON object");
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
}
