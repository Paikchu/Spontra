import { D1SecRepository } from "./sec/d1.ts";
import { hashString } from "./sec/analysis.ts";
import { normalizeMemoryExtraction } from "./sec/memory.ts";
import { assertTrackedTicker, requireDb, trackedTickersFor, type SecMemoryWorkflowParams } from "./core.ts";
import { callWorkerSecModel, type SecPipelineEnv } from "./operations.ts";
import { modelExecutionForAttempt, SEC_MEMORY_MODEL_LEASE_MS } from "./retry-policy.ts";
import type { WorkflowStepLike } from "./workflow-core.ts";

export async function executeSecMemoryWorkflow(
  params: SecMemoryWorkflowParams,
  workflowInstanceId: string,
  step: WorkflowStepLike,
  env: SecPipelineEnv,
  fetcher: typeof fetch = fetch,
) {
  const ownerToken = params.ownerToken || `${workflowInstanceId}:${crypto.randomUUID()}`;
  const repository = new D1SecRepository(requireDb(env));
  const claim = await step.do(`memory-claim:${params.jobId}`, () => repository.claimMemoryJob(params.jobId, ownerToken, new Date(), SEC_MEMORY_MODEL_LEASE_MS, trackedTickersFor(env)));
  if (!claim) return { status: "no-op", jobId: params.jobId };
  const source = await step.do(`memory-source:${params.jobId}`, async () => {
    const object = await env.SEC_FILINGS.get(claim.sourceR2Key);
    if (!object) throw new Error(`Memory source not found: ${claim.sourceR2Key}`);
    return JSON.parse(await object.text()) as Record<string, unknown>;
  });
  const validEvidenceIds = collectValidEvidenceIds(source);
  const priorMemoryIds = collectPriorMemoryIds(source);
  const extraction = await step.do(`memory-extract:${params.jobId}`, async (context) => {
    const execution = modelExecutionForAttempt(context?.attempt ?? 1);
    // Durable retries can outlive the original lease. Renew ownership before
    // another long model call so the sweeper cannot launch a competing writer.
    if (execution.attempt > 1 && !await repository.claimMemoryJob(params.jobId, ownerToken, new Date(), SEC_MEMORY_MODEL_LEASE_MS, trackedTickersFor(env))) {
      throw new Error("Memory lease ownership changed before model retry");
    }
    const value = await callWorkerSecModel(env, fetcher, "memory-extract", memoryExtractionSystemPrompt(), compactMemorySource(source), execution.model);
    return normalizeMemoryExtraction(value, validEvidenceIds, priorMemoryIds);
  });
  const committed = await step.do(`memory-commit:${params.jobId}`, async () => {
    assertTrackedTicker(env, claim.ticker);
    return { status: "committed" as const, ...await repository.commitMemoryJob(claim, extraction) };
  });
  let companyAnalysisQueued = false;
  const reportDate = sourceReportDate(source, claim.periodId);
  if (env.COMPANY_ANALYSIS_WORKFLOW && Number.isInteger(committed.memoryVersion) && reportDate) {
    companyAnalysisQueued = await step.do(`company-analysis-enqueue:${params.jobId}`, async () => {
      const triggerRef = `${params.jobId}:${committed.memoryVersion}`;
      try {
        await env.COMPANY_ANALYSIS_WORKFLOW!.create({
          id: `company-${hashString(triggerRef)}`,
          params: {
            ticker: params.ticker,
            memoryJobId: params.jobId,
            memoryVersion: committed.memoryVersion,
            periodId: claim.periodId,
            reportDate,
            triggerRef,
          },
        });
        return true;
      } catch (error) {
        if (/already exists|duplicate/i.test(String(error))) return true;
        throw error;
      }
    });
  }
  return {
    status: committed.status,
    jobId: params.jobId,
    noOp: committed.noOp,
    itemCount: committed.itemCount,
    companyAnalysisQueued,
  };
}

function sourceReportDate(source: Record<string, unknown>, periodId: string): string {
  const reportDate = String(record(record(source.artifact)?.filing)?.reportDate ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return reportDate;
  return periodId.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

function compactMemorySource(source: Record<string, unknown>) {
  const artifact = record(source.artifact);
  const summary = record(source.summary);
  const brief = record(artifact?.brief);
  const changes = record(record(artifact?.report)?.changes);
  const review = record(artifact?.managerReview) ?? record(summary?.managerReview);
  const nodes = Array.isArray(summary?.nodes) ? summary.nodes : [];
  return {
    task: "Extract durable company memory from verified filing analysis inputs.",
    facts: brief?.currentFacts ?? [],
    comparisons: brief?.comparisons ?? [],
    // Guidance and risks are the structured claims this filing actually produced; the brief never
    // carried a claims field, so this input used to arrive empty on every single run.
    claims: [
      ...(Array.isArray(changes?.guidance) ? changes.guidance : []),
      ...(Array.isArray(changes?.risks) ? changes.risks : []),
    ],
    // Projected, not passed through. A node result carries up to 16 located excerpts of 560
    // characters in `evidence`, and none of them holds an evidence id, so the extractor cannot cite
    // any of it — `evidenceIds` is the citable list. Whole nodes made this the largest input here
    // by an order of magnitude, with the bulk of it unusable.
    nodeAnalyses: nodes.flatMap((node) => {
      const item = record(node);
      if (!item) return [];
      return [{
        id: item.id,
        title: item.title,
        findings: item.findings ?? [],
        narrative: item.narrative ?? "",
        facts: item.facts ?? [],
        evidenceIds: item.evidenceIds ?? [],
      }];
    }),
    unresolvedItems: review?.unresolvedQuestions ?? [],
    priorMemory: brief?.memoryItems ?? [],
    rules: [
      "Keep only facts or falsifiable judgments that can affect a future filing assessment.",
      "Every candidate must cite supplied evidence IDs.",
      "A judgment requires horizon, nextTest, and falsifier.",
      "When a candidate continues an item in priorMemory, copy that item's memoryId verbatim into memoryId. Rewording topicKey without it forks a duplicate memory and abandons the original.",
      "Leave memoryId empty only for genuinely new memory. Never invent a memoryId that is not in priorMemory.",
      "Omission is stale, never resolved. Use resolved only for explicit fulfillment and contradicted only for explicit contrary evidence.",
    ],
    outputSchema: {
      candidates: "[{candidateId,memoryId,kind:fact|judgment,topicKey,statement,evidenceIds,materialityScore,confidence,horizon,nextTest,falsifier,disposition}]",
    },
  };
}

function collectPriorMemoryIds(source: Record<string, unknown>): Set<string> {
  const items = record(record(source.artifact)?.brief)?.memoryItems;
  if (!Array.isArray(items)) return new Set();
  return new Set(items.map((item) => String(record(item)?.memoryId ?? "").trim()).filter(Boolean));
}

function collectValidEvidenceIds(source: Record<string, unknown>): Set<string> {
  const artifact = record(source.artifact);
  return new Set(Array.isArray(artifact?.validEvidenceIds) ? artifact.validEvidenceIds.map(String) : []);
}

function memoryExtractionSystemPrompt() {
  return [
    "You are Phase 1 of a company filing memory system.",
    "Perform one strict structured extraction. Do not summarize the report prose and do not invent future expectations.",
    "Facts require evidence. Judgments require evidence, a deadline or horizon, nextTest, and falsifier.",
    "Continuity is the point of this system: a candidate that updates something in priorMemory must repeat that item's memoryId exactly, even when you reword its topicKey or statement.",
    "Return one JSON object using the exact outputSchema.",
  ].join("\n");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}
