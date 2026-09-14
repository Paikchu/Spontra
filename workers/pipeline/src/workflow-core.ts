import type { DiscoveryChunk } from "./sec/discovery.ts";
import {
  MAX_REPAIR_NODES_PER_ROUND,
  MAX_REPAIR_ROUNDS,
  buildSecAnalysisBrief,
  SEC_ANALYSIS_SCHEMA_VERSION,
  unresolvedFingerprint,
  type ManagerRepairTask,
  type ManagerReview,
  type SecAnalysisBrief,
} from "./sec/analysis.ts";
import type {
  SecFiling,
  SecFilingSummary,
  SecNodePlan,
  SecNodeResult,
  SecNodeSpec,
} from "./sec/sec.ts";
import { SEC_SUMMARY_VERSION } from "./sec/sec.ts";
import type { SecAnalysisArtifact, SecAnalysisContext } from "./sec/types.ts";
import type { SecWorkflowParams } from "./core.ts";
import { modelExecutionForAttempt, type SecModelExecution } from "./retry-policy.ts";
import { SecModelOutputError } from "./model-stream.ts";
import { SecModelHttpError } from "./model-recovery.ts";

const SEC_NODE_CONCURRENCY = 2;

/**
 * Job lookup version. Event filings additionally key on the summary version: bumping
 * SEC_SUMMARY_VERSION invalidates stored event summaries so they regenerate through the
 * current exhibit pipeline, while periodic filings keep the analysis-schema key.
 */
export function jobAnalysisVersionFor(form: string): string {
  return /^(8-K|6-K)(\/A)?$/.test(form)
    ? `${SEC_ANALYSIS_SCHEMA_VERSION}+summary-v${SEC_SUMMARY_VERSION}`
    : SEC_ANALYSIS_SCHEMA_VERSION;
}

export type WorkflowStepContextLike = {
  attempt: number;
};

export type WorkflowStepLike = {
  do<T>(name: string, callback: (context?: WorkflowStepContextLike) => Promise<T>): Promise<T>;
};

function executionFor(context?: WorkflowStepContextLike): SecModelExecution {
  return modelExecutionForAttempt(context?.attempt ?? 1);
}

export type ManagerRepairLoopRuntime = {
  review(round: number, nodes: SecNodeResult[], execution?: SecModelExecution): Promise<ManagerReview>;
  repair(task: ManagerRepairTask, round: number, execution?: SecModelExecution): Promise<SecNodeResult>;
};

export async function runManagerRepairLoop(
  accessionNumber: string,
  step: WorkflowStepLike,
  _plan: SecNodePlan,
  initialNodes: SecNodeResult[],
  runtime: ManagerRepairLoopRuntime,
): Promise<{ nodes: SecNodeResult[]; review: ManagerReview; rounds: number }> {
  const nodes = [...initialNodes];
  let rounds = 0;
  let review = await step.do(`manager-review:${accessionNumber}:round:0`, (context) => runtime.review(0, nodes, executionFor(context)));
  let previousFingerprint = unresolvedFingerprint(review);
  while (review.status === "needs_repair" && rounds < MAX_REPAIR_ROUNDS) {
    const tasks = [...review.repairTasks].sort(byMateriality).slice(0, MAX_REPAIR_NODES_PER_ROUND);
    if (!tasks.length) {
      review = { ...review, status: "partial", stopReason: "analysis_incomplete" };
      break;
    }
    rounds += 1;
    const repaired: SecNodeResult[] = [];
    for (const [index, task] of tasks.entries()) {
      repaired.push(await step.do(
        `repair-node:${accessionNumber}:round:${rounds}:${index}:${task.id}`,
        (context) => runtime.repair(task, rounds, executionFor(context)),
      ));
    }
    for (const result of repaired) {
      const index = nodes.findIndex((node) => node.id === result.id);
      if (index >= 0) nodes[index] = result;
      else nodes.push(result);
    }
    review = await step.do(`manager-review:${accessionNumber}:round:${rounds}`, (context) => runtime.review(rounds, nodes, executionFor(context)));
    const fingerprint = unresolvedFingerprint(review);
    if (review.status === "needs_repair" && fingerprint === previousFingerprint) {
      review = { ...review, status: "partial", repairTasks: [], stopReason: "no_progress" };
      break;
    }
    previousFingerprint = fingerprint;
  }
  if (review.status === "needs_repair") review = { ...review, status: "partial", repairTasks: [], stopReason: "max_rounds" };
  if (review.status === "partial" && !review.stopReason) review = { ...review, stopReason: "analysis_incomplete" };
  return { nodes, review, rounds };
}

