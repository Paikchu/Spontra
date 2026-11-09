import type { StepContext } from "./durable-runs/engine.ts";
import { DISCOVERY_BUDGET_WARNING, type DiscoveryChunk } from "./sec/discovery.ts";
import {
  buildSecAnalysisBrief,
  SEC_ANALYSIS_SCHEMA_VERSION,
  type ManagerReview,
  type SecAnalysisBrief,
} from "./sec/analysis.ts";
import type {
  SecFiling,
  SecFilingSummary,
  SecNodePlan,
  SecNodeResult,
} from "./sec/sec.ts";
import { SEC_SUMMARY_VERSION } from "./sec/sec.ts";
import type { SecAnalysisArtifact, SecAnalysisContext } from "./sec/types.ts";
import type { SecWorkflowParams } from "./core.ts";
import type { CoverAmendment } from "./sec/amendment.ts";
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

export type WorkflowStepContextLike = StepContext;

export type WorkflowStepLike = {
  do<T>(name: string, callback: (context?: WorkflowStepContextLike) => Promise<T>): Promise<T>;
  /** Waits for work that runs outside the steps (a Pi session); see RunStep.waitFor. */
  waitFor?<T>(name: string, check: () => Promise<T | null>, recheck: number): Promise<T>;
};

function executionFor(context?: WorkflowStepContextLike): SecModelExecution {
  return modelExecutionForAttempt(context?.attempt ?? 1);
}

