import type { SecPipelineEnv } from "../operations.ts";
import { callWorkerSecModel } from "../operations.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { createWebSearch, TavilyProvider } from "../web-search/index.ts";
import { investigate } from "./engine.ts";
import { ResearchRepository } from "./repository.ts";

export function researchSearch(env: SecPipelineEnv) {
  if (!env.DB || !env.TAVILY_API_KEY) throw new Error("research_search_not_configured");
  return createWebSearch({ database: env.DB, provider: new TavilyProvider(env.TAVILY_API_KEY), bucket: {
    async get(key) {
      const object = await env.SEC_FILINGS.get(key);
      return object ? { async json<T>() { return JSON.parse(await object.text()) as T; } } : null;
    },
    put: (key, value) => env.SEC_FILINGS.put(key, value),
  } });
}

export async function executeResearchWorkflow(caseId: string, step: WorkflowStepLike, env: SecPipelineEnv) {
  if (!env.DB) throw new Error("research_storage_missing");
  const repo = new ResearchRepository(env.DB);
  const now = await step.do("freeze-research-time", async () => new Date().toISOString());
  try {
    const reserved = await step.do("reserve-research-budget", () => repo.reserveBudget(now.slice(0, 10), 24));
    if (!reserved) {
      await step.do("record-budget-exhausted", () => repo.finishWithoutReport(caseId, "budget_exhausted", now));
      return { status: "budget_exhausted" };
    }
    const input = await step.do("freeze-research-input", async () => {
      const event = await repo.event(caseId);
      if (!event) throw new Error("research_event_missing");
      return { event, previous: await repo.latest(event.ticker) };
    });
    const report = await step.do("investigate-event", () => investigate({ ...input, now, search: researchSearch(env),
      model: (stage, system, payload) => callWorkerSecModel(env, fetch, stage, system, payload, undefined, 5 * 60_000),
    }));
    if (!report) {
      await step.do("record-no-material-update", () => repo.finishWithoutReport(caseId, "quiet", now));
      return { status: "quiet" };
    }
    await step.do("publish-research-report", () => repo.publish(report));
    return { status: "published", reportId: report.id };
  } catch (error) {
    await repo.finishWithoutReport(caseId, "failed", new Date().toISOString());
    throw error;
  }
}