function byMateriality(left: ManagerRepairTask, right: ManagerRepairTask): number {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return rank[left.materiality] - rank[right.materiality];
}

export type PreparedFilingReference = {
  discoveryChunks?: number;
  key: string;
  filing: SecFiling;
};

export type WorkflowJobUpdate = {
  jobId: string;
  ticker: string;
  accessionNumber: string;
  analysisVersion: string;
  status: "queued" | "running" | "complete" | "failed";
  currentStage: string;
  attempt: number;
  errorCode?: string;
  errorDetail?: string;
  requestedBy: SecWorkflowParams["requestedBy"];
  workflowInstanceId: string;
  updatedAt: string;
  completedAt?: string;
};

export type SecPipelineOperations = {
  scanDisclosures?(filing: SecFiling, reference: PreparedFilingReference, index: number, execution?: SecModelExecution): Promise<DiscoveryChunk>;
  finishDiscovery?(filing: SecFiling, reference: PreparedFilingReference, chunks: DiscoveryChunk[]): Promise<{ groundedDisclosures: number }>;
  auditDisclosures?(filing: SecFiling, reference: PreparedFilingReference, plan: SecNodePlan, nodes: SecNodeResult[], execution?: SecModelExecution): Promise<SecNodeSpec[]>;
  classifyEarnings?(filing: SecFiling, execution?: SecModelExecution): Promise<string | null>;
  groupEarnings?(filings: SecFiling[], periods: Map<string, string | null>): Promise<SecFiling[]>;
  discover(ticker: string): Promise<{ feed: unknown; filings: SecFiling[] }>;
  publishFeed(feed: unknown): Promise<void>;
  shouldAnalyze(filing: SecFiling, requestedBy: SecWorkflowParams["requestedBy"]): Promise<boolean>;
  getContext(filing: SecFiling, prepared?: PreparedFilingReference): Promise<SecAnalysisContext>;
  prepare(filing: SecFiling): Promise<PreparedFilingReference>;
  buildBrief?(filing: SecFiling, prepared: PreparedFilingReference, context: SecAnalysisContext): Promise<SecAnalysisBrief>;
  plan(filing: SecFiling, prepared: PreparedFilingReference, brief?: SecAnalysisBrief, execution?: SecModelExecution): Promise<SecNodePlan>;
  analyzeNode(spec: SecNodeSpec, filing: SecFiling, prepared: PreparedFilingReference, brief?: SecAnalysisBrief, round?: number, execution?: SecModelExecution): Promise<SecNodeResult>;
  review?(filing: SecFiling, prepared: PreparedFilingReference, brief: SecAnalysisBrief, plan: SecNodePlan, nodes: SecNodeResult[], round: number, execution?: SecModelExecution): Promise<ManagerReview>;
  composePresentation?(filing: SecFiling, prepared: PreparedFilingReference, report: SecAnalysisArtifact['report'], nodes: SecNodeResult[], brief: SecAnalysisBrief, execution?: SecModelExecution): Promise<SecAnalysisArtifact['report']>;
  auditReport?(prepared: PreparedFilingReference, nodes: SecNodeResult[], brief: SecAnalysisBrief,
    draft: { artifact: SecAnalysisArtifact; summary: SecFilingSummary | null }, round: number, execution?: SecModelExecution): Promise<{ issues: string[]; reviewedAt: string }>;
  reviseReport?(filing: SecFiling, prepared: PreparedFilingReference, context: SecAnalysisContext, plan: SecNodePlan, nodes: SecNodeResult[], brief: SecAnalysisBrief, review: ManagerReview,
    issues: string[], execution?: SecModelExecution): Promise<{ artifact: SecAnalysisArtifact; summary: SecFilingSummary | null }>;
  summarizeEvent(filing: SecFiling, prepared: PreparedFilingReference, execution?: SecModelExecution): Promise<SecFilingSummary>;
  summarize(filing: SecFiling, prepared: PreparedFilingReference, context: SecAnalysisContext, plan: SecNodePlan, nodes: SecNodeResult[], brief?: SecAnalysisBrief, review?: ManagerReview, execution?: SecModelExecution): Promise<{ artifact: SecAnalysisArtifact; summary: SecFilingSummary | null }>;
  publish(artifact: SecAnalysisArtifact, summary: SecFilingSummary | null): Promise<void | { memoryJobId?: string }>;
  enqueueMemory?(jobId: string, ticker: string): Promise<void>;
  publishEvent(summary: SecFilingSummary): Promise<void>;
  updateJob(job: WorkflowJobUpdate): Promise<void>;
};