export type PreparedFilingReference = {
  discoveryChunks?: number;
  key: string;
  filing: SecFiling;
  /** Set when the filing only adds an exhibit and leaves the original disclosures unchanged. */
  coverAmendment?: CoverAmendment;
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

export type WrittenReport = { plan: SecNodePlan; nodes: SecNodeResult[]; managerReview: ManagerReview; rounds: number; result: { artifact: SecAnalysisArtifact; summary: SecFilingSummary | null } };

export type AnalysisOperations = {
  loadFiling?(ticker: string, accessionNumber: string): Promise<SecFiling | null>;
  restoreAnalysis?(filing: SecFiling, reference: PreparedFilingReference): Promise<{ plan: SecNodePlan; nodes: SecNodeResult[]; review: ManagerReview; rounds: number } | null>;
  scanDisclosures?(filing: SecFiling, reference: PreparedFilingReference, index: number, execution?: SecModelExecution): Promise<DiscoveryChunk>;
  finishDiscovery?(filing: SecFiling, reference: PreparedFilingReference, chunks: DiscoveryChunk[]): Promise<{ groundedDisclosures: number }>;

  classifyEarnings?(filing: SecFiling, execution?: SecModelExecution): Promise<string | null>;
  groupEarnings?(filings: SecFiling[], periods: Map<string, string | null>): Promise<SecFiling[]>;
  discover(ticker: string): Promise<{ feed: unknown; filings: SecFiling[] }>;
  publishFeed(feed: unknown): Promise<void>;
  shouldAnalyze(filing: SecFiling, requestedBy: SecWorkflowParams["requestedBy"]): Promise<boolean>;
  getContext(filing: SecFiling, prepared?: PreparedFilingReference): Promise<SecAnalysisContext>;
  prepare(filing: SecFiling): Promise<PreparedFilingReference>;
  buildBrief?(filing: SecFiling, prepared: PreparedFilingReference, context: SecAnalysisContext): Promise<SecAnalysisBrief>;
  /** Writes the periodic filing's report as one agent session (sec/report-agent.ts); returns the passed report. */
  writeReport(filing: SecFiling, prepared: PreparedFilingReference, context: SecAnalysisContext, brief: SecAnalysisBrief,
    restored: { plan: SecNodePlan; nodes: SecNodeResult[]; review: ManagerReview; rounds: number } | null, step: WorkflowStepLike): Promise<WrittenReport>;
  summarizeEvent(filing: SecFiling, prepared: PreparedFilingReference, execution?: SecModelExecution): Promise<SecFilingSummary>;
  /** Publishes the filing's own amendment note. Absent, a cover amendment follows the full report path. */
  publishAmendment?(filing: SecFiling, note: CoverAmendment): Promise<void>;

  loadPassedReport?(reference: PreparedFilingReference, passed: { resultKey: string; reviewedAt: string; notes: string[] }): Promise<{ artifact: SecAnalysisArtifact; summary: SecFilingSummary }>;
  publish(artifact: SecAnalysisArtifact, summary: SecFilingSummary | null): Promise<void | { memoryJobId?: string }>;
  enqueueMemory?(jobId: string, ticker: string): Promise<void>;
  publishEvent(summary: SecFilingSummary): Promise<void>;
  updateJob(job: WorkflowJobUpdate): Promise<void>;
  /** Moves a running job's `current_stage` to the step it is entering, so the admin shows how far the report got. */
  markJobStage?(jobId: string, stage: string): Promise<void>;
};

/**
 * Steps for one filing's job: each step named `<stage>:<accession>[:<detail>]` records `<stage>[:<detail>]` as the job's
 * stage when it starts. The record is written inside the durable step, so a replay, which skips finished steps, never
 * moves the shown stage backwards; a failed record never fails the step.
 */
function jobStageSteps(step: WorkflowStepLike, accession: string, jobId: string, operations: AnalysisOperations): WorkflowStepLike {
  if (!operations.markJobStage) return step;
  const marker = `:${accession}`;
  return {
    ...(step.waitFor ? { waitFor: step.waitFor.bind(step) } : {}),
    do: (name, callback) => step.do(name, async (context) => {
      const at = name.indexOf(marker), stage = at > 0 ? name.slice(0, at) : "";
      if (stage && stage !== "status" && stage !== "job" && stage !== "memory-enqueue") {
        try { await operations.markJobStage!(jobId, `${stage}${name.slice(at + marker.length)}`.slice(0, 120)); } catch { /* bookkeeping only */ }
      }
      return callback(context);
    }),
  };
}

/** The company's filing list with earnings groups, published as the feed; or the one filing a manual run names. */
export async function discoverFilings(params: Pick<SecWorkflowParams, "ticker" | "accessionNumber" | "requestedBy" | "regenerateReport">, step: WorkflowStepLike, operations: AnalysisOperations) {
  if (params.regenerateReport && (params.requestedBy !== "manual" || !params.accessionNumber)) throw new Error("Report regeneration requires a manual request and an explicit accession");
  const targeted = params.regenerateReport && operations.loadFiling
    ? await step.do("load-selected-filing", () => operations.loadFiling!(params.ticker, params.accessionNumber!)) : null;
  if (params.regenerateReport && operations.loadFiling && !targeted) throw new Error("Requested filing is no longer available");
  const discovery = targeted ? { feed: null, filings: [targeted] } : await step.do("discover", () => operations.discover(params.ticker));
  if (!targeted && operations.classifyEarnings && operations.groupEarnings) {
    const periods = new Map<string, string | null>();
    for (const filing of discovery.filings) {
      const period = await step.do(`classify-earnings:${filing.accessionNumber}`, (context) => operations.classifyEarnings!(filing, executionFor(context))).catch(() => null);
      periods.set(filing.accessionNumber, period);
    }
    discovery.filings = await step.do("group-earnings", () => operations.groupEarnings!(discovery.filings, periods));
    discovery.feed = { ...(discovery.feed as Record<string, unknown>), filings: discovery.filings };
  }
  if (!targeted) await step.do("publish-feed", () => operations.publishFeed(discovery.feed));
  return discovery;
}

export async function executeSecAnalysisWorkflow(
  params: SecWorkflowParams,
  workflowInstanceId: string,
  step: WorkflowStepLike,
  operations: AnalysisOperations,
) {
  if (params.regenerateReport && (params.requestedBy !== "manual" || !params.accessionNumber)) throw new Error("Report regeneration requires a manual request and an explicit accession");
  const discovery = await discoverFilings(params, step, operations);
  const targeted = params.regenerateReport && operations.loadFiling ? discovery.filings[0]! : null;
  const analyzed: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  const candidates = params.accessionNumber ? discovery.filings.filter(f => f.accessionNumber === params.accessionNumber) : params.backfill
    ? discovery.filings.filter((filing) => /^(10-K|10-Q|20-F|8-K|6-K)(\/A)?$/.test(filing.form))
    : selectLatestWorkflowFilings(discovery.filings);
  if (params.accessionNumber && !candidates.length) throw new Error("Requested accession is not in the issuer filing feed");
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
    const jobStep = jobStageSteps(step, accession, jobId, operations);
    try {
      const shouldAnalyze = await jobStep.do(`status:${accession}`, () => operations.shouldAnalyze(filing, params.requestedBy));
      if (!shouldAnalyze) {
        skipped.push(accession);
        continue;
      }
      const eventFiling = /^(8-K|6-K)(\/A)?$/.test(filing.form);
      stage = "prepare";
      await jobStep.do(`job:${accession}:start`, () => operations.updateJob({ ...baseJob, status: "running", currentStage: "prepare", updatedAt: new Date().toISOString() }));
      console.log(JSON.stringify({ event: "sec-report-generation", policy: "reliability.v1", jobId, workflowInstanceId, ticker: filing.ticker, accession, status: "started" }));
      const prepared = await jobStep.do(`prepare:${accession}`, () => operations.prepare(filing));
      // A cover page that only adds an exhibit has no statements to analyze. Publishing that limitation
      // is the result; sending it through the reader report fails the same way on every retry.
      if (!eventFiling && prepared.coverAmendment && operations.publishAmendment) {
        stage = "amendment-note";
        await jobStep.do(`amendment-note:${accession}`, () => operations.publishAmendment!(filing, prepared.coverAmendment!));
        await jobStep.do(`job:${accession}:complete`, () => operations.updateJob({ ...baseJob, status: "complete", currentStage: "published", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() }));
        analyzed.push(accession);
        continue;
      }
      const restored = params.regenerateReport && !eventFiling && operations.restoreAnalysis
        ? await jobStep.do(`restore-analysis:${accession}`, () => operations.restoreAnalysis!(filing, prepared)) : null;
      // The brief comes from stored history alone, so a filing whose history cannot be used fails here, before any
      // model call; only the check that needs discovery's grounded disclosures waits for it.
      let periodic: { context: SecAnalysisContext; brief: SecAnalysisBrief } | null = null;
      if (!eventFiling) {
        stage = "context";
        const context = await jobStep.do(`context:${accession}`, () => operations.getContext(filing, prepared));
        stage = "brief";
        const brief = await jobStep.do(`brief:${accession}`, async () => operations.buildBrief
          ? operations.buildBrief(filing, prepared, context)
          : buildFallbackBrief(filing, context));
        assertHistoryUnits(brief);
        periodic = { context, brief };
      }
      let discoveryResult: { groundedDisclosures: number } | undefined;
      if (!restored && operations.scanDisclosures && operations.finishDiscovery && prepared.discoveryChunks) {
        stage = "discovery";
        const chunks = await mapWithConcurrency(Array.from({length:prepared.discoveryChunks}, (_,index) => index), SEC_NODE_CONCURRENCY,
          (index) => jobStep.do(`discovery:${accession}:${index}`, (stepContext) => operations.scanDisclosures!(filing, prepared, index, executionFor(stepContext))));
        discoveryResult = await jobStep.do(`discovery-finish:${accession}`, () => operations.finishDiscovery!(filing, prepared, chunks));
      }
      if (eventFiling) {
        stage = "event-summary";
        const summary = await jobStep.do(`event-summary:${accession}`, (context) => operations.summarizeEvent(filing, prepared, executionFor(context)));
        stage = "publish";
        await jobStep.do(`publish-event:${accession}`, () => operations.publishEvent(summary));
        await jobStep.do(`job:${accession}:complete`, () => operations.updateJob({ ...baseJob, status: "complete", currentStage: "published", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() }));
        analyzed.push(accession);
        continue;
      }
      const { context, brief } = periodic!;
      stage = "brief";
      assertBriefCanProceed(brief, Boolean(restored || discoveryResult?.groundedDisclosures));
      stage = "report";
      const written = await operations.writeReport(filing, prepared, context, brief, restored, jobStep);
      const { plan, managerReview } = written;
      const loop = { nodes: written.nodes, rounds: written.rounds };
      let result = written.result;
      const discoveryWarnings = [
        ...(result.artifact.report.discovery?.warnings ?? []),
        // The Chinese match covers plans restored from reports written before the English prompts.
        ...(plan.warnings ?? []).filter((warning) => warning === DISCOVERY_BUDGET_WARNING || warning.includes("仍有发现未展开")),
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
        await jobStep.do(`job:${accession}:failed`, () => operations.updateJob({
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
      const summary = result.summary ? {
        ...result.summary,
        plan,
        nodes: result.summary.nodes ?? loop.nodes,
        managerReview,
        repairRounds: loop.rounds,
      } : null;
      stage = "publish";
      const publication = await jobStep.do(`publish:${accession}`, () => operations.publish(result.artifact, summary));
      await jobStep.do(`job:${accession}:complete`, () => operations.updateJob({ ...baseJob, status: "complete", currentStage: "published", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() }));
      console.log(JSON.stringify({ event: "sec-report-generation", policy: "reliability.v1", jobId, workflowInstanceId, ticker: filing.ticker, accession, status: "published", reportVersion: result.artifact.report.reportVersion }));
      if (publication && publication.memoryJobId && operations.enqueueMemory) {
        await jobStep.do(`memory-enqueue:${accession}`, async () => {
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
      const failureCode = error instanceof SecModelOutputError ? error.code : error instanceof SecModelHttpError ? `provider_http_${error.status}`
        : /failed editorial review/i.test(detail) ? "editorial_quality_failed" : /Reader report|Reader section|Editorial patch/i.test(detail) ? "reader_structure_failed" : hardFailure ? "hard_failure" : "pipeline_error";
      await jobStep.do(`job:${accession}:error`, () => operations.updateJob({
        ...baseJob,
        status: "failed",
        currentStage: stage,
        errorCode: failureCode,
        errorDetail: detail,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }));
      console.log(JSON.stringify({ event: "sec-report-generation", policy: "reliability.v1", jobId, workflowInstanceId, ticker: filing.ticker, accession, status: "failed", stage,
        failureCode }));
      failed.push(accession);
    }
  }
  return { analyzed, skipped, failed };
}

export function selectLatestWorkflowFilings(filings: SecFiling[]): SecFiling[] {
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
}

/** One period of a series in one basis has one unit; mixed units mean the history cannot be compared. */
export function assertHistoryUnits(brief: SecAnalysisBrief): void {
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
