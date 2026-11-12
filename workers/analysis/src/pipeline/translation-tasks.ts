import { TRANSLATION_VERSION, translationPlan, readSources } from "../translation/translate.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { TaskImplementation, TaskOutcome } from "./tasks.ts";
import { driveWorkflow, failedInputOutcome } from "./workflow-task.ts";
import { translationScheduled } from "../translation/scheduling.ts";

/** Completed runs that left exactly the same strings untranslated before the task stops asking (a string the model
 * cannot translate fails the same way each time); a change in what is untranslated starts over. */
const STALLED_RUNS = 3;
const stalledKey = (ticker: string) => `translate:stalled:v1:${ticker}`;
export const TRANSLATION_TASKS = {
  /**
   * Translates the reader-facing prose of the company's publications into Chinese: one Workflow per change of what
   * is untranslated or of the strings a resource carries. A failed run is retried after a growing wait,
   * then dead-lettered (workflow-task.ts).
   */
  translate: {
    version: `${TRANSLATION_VERSION}:scheduled-publication.v2`,
    async run(env, ticker, { now, causeId, trigger }): Promise<TaskOutcome> {
      if (env.TRANSLATION_ENABLED === "false" || !env.DEEPSEEK_API_KEY) return { status: "done", detail: { skipped: "translation disabled" } };
      const outcome = await driveWorkflow(env, `translate:${ticker}`, env.TRANSLATE_WORKFLOW, async () => {
        if (!await translationScheduled(env, ticker)) return { status: "later", afterMs: 1000, detail: { waiting: "scheduled translation paused" } };
        const plan = await translationPlan(env.DB!, ticker, "zh-CN", () => readSources(env.DB!, ticker, env));
        if (!plan) return null;
        const stalled = (await new D1SecRepository(env.DB!).getCache<{ fingerprint: string; runs: number }>(stalledKey(ticker)))?.payload;
        if (stalled?.fingerprint === plan.fingerprint && stalled.runs >= STALLED_RUNS) return { status: "done", detail: { skipped: "the same strings stayed untranslated after repeated runs" } };
        const failed = await failedInputOutcome(env, "translate", ticker, plan.fingerprint, now);
        if (failed) return failed;
        return { id: `translate-${ticker.replace(/[^A-Za-z0-9]/g, "-")}-${plan.fingerprint.slice(0, 16)}-${now.getTime()}`, params: { ticker, fingerprint: plan.fingerprint }, fingerprint: plan.fingerprint };
      }, { deadLetter: { task: "translate", ticker, causeId }, pollMs: 2 * 60_000, trigger });
      // Retry remaining work after model unavailability or a publication that changed during the run.
      // A new publication brings its own event sooner.
      if (outcome.status === "done" && (outcome.detail as { workflow?: string } | undefined)?.workflow === "complete") {
        if (!await translationScheduled(env, ticker)) return { status: "later", afterMs: 1000, detail: { waiting: "scheduled translation paused" } };
        const remaining = await translationPlan(env.DB!, ticker, "zh-CN", () => readSources(env.DB!, ticker, env));
        const repository = new D1SecRepository(env.DB!);
        if (!remaining) { await env.DB!.prepare("DELETE FROM sec_cache WHERE cache_key = ?").bind(stalledKey(ticker)).run(); return outcome; }
        const previous = (await repository.getCache<{ fingerprint: string; runs: number }>(stalledKey(ticker)))?.payload;
        const runs = previous?.fingerprint === remaining.fingerprint ? previous.runs + 1 : 1;
        await repository.setCache(stalledKey(ticker), { fingerprint: remaining.fingerprint, runs }, now.toISOString());
        if (runs >= STALLED_RUNS) return { status: "done", detail: { remaining: true, stalled: runs } };
        return { status: "later", afterMs: 30 * 60_000, detail: { remaining: true, runs } };
      }
      return outcome;
    },
  },
} satisfies Partial<Record<"translate", TaskImplementation>>;