export async function executeSecAnalysisWorkflow(
  params: SecWorkflowParams,
  workflowInstanceId: string,
  step: WorkflowStepLike,
  operations: SecPipelineOperations,
) {
  const discovery = await step.do("discover", () => operations.discover(params.ticker));
  if (operations.classifyEarnings && operations.groupEarnings) {
    const periods = new Map<string, string | null>();
    for (const filing of discovery.filings) {
      const period = await step.do(`classify-earnings:${filing.accessionNumber}`, (context) => operations.classifyEarnings!(filing, executionFor(context))).catch(() => null);
      periods.set(filing.accessionNumber, period);
    }
    discovery.filings = await step.do("group-earnings", () => operations.groupEarnings!(discovery.filings, periods));
    discovery.feed = { ...(discovery.feed as Record<string, unknown>), filings: discovery.filings };
  }
  await step.do("publish-feed", () => operations.publishFeed(discovery.feed));
  const analyzed: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  const candidates = params.backfill
    ? discovery.filings.filter((filing) => /^(10-K|10-Q|20-F|8-K|6-K)(\/A)?$/.test(filing.form))
    : selectLatestWorkflowFilings(discovery.filings);
  const filings = candidates.map((filing) => filing.earningsGroup
    ? discovery.filings.find((candidate) => candidate.accessionNumber === filing.earningsGroup!.canonicalAccession) ?? filing
    : filing).filter((filing, index, all) => all.findIndex((candidate) => candidate.accessionNumber === filing.accessionNumber) === index);
  for (const filing of filings) {
    const accession = filing.accessionNumber;
    const jobId = `${filing.ticker}:${accession}:${jobAnalysisVersionFor(filing.form)}:${workflowInstanceId}`;
    const baseJob = {
      jobId,
      ticker: filing.ticker,
      accessionNumber: accession,
      analysisVersion: jobAnalysisVersionFor(filing.form),
      attempt: 1,
      requestedBy: params.requestedBy,
      workflowInstanceId,
    } as const;
    let stage = "context";
    try {
      const shouldAnalyze = await step.do(`status:${accession}`, () => operations.shouldAnalyze(filing, params.requestedBy));
      if (!shouldAnalyze) {
        skipped.push(accession);
        continue;
      }
      const eventFiling = /^(8-K|6-K)(\/A)?$/.test(filing.form);
      stage = "prepare";
      await step.do(`job:${accession}:start`, () => operations.updateJob({ ...baseJob, status: "running", currentStage: "prepare", updatedAt: new Date().toISOString() }));
      console.log(JSON.stringify({ event: "sec-report-generation", policy: "reliability.v1", jobId, workflowInstanceId, ticker: filing.ticker, accession, status: "started" }));
      const prepared = await step.do(`prepare:${accession}`, () => operations.prepare(filing));
      let discoveryResult: { groundedDisclosures: number } | undefined;
      if (operations.scanDisclosures && operations.finishDiscovery && prepared.discoveryChunks) {
        stage = "discovery";
        const chunks = await mapWithConcurrency(Array.from({length:prepared.discoveryChunks}, (_,index) => index), SEC_NODE_CONCURRENCY,
          (index) => step.do(`discovery:${accession}:${index}`, (stepContext) => operations.scanDisclosures!(filing, prepared, index, executionFor(stepContext))));
        discoveryResult = await step.do(`discovery-finish:${accession}`, () => operations.finishDiscovery!(filing, prepared, chunks));
      }
      if (eventFiling) {
        stage = "event-summary";
        const summary = await step.do(`event-summary:${accession}`, (context) => operations.summarizeEvent(filing, prepared, executionFor(context)));
        stage = "publish";
        await step.do(`publish-event:${accession}`, () => operations.publishEvent(summary));
        await step.do(`job:${accession}:complete`, () => operations.updateJob({ ...baseJob, status: "complete", currentStage: "published", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() }));
        analyzed.push(accession);
        continue;
      }
      stage = "context";
      const context = await step.do(`context:${accession}`, () => operations.getContext(filing, prepared));
      stage = "brief";
      const brief = await step.do(`brief:${accession}`, async () => operations.buildBrief
        ? operations.buildBrief(filing, prepared, context)
        : buildFallbackBrief(filing, context));
      assertBriefCanProceed(brief, Boolean(discoveryResult?.groundedDisclosures));
      stage = "manager";
      const plan = await step.do(`manager:${accession}`, async (stepContext) => {
        const planned = await operations.plan(filing, prepared, brief, executionFor(stepContext));
        if (!planned.nodes.length) throw new Error("Manager planned no analysis nodes");
        return planned;
      });
      stage = "nodes-round-0";
      const nodes = await mapWithConcurrency(plan.nodes, SEC_NODE_CONCURRENCY, (spec, index) => step.do(
        `node:${accession}:round:0:${index}:${spec.id}`,
        (stepContext) => operations.analyzeNode(spec, filing, prepared, brief, 0, executionFor(stepContext)),
      ));
      if (operations.auditDisclosures) {
        stage = "discovery-audit";
        const tasks = await step.do(`discovery-audit:${accession}`, (stepContext) => operations.auditDisclosures!(filing, prepared, plan, nodes, executionFor(stepContext)));
        for (const task of tasks) {
          const plannedIndex = plan.nodes.findIndex((node) => node.id === task.id);
          if (plannedIndex < 0) plan.nodes.push(task); else plan.nodes[plannedIndex] = task;
          const result = await step.do(`discovery-repair:${accession}:${task.id}`, (stepContext) => operations.analyzeNode(task, filing, prepared, brief, 2, executionFor(stepContext)));
          const resultIndex = nodes.findIndex((node) => node.id === result.id);
          if (resultIndex < 0) nodes.push(result); else nodes[resultIndex] = result;
        }
      }
      stage = "manager-review";
      const loop = await runManagerRepairLoop(accession, step, plan, nodes, {
        review: (round, currentNodes, execution) => operations.review
          ? operations.review(filing, prepared, brief, plan, currentNodes, round, execution)
          : Promise.resolve(fallbackManagerReview(plan, currentNodes)),
        repair: (task, round, execution) => operations.analyzeNode({ ...task, id: task.targetNodeId }, filing, prepared, brief, round, execution),
      });
      const managerReview: ManagerReview = loop.review;
      stage = "synthesis";
      let result = await step.do(`synthesis:${accession}`, (stepContext) => operations.summarize(filing, prepared, context, plan, loop.nodes, brief, managerReview, executionFor(stepContext)));
      const discoveryWarnings = [
        ...(result.artifact.report.discovery?.warnings ?? []),
        ...(plan.warnings ?? []).filter((warning) => warning.includes("仍有发现未展开")),
      ];
      if (discoveryWarnings.length) {
        managerReview.status = "partial";
        managerReview.stopReason = "analysis_incomplete";
        managerReview.unresolvedQuestions = [...new Set([...managerReview.unresolvedQuestions, ...discoveryWarnings])];
      }
      result.artifact.report.dataQuality = {
        ...result.artifact.report.dataQuality,
        analysisStatus: managerReview.status === "complete" ? "complete" : "partial",
        unresolvedQuestions: managerReview.unresolvedQuestions,
        failedNodeIds: loop.nodes.filter((node) => node.status !== "complete").map((node) => node.id),
        stopReason: managerReview.stopReason,
        managerCoverageScore: managerReview.coverageScore,
      };
      if (result.artifact.report.dataQuality.verificationStatus === "failed") {
        await step.do(`job:${accession}:failed`, () => operations.updateJob({
          ...baseJob,
          status: "failed",
          currentStage: "verification",
          errorCode: "verification_failed",
          errorDetail: result.artifact.report.dataQuality.warnings.join("; ").slice(0, 500),
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }));
        failed.push(accession);
        continue;
      }
      if (operations.auditReport) {
        for (let round = 0; round <= 1; round += 1) {
          stage = "editorial-review";
          const draft = result;
          const audit = await step.do(`editorial-review:${accession}:${round}`, (stepContext) => operations.auditReport!(prepared, loop.nodes, brief, draft, round, executionFor(stepContext)));
          if (!audit.issues.length) {
            result.artifact.report.editorialReview = { status: "passed", reviewedAt: audit.reviewedAt };
            break;
          }
          if (round === 1 || !operations.reviseReport) throw new Error(`Reader report failed editorial review: ${audit.issues.join("; ").slice(0, 1000)}`);
          stage = "editorial-revision";
          result = await step.do(`editorial-revision:${accession}`, (stepContext) => operations.reviseReport!(filing, prepared, context, plan, loop.nodes, brief, managerReview, audit.issues, executionFor(stepContext)));
        }
      }
      if (!result.artifact.report.reader && !result.artifact.report.presentation && operations.composePresentation) {
        stage = "presentation";
        result.artifact.report = await step.do(`presentation:${accession}`, (stepContext) => operations.composePresentation!(filing, prepared, result.artifact.report, loop.nodes, brief, executionFor(stepContext)));
      }
      const summary = result.summary ? {
        ...result.summary,
        plan,
        nodes: result.summary.nodes ?? loop.nodes,
        managerReview,
        repairRounds: loop.rounds,
      } : null;
      stage = "publish";
      const publication = await step.do(`publish:${accession}`, () => operations.publish(result.artifact, summary));
      await step.do(`job:${accession}:complete`, () => operations.updateJob({ ...baseJob, status: "complete", currentStage: "published", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() }));
      console.log(JSON.stringify({ event: "sec-report-generation", policy: "reliability.v1", jobId, workflowInstanceId, ticker: filing.ticker, accession, status: "published", reportVersion: result.artifact.report.reportVersion }));
      if (publication && publication.memoryJobId && operations.enqueueMemory) {
        await step.do(`memory-enqueue:${accession}`, async () => {
          try {
            await operations.enqueueMemory!(publication.memoryJobId!, filing.ticker);
          } catch {
            return;
          }
        });
      }
      analyzed.push(accession);
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 500) : "Unknown pipeline error";
      const hardFailure = /No core facts|illegal evidence|Conflicting (fact|history) units|Manager[- ](Review|planned)|Synthesis|final publish|R2 memory source/i.test(detail);
      await step.do(`job:${accession}:error`, () => operations.updateJob({
        ...baseJob,
        status: "failed",
        currentStage: stage,
        errorCode: error instanceof SecModelOutputError ? error.code : error instanceof SecModelHttpError ? `provider_http_${error.status}` : hardFailure ? "hard_failure" : "pipeline_error",
        errorDetail: detail,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }));
      console.log(JSON.stringify({ event: "sec-report-generation", policy: "reliability.v1", jobId, workflowInstanceId, ticker: filing.ticker, accession, status: "failed", stage,
        failureCode: error instanceof SecModelOutputError ? error.code : error instanceof SecModelHttpError ? `provider_http_${error.status}` : "pipeline_error" }));
      failed.push(accession);
    }
  }
  return { analyzed, skipped, failed };
}

