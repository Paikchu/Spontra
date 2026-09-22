import { boundedModelIO } from "./model-io.ts";
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
import { secFundamentalsKey } from "./fundamentals/sec-fundamentals.ts";
import { assertTrackedTicker, requireDb, type SecCronEnv } from "./core.ts";
import type { AnalysisReadEnv } from "./read-api/router.ts";
import { SEC_MODEL_EXECUTION_BUDGET_MS, SEC_MODEL_FIRST_RESPONSE_MS, SEC_MODEL_OUTPUT_TOKENS, type SecModelExecution } from "./retry-policy.ts";
import type { PreparedFilingReference, SecPipelineOperations, WorkflowJobUpdate } from "./workflow-core.ts";
import { jobAnalysisVersionFor } from "./workflow-core.ts";

type R2ObjectLike = { etag?: string; text(): Promise<string> };
type R2BucketLike = {
  get(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string }; onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }): Promise<unknown>;
};

export type SecPipelineEnv = SecCronEnv & AnalysisReadEnv & {
  SEC_FILINGS: R2BucketLike;
  SEC_USER_AGENT: string;
  DEEPSEEK_API_KEY?: string;
  SEC_ANALYSIS_MODEL?: string;
  /** Optional stronger model for planning, review and synthesis. Unset means one model everywhere. */
  SEC_REASONING_MODEL?: string;
};

const PUBLISH_BLOCK_CHUNK_SIZE = 40;

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
      const selectedModel = modelForStage(env, stage, execution?.model) || env.SEC_ANALYSIS_MODEL || "deepseek-flash";
      const fallbackModel = "deepseek-flash";
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
          Math.max(1, deadline - Date.now()), options.jsonMode, { ...options, workflowInstanceId }),
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
      if (!ticker) throw new Error("SEC 索引数据无效。");
      assertTrackedTicker(env, ticker);
      const normalizedFeed = { ...typedFeed, ticker, filings: typedFeed.filings.map(toStoredFiling) };
      const store = repository();
      await store.setCache(`sec:filings:${ticker}`, normalizedFeed, typedFeed.fetchedAt ?? new Date().toISOString());
      await Promise.all(normalizedFeed.filings.map((filing) => store.upsertFilingIndex(filing)));
      await refreshFiscalPeriods(store, normalizedFeed.filings, env.SEC_USER_AGENT, fetcher);
      // Retry on every discovery sweep: Company Facts can arrive after the filing index.
      // Publish one complete snapshot atomically; failures leave the last good snapshot intact.
      const cik = normalizedFeed.company?.cik ?? normalizedFeed.filings[0]?.cik;
      if (cik) {
        try {
          const history = await fetchCompanyHistory(cik, ticker, env.SEC_USER_AGENT, fetcher);
          if (history.series.some((series) => series.seriesId === "revenue" && series.quarters.length)) {
            await store.setCache(secFundamentalsKey(ticker), history, new Date().toISOString());
          }
        } catch (error) {
          console.warn("SEC fundamentals refresh failed", { ticker, error: error instanceof Error ? error.message : String(error) });
        }
      }
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
      if (status === "complete") {
        const summary = await repository().getSummary(ticker, filing.accessionNumber);
        return summary?.discovery?.version !== "sec-discovery.v1";
      }
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
        const warning = "披露遗漏审校未完成，不能确认重要事项已完整覆盖。";
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
          reader: result.artifact.report.reader, availableCharts: result.artifact.report.trends ?? [], financialLens: result.artifact.report.financialLens, marketSnapshot,
          facts: brief.currentFacts, comparisons: brief.comparisons, history: brief.history, historicalReports: brief.reportContinuity,
          nodes: nodes.map(({ id, title, facts, evidence, narrative, findings }) => ({ id, title, facts, evidence, narrative, findings })),
          limitations: result.artifact.report.dataQuality,
          requiredTopics: context ? editorialRequirements(context.plan, nodes, result.artifact.managerReview) : [],
          previousIssues: context?.previousIssues ?? [],
          primaryEvidence: context ? await primaryEvidence(reference, nodes) : [],
          renderedComponents: { cashBridge: result.artifact.report.financialLens?.cashBridge,
            standardFCFVisible: Boolean(result.artifact.report.financialLens?.cashBridge),
            adjustedFCFVisible: result.artifact.report.financialLens?.cashBridge?.adjustedFCF !== undefined,
            placement: "只展示实际存在的字段；adjustedFCFVisible=false时页面没有第二种FCF，禁止声称已并列展示" },
      });
      await putArtifact(env.SEC_FILINGS, reference, `editorial-review/${round}`, audit);
      const allowed = new Set([...brief.currentFacts.flatMap((f) => f.evidenceIds), ...nodes.flatMap((n) => n.evidenceIds ?? []), ...(marketSnapshot?.evidenceId ? [marketSnapshot.evidenceId] : [])]);
      const findings = normalizeEditorialIssues(audit, allowed);
      return { findings, issues: findings.filter((i) => i.severity !== "minor" && i.category !== "presentation").map((i) => `${i.id}: ${i.detail} 通过条件：${i.acceptance}`), reviewedAt: new Date().toISOString() };
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
      if (artifact.report.reader && artifact.report.editorialReview?.status !== "passed") throw new Error("Reader report has not passed editorial review");
      const reference = { key: preparedKey(artifact.filing.ticker, artifact.filing.accessionNumber), filing: artifact.filing };
      if (artifact.report.reader) await putArtifact(env.SEC_FILINGS, reference, "synthesis", { artifact, summary });
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

