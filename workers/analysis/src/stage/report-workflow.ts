import { getAgentByName } from "agents";
import type { UserReport } from "../../../../shared/analysis-contract/user-report.ts";
import type { Locale } from "../../../../shared/analysis-runtime/locale.ts";
import type { PiLoaded } from "../pi/host.ts";
import { runRecipeSession } from "../pi/runs.ts";
import { modelFor, reasoningFor } from "../ai-config.ts";
import type { AnalysisEnv } from "../operations.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import type { StageAgent } from "./agent.ts";
import { refund, reserve } from "./budget.ts";
import { loadStageData } from "./data.ts";
import { sha256 } from "../sha256.ts";
import { reportDocuments, reportOpening, reportRecipe, type ReportInput, type ReportState } from "./report.ts";
import { readPublishedArtifact, type ArtifactStoreEnv } from "../artifact/store.ts";

export type ReportParams = { userId: string; address: string | null; conversationId: string; ticker: string; question: string; locale: Locale };
export type ReportOutcome = { runId: string; reportId: string | null; reason: string };
/** What the report's Pi session is rebuilt from; the stage data and the library's documents are read again. */
type ReportSpec = { params: ReportParams; now: string; runId: string; userHash: string };

/** Rebuilds the report recipe from its spec; each model call is reserved against the reader's report allowance. */
export async function reportLoader(spec: ReportSpec, env: AnalysisEnv): Promise<PiLoaded<ReportState>> {
  const { params } = spec;
  const data = await loadStageData(env, params.ticker);
  if (!data) throw new Error(`report: no stage data for ${params.ticker}`);
  const { documents, earlierAvailable } = await reportDocuments(env, params.ticker, data.periodEnd);
  const input: ReportInput = { env, data, question: params.question, locale: params.locale, documents, now: spec.now, earlierAvailable, runId: spec.runId };
  return {
    recipe: reportRecipe(input), input, model: modelFor(env, "analyst"), effort: reasoningFor(env, "analyst"),
    ledger: { kind: "stage-report", ticker: params.ticker, runId: spec.runId, userHash: spec.userHash, conversationId: params.conversationId },
    reserve: async (_state, now) => (await reserve(env.DB!, "stage-report-calls", { reader: params.userId, address: params.address }, 1, now)).ok,
    refund: (_state, reservedAt) => refund(env.DB!, "stage-report-calls", { reader: params.userId, address: params.address }, 1, reservedAt),
  };
}
type StageEnv = AnalysisEnv & { StageAgent?: DurableObjectNamespace };

/**
 * One reader's report: the report recipe run as a Pi session of this run's Agent, which checkpoints every model
 * call and tool call, so a restart continues what was done instead of paying for it again. The
 * report is saved under the run's id and the reader's conversation is told, as the last two steps.
 */
export async function executeReportWorkflow(params: ReportParams, steps: WorkflowStepLike, env: StageEnv, runId: string): Promise<ReportOutcome> {
  const db = env.DB!;
  const tell = (outcome: { phase: "running" } | ReportOutcome) => steps.do(`report-tell-${"phase" in outcome ? outcome.phase : "done"}`, async () => {
    if (!env.StageAgent) return false;
    const agent = await getAgentByName(env.StageAgent as unknown as DurableObjectNamespace<StageAgent>, params.conversationId);
    if ("phase" in outcome) await agent.reportPhase(runId, outcome.phase); else await agent.reportDone(outcome);
    return true;
  }).catch(() => false);
  await steps.do("report-start", async () => { await db.prepare("UPDATE user_runs SET status = 'running' WHERE user_id = ? AND id = ?").bind(params.userId, runId).run(); return true; });
  await tell({ phase: "running" });
  const finish = async (reportId: string | null, reason: string): Promise<ReportOutcome> => {
    await steps.do("report-record", async () => {
      await db.prepare("UPDATE user_runs SET status = ?, finished_at = ?, result = ? WHERE user_id = ? AND id = ?").bind(reportId ? "done" : "failed", new Date().toISOString(), JSON.stringify({ reportId, reason }), params.userId, runId).run();
      // A report that did not come out gives the reader's daily report back.
      if (!reportId) await refund(db, "stage-reports", { reader: params.userId, address: params.address }, 1);
      return true;
    });
    const outcome = { runId, reportId, reason };
    await tell(outcome);
    return outcome;
  };
  // Journalled, so the wakes that check on the session do not read the stage data and documents again.
  const ready = await steps.do("report-data", async () => !!await loadStageData(env, params.ticker));
  if (!ready) return finish(null, "no-data");
  const now = await steps.do("report-time", async () => new Date().toISOString());
  const userHash = await sha256(params.userId);
  const spec: ReportSpec = { params, now, runId, userHash };
  const opening = await steps.do("report-opening", async () => reportOpening((await reportLoader(spec, env)).input as ReportInput));
  const outcome = await runRecipeSession<boolean, ReportState>(env, steps, "report", spec, opening, `${runId}:report`);
  // The report is the artifact the session published (or the harness delivered when it ended); the reader's copy carries it whole.
  const artifact = outcome.state?.composer?.published ? await steps.do("report-artifact", () => readPublishedArtifact(env as unknown as ArtifactStoreEnv, "stage-report", params.ticker, runId)) : null;
  if (!artifact) return finish(null, `${outcome.reason}:${outcome.turns}`);
  await steps.do("report-save", async () => {
    const body: UserReport = { schemaVersion: "user-report.v1", id: runId, ticker: params.ticker, question: params.question, periodEnd: (await loadStageData(env, params.ticker))?.periodEnd ?? "", createdAt: now, locale: params.locale, artifact };
    const json = JSON.stringify(body);
    await db.prepare("INSERT OR REPLACE INTO user_reports (user_id, id, parent_id, conversation_id, ticker, locale, question, body, content_hash, run_id, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(params.userId, runId, params.conversationId, params.ticker, params.locale, params.question, json, await sha256(json), runId, now).run();
    return true;
  });
  return finish(runId, `${outcome.reason}:${outcome.turns}`);
}