function selectLatestWorkflowFilings(filings: SecFiling[]): SecFiling[] {
  const primary = filings.find((filing) => /^(10-K|10-Q|20-F)(\/A)?$/.test(filing.form));
  const events = filings.slice(0, 5).filter((filing) => /^(8-K|6-K)(\/A)?$/.test(filing.form));
  return [...(primary ? [primary] : []), ...events]
    .filter((filing, index, all) => all.findIndex((candidate) => candidate.accessionNumber === filing.accessionNumber) === index);
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, operation: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function buildFallbackBrief(filing: SecFiling, context: SecAnalysisContext): SecAnalysisBrief {
  return buildSecAnalysisBrief({
    ticker: filing.ticker,
    filingId: filing.accessionNumber,
    periodId: context.currentPeriodId,
    periodScope: /^(10-K|20-F)/.test(filing.form) ? "annual" : "quarter",
    reportDate: filing.reportDate,
    history: context.history ?? { registryVersion: "sec-canonical-series.v1", series: [] },
    memorySummary: context.companyMemorySummary ?? "",
    memoryItems: context.memoryItems ?? [],
  });
}

function assertBriefCanProceed(brief: SecAnalysisBrief, groundedDisclosures = false): void {
  if (!brief.history.series.length && !groundedDisclosures) throw new Error("No core facts passed factual verification");
  const identities = new Map<string, string>();
  for (const series of brief.history.series) {
    for (const observation of [...series.quarters, ...series.annual]) {
      const key = `history:${series.seriesId}:${observation.periodScope}:${observation.startDate ?? "instant"}:${observation.endDate}:${observation.basis}`;
      const unit = `${observation.unit}:${observation.currency ?? ""}`;
      const previous = identities.get(key);
      if (previous && previous !== unit) throw new Error(`Conflicting history units for ${series.seriesId}`);
      identities.set(key, unit);
    }
  }
}

function fallbackManagerReview(plan: SecNodePlan, nodes: SecNodeResult[]): ManagerReview {
  const results = new Map(nodes.map((node) => [node.id, node]));
  const questions = plan.nodes.map((node) => {
    const result = results.get(node.id);
    const answered = result?.status === "complete" && Boolean(result.narrative || result.findings.length);
    return { questionId: node.id, status: answered ? "answered" as const : "unanswered" as const, explanation: answered ? "Node completed" : result?.error ?? "Node incomplete" };
  });
  const unresolvedQuestions = plan.nodes.filter((_node, index) => questions[index].status !== "answered").map((node) => node.question);
  return {
    status: unresolvedQuestions.length ? "partial" : "complete",
    questions,
    repairTasks: [],
    unresolvedQuestions,
    coverageScore: questions.length ? questions.filter((question) => question.status === "answered").length / questions.length : 0,
    stopReason: unresolvedQuestions.length ? "analysis_incomplete" : "complete",
  };
}
