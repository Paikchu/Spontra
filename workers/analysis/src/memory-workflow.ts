import { featureTickersFor } from "./financial-data/company-policy.ts";
import { modelFor, reasoningFor } from "./ai-config.ts";
import { D1SecRepository } from "./sec/d1.ts";
import { hashString } from "./sec/analysis.ts";
import { normalizeMemoryExtraction } from "./sec/memory.ts";
import { assertFeatureTicker, requireDb, type SecMemoryWorkflowParams } from "./core.ts";
import { callWorkerSecModel, type AnalysisEnv } from "./operations.ts";
import { modelExecutionForAttempt, SEC_MEMORY_MODEL_LEASE_MS } from "./retry-policy.ts";
import type { WorkflowStepLike } from "./workflow-core.ts";
import { FILING_MEMORY_SCHEMA, type FilingMemorySource } from "./filing-analysis/memory-source.ts";

export async function executeSecMemoryWorkflow(
  params: SecMemoryWorkflowParams,
  workflowInstanceId: string,
  step: WorkflowStepLike,
  env: AnalysisEnv,
  fetcher: typeof fetch = fetch,
) {
  const ownerToken = params.ownerToken || `${workflowInstanceId}:${crypto.randomUUID()}`;
  const repository = new D1SecRepository(requireDb(env));
  const claim = await step.do(`memory-claim:${params.jobId}`, () => repository.claimMemoryJob(params.jobId, ownerToken, new Date(), SEC_MEMORY_MODEL_LEASE_MS, featureTickersFor(env, "filings")));
  if (!claim) return { status: "no-op", jobId: params.jobId };
  const source = await step.do(`memory-source:${params.jobId}`, async () => {
    const object = await env.SEC_FILINGS.get(claim.sourceR2Key);
    if (!object) throw new Error(`Memory source not found: ${claim.sourceR2Key}`);
    return JSON.parse(await object.text()) as Record<string, unknown>;
  });
  // A filing report (the filing path) carries no memory of its own: the company's open items are read when the job runs,
  // so a job sees what the jobs before it committed.
  const prior = isFilingReport(source) ? await step.do(`memory-prior:${params.jobId}`, () => openMemoryItems(requireDb(env), claim.ticker)) : null;
  const validEvidenceIds = prior ? new Set((source as FilingMemorySource).evidence.map((e) => e.id)) : collectValidEvidenceIds(source);
  const priorMemoryIds = prior ? new Set(prior.map((item) => String(item.memoryId))) : collectPriorMemoryIds(source);
  const extraction = await step.do(`memory-extract:${params.jobId}`, async (context) => {
    const execution = modelExecutionForAttempt(context?.attempt ?? 1);
    // Durable retries can outlive the original lease. Renew ownership before
    // another long model call so the sweeper cannot launch a competing writer. The token is the one the claim step
    // recorded: `ownerToken` above is minted again whenever the engine replays `run()`, so it cannot prove ownership.
    if (execution.attempt > 1 && !await repository.claimMemoryJob(params.jobId, claim.ownerToken, new Date(), SEC_MEMORY_MODEL_LEASE_MS, featureTickersFor(env, "filings"))) {
      throw new Error("Memory lease ownership changed before model retry");
    }
    const value = await callWorkerSecModel(env, fetcher, "memory-extract", memoryExtractionSystemPrompt(), prior ? filingReportMemorySource(source as FilingMemorySource, prior) : compactMemorySource(source), execution.model || modelFor(env, "memory"), undefined, { reasoning: reasoningFor(env, "memory"), ticker: claim.ticker, runId: workflowInstanceId, kind: "memory" });
    return normalizeMemoryExtraction(value, validEvidenceIds, priorMemoryIds);
  });
  const committed = await step.do(`memory-commit:${params.jobId}`, async () => {
    assertFeatureTicker(env, "filings", claim.ticker);
    return { status: "committed" as const, ...await repository.commitMemoryJob(claim, extraction) };
  });
  let companyAnalysisQueued = false;
  const reportDate = sourceReportDate(source, claim.periodId);
  // Memory is layer 2; the company analysis it feeds is layer 3 and starts only where that layer is on.
  if (env.COMPANY_ANALYSIS_WORKFLOW && featureTickersFor(env, "findings").includes(params.ticker) && Number.isInteger(committed.memoryVersion) && reportDate) {
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
  const reportDate = String(record(isFilingReport(source) ? source.filing : record(source.artifact)?.filing)?.reportDate ?? "").trim();
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

const isFilingReport = (source: Record<string, unknown>) => source.schema === FILING_MEMORY_SCHEMA;

type OpenMemoryItem = Record<string, unknown> & { memoryId: string };
/** The company's open memory, as the filing analysis brief listed it: active and provisional items, and stale ones still due. */
async function openMemoryItems(db: D1Database, ticker: string): Promise<OpenMemoryItem[]> {
  const rows = await db.prepare(`
    SELECT memory_id AS memoryId, kind, topic_key AS topicKey, statement, status, materiality_score AS materialityScore,
      confidence, first_seen_period AS firstSeenPeriod, last_confirmed_period AS lastConfirmedPeriod,
      horizon, next_test AS nextTest, falsifier, due_period AS duePeriod
    FROM sec_memory_items
    WHERE ticker = ? AND (status IN ('active', 'provisional') OR (status = 'stale' AND due_period IS NOT NULL))
    ORDER BY CASE WHEN due_period IS NOT NULL THEN 0 ELSE 1 END, materiality_score DESC
    LIMIT 20
  `).bind(ticker).all<OpenMemoryItem>();
  return rows.results.map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as OpenMemoryItem);
}

/** The extraction input for a filing report: the report, the sections it was written from as the citable evidence, and the open memory. */
function filingReportMemorySource(source: FilingMemorySource, priorMemory: OpenMemoryItem[]) {
  return {
    task: "Extract durable company memory from a published filing report.",
    filing: source.filing,
    report: { headline: source.report.headline, markdown: source.report.markdown.slice(0, 60_000) },
    evidence: source.evidence,
    priorMemory,
    rules: [
      "Keep only facts or falsifiable judgments that can affect a future filing assessment.",
      "Every candidate must cite, in evidenceIds, the ids of the evidence sections its statement rests on. Use only ids listed in evidence.",
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
    "Perform one strict structured extraction. Do not restate the report as a summary and do not invent future expectations.",
    "Facts require evidence. Judgments require evidence, a deadline or horizon, nextTest, and falsifier.",
    "Continuity is the point of this system: a candidate that updates something in priorMemory must repeat that item's memoryId exactly, even when you reword its topicKey or statement.",
    "Return one JSON object using the exact outputSchema.",
  ].join("\n");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}
