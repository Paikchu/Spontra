import type Anthropic from "@anthropic-ai/sdk";
import { getAgentByName } from "agents";
import type { UserReport } from "../../../../shared/analysis-contract/user-report.ts";
import type { Locale } from "../../../../shared/analysis-runtime/locale.ts";
import { runAgentLoop, sequential, type LoopHost } from "../agent-loop.ts";
import { modelFor, reasoningFor } from "../ai-config.ts";
import { SecModelOutputError } from "../model-stream.ts";
import { callWorkerToolModel, type AnalysisEnv } from "../operations.ts";
import type { AgentMessage, AgentReply } from "../tool-loop.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import type { StageAgent } from "./agent.ts";
import { refund, reserve } from "./budget.ts";
import { loadStageData } from "./data.ts";
import { sha256 } from "./identity.ts";
import { reportDocuments, reportOpening, reportRecipe, type ReportInput } from "./report.ts";

export type ReportParams = { userId: string; address: string | null; conversationId: string; ticker: string; question: string; locale: Locale };
export type ReportOutcome = { runId: string; reportId: string | null; reason: string };
type StageEnv = AnalysisEnv & { StageAgent?: DurableObjectNamespace };

/**
 * One reader's report (docs/stage-agent-design.md §6.3): the report recipe run by the shared loop with every model
 * call and every outside read a durable step, so a restart replays what was done instead of paying for it again. The
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
  const data = await loadStageData(env, params.ticker);
  if (!data) return finish(null, "no-data");
  const now = await steps.do("report-time", async () => new Date().toISOString());
  const { documents, earlierAvailable } = await reportDocuments(env, params.ticker, data.periodEnd);
  const input: ReportInput = { env, data, question: params.question, locale: params.locale, documents, now, earlierAvailable };
  const recipe = reportRecipe(input);
  const state = recipe.open(input);
  const messages: AgentMessage[] = [{ role: "user", content: reportOpening(input) }];
  const userHash = await sha256(params.userId);
  let turn = 0;
  const act = (stage: string, system: string, tools: unknown[], msgs: AgentMessage[]): Promise<AgentReply> => steps.do(`${stage}-act`, async () => {
    try {
      return await callWorkerToolModel(env, fetch, stage, { system, tools: tools as Anthropic.Beta.BetaTool[], messages: msgs as Anthropic.Beta.BetaMessageParam[] }, modelFor(env, "analyst"), 4 * 60_000,
        { reasoning: reasoningFor(env, "analyst"), ticker: params.ticker, kind: "stage-report", runId, userHash, conversationId: params.conversationId });
    } catch (error) {
      if (error instanceof SecModelOutputError) return { error: `${error.code}: ${error.message}`.slice(0, 300) };
      throw error;
    }
  });
  const host: LoopHost<typeof state> = {
    reserve: () => { turn++; return steps.do(`report-reserve-${turn}`, async () => (await reserve(db, "stage-report-calls", { reader: params.userId, address: params.address })).ok); },
    record: () => {},
    execute: (_t, calls, run) => sequential(calls, run),
    stage: (name, work) => steps.do(name, work),
    signal: new AbortController().signal,
    now: () => Date.parse(now),
  };
  const outcome = await runAgentLoop(recipe, input, state, messages, act, host);
  const report = outcome.output;
  if (!report) return finish(null, `${outcome.reason}:${outcome.turns}`);
  await steps.do("report-save", async () => {
    const body: UserReport = { ...report, id: runId };
    const json = JSON.stringify(body);
    await db.prepare("INSERT OR REPLACE INTO user_reports (user_id, id, parent_id, conversation_id, ticker, locale, question, body, content_hash, run_id, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(params.userId, runId, params.conversationId, params.ticker, params.locale, params.question, json, await sha256(json), runId, now).run();
    return true;
  });
  return finish(runId, `${outcome.reason}:${outcome.turns}`);
}