export async function callWorkerSecModel(
  env: SecPipelineEnv, fetcher: typeof fetch, stage: string, system: string, payload: unknown,
  modelOverride?: string, executionBudgetMs = SEC_MODEL_EXECUTION_BUDGET_MS, jsonMode = true,
): Promise<Record<string, unknown>> {
  return parseModelJson(await requestWorkerSecModelContent(env, fetcher, stage, system, payload, modelOverride, executionBudgetMs, jsonMode));
}

async function requestWorkerSecModelContent(
  env: SecPipelineEnv,
  fetcher: typeof fetch,
  stage: string,
  system: string,
  payload: unknown,
  modelOverride?: string,
  executionBudgetMs = SEC_MODEL_EXECUTION_BUDGET_MS,
  jsonMode = true,
  options?: ModelRequestOptions,
): Promise<string> {
  const apiKey = await resolveWorkerModelKey(env, fetcher);
  const started = Date.now();
  const controller = new AbortController();
  let timeoutKind = "execution-budget";
  const budgetTimer = setTimeout(() => { timeoutKind = "execution-budget"; controller.abort(); }, executionBudgetMs);
  const firstTimer = setTimeout(() => { timeoutKind = "first-response"; controller.abort(); }, SEC_MODEL_FIRST_RESPONSE_MS);
  const metrics: Record<string, unknown> = { stage, model: modelOverride || env.SEC_ANALYSIS_MODEL || "deepseek-flash", inputCharacters: JSON.stringify(payload).length };
  if (options?.workflowInstanceId) metrics.workflowInstanceId = options.workflowInstanceId;
  try {
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: `${system}\nReturn one valid JSON object only.` },
    { role: "user", content: JSON.stringify(payload) },
  ];
  if (options?.continuation) messages.push(
    { role: "assistant", content: options.continuation },
    { role: "user", content: "The response was interrupted. Continue this exact JSON at the next character, including inside an unfinished string. Output only the missing suffix: no prefix repetition, no markdown. Preserve all completed content and evidence references. Finish the entire required object." },
  );
  if (options?.repair) messages.push(
    { role: "assistant", content: options.repair },
    { role: "user", content: "Repair the previous response into one complete JSON object matching the original schema. Preserve its substantive analysis and evidence; fix syntax and complete missing fields from the original inputs. Do not replace the report with a summary. Output the complete repaired object only." },
  );
  metrics.maxTokens = options?.maxTokens ?? SEC_MODEL_OUTPUT_TOKENS;
  metrics.mode = options?.continuation ? "continuation" : options?.repair ? "repair" : "initial";
  const response = await fetcher("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelOverride || env.SEC_ANALYSIS_MODEL || "deepseek-flash",
      messages,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      reasoning_effort: "high",
      max_tokens: options?.maxTokens ?? SEC_MODEL_OUTPUT_TOKENS,
      stream_options: { include_usage: true },
      // Streaming keeps bytes flowing so the provider's proxy cannot time the request out at ~100s.
      stream: true,
    }),
    signal: controller.signal,
  });
  clearTimeout(firstTimer);
  metrics.headersMs = Date.now() - started;
  if (!response.ok) {
    const errorReader = response.body?.getReader();
    let detail = "";
    if (errorReader) {
      try {
        const first = await boundedModelIO(errorReader.read(), "http-error-body", 5000);
        detail = first.value ? new TextDecoder().decode(first.value.slice(0, 4096)) : "";
      } catch { detail = "Error response body unavailable"; }
      void errorReader.cancel().catch(() => {});
      errorReader.releaseLock();
    }
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())) : 0;
    let providerCode: string | undefined;
    try {
      const error = JSON.parse(detail)?.error;
      const code = error?.code || error?.type;
      if (typeof code === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(code)) providerCode = code;
    } catch { /* A non-JSON provider response still retains its HTTP status. */ }
    metrics.providerCode = providerCode;
    throw new SecModelHttpError(response.status, `Model ${metrics.model} ${stage} HTTP ${response.status}: ${detail.replaceAll(apiKey, "[redacted]").slice(0, 1000)}`, retryAfterMs, providerCode);
  }
  return await readModelContent(response, stage, () => {
    metrics.firstTokenMs ??= Date.now() - started;
    metrics.lastTokenMs = Date.now() - started;
  }, metrics, undefined, { signal: controller.signal, checkpoint: options?.checkpoint, heartbeat: options?.heartbeat });
  } catch (error) {
    metrics.error = controller.signal.aborted ? `model-timeout:${timeoutKind}` : error instanceof SecModelHttpError ? `http:${error.status}` : error instanceof SecModelOutputError ? error.code : error instanceof Error ? error.name : "unknown";
    if (controller.signal.aborted) throw new Error(`model-timeout:${timeoutKind} stage=${stage} elapsedMs=${Date.now() - started}`);
    throw error;
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(budgetTimer);
    console.log(JSON.stringify({ event: "sec-model-request", ...metrics, elapsedMs: Date.now() - started }));
  }
}

export async function resolveWorkerModelKey(env: SecPipelineEnv, fetcher: typeof fetch = fetch): Promise<string> {
  void fetcher;
  if (!env.DEEPSEEK_API_KEY) throw new Error("SEC pipeline DEEPSEEK_API_KEY is not configured");
  return env.DEEPSEEK_API_KEY;
}
