import { TRANSLATION_VERSION, translationPlan } from "../translation/translate.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { SecPipelineEnv } from "../operations.ts";
import type { TaskImplementation, TaskOutcome } from "./tasks.ts";
import { driveWorkflow, failedInputOutcome } from "./workflow-task.ts";

const DEFAULT_DAILY_CALLS = 300;
/** Completed runs that left exactly the same strings untranslated before the task stops asking (a string the model
 * cannot translate fails the same way each time); a change in what is untranslated starts over. */
const STALLED_RUNS = 3;
const stalledKey = (ticker: string) => `translate:stalled:v1:${ticker}`;
/** Whether the translator has used up today's model calls across all companies. */
async function budgetSpent(env: SecPipelineEnv, now: Date): Promise<boolean> {
  const cap = Number(env.TRANSLATION_DAILY_CALLS) || DEFAULT_DAILY_CALLS;
  const row = await env.DB!.prepare("SELECT units FROM feature_budget WHERE day = ? AND feature = 'translate-calls'").bind(now.toISOString().slice(0, 10)).first<{ units: number }>().catch(() => null);
  return (row?.units ?? 0) >= cap;
}
/** Until a minute past the next UTC midnight, when the day's calls are available again. */
const untilTomorrow = (now: Date) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1) - now.getTime();

export const TRANSLATION_TASKS = {
  /**
   * Translates the reader-facing prose of the company's publications into Chinese: one Workflow per change of what
   * is untranslated or of the strings a resource carries. A run that stops on the day's budget comes back the next
   * UTC day; a failed run is retried after a growing wait, then dead-lettered (workflow-task.ts).
   */
  translate: {
    version: TRANSLATION_VERSION,
    async run(env, ticker, { now, causeId, trigger }): Promise<TaskOutcome> {
      if (env.TRANSLATION_ENABLED === "false" || !env.ANTHROPIC_API_KEY) return { status: "done", detail: { skipped: "translation disabled" } };
      const outcome = await driveWorkflow(env, `translate:${ticker}`, env.TRANSLATE_WORKFLOW, async () => {
        if (await budgetSpent(env, now)) return { status: "later", afterMs: untilTomorrow(now), detail: { waiting: "daily translation budget" } };
        const plan = await translationPlan(env.DB!, ticker);
        if (!plan) return null;
        const stalled = (await new D1SecRepository(env.DB!).getCache<{ fingerprint: string; runs: number }>(stalledKey(ticker)))?.payload;
        if (stalled?.fingerprint === plan.fingerprint && stalled.runs >= STALLED_RUNS) return { status: "done", detail: { skipped: "the same strings stayed untranslated after repeated runs" } };
        const failed = await failedInputOutcome(env, "translate", ticker, plan.fingerprint, now);
        if (failed) return failed;
        return { id: `translate-${ticker.replace(/[^A-Za-z0-9]/g, "-")}-${plan.fingerprint.slice(0, 16)}-${now.getTime()}`, params: { ticker, fingerprint: plan.fingerprint }, fingerprint: plan.fingerprint };
      }, { deadLetter: { task: "translate", ticker, causeId }, pollMs: 2 * 60_000, trigger });
      // A finished run leaves work when the budget stopped it, the model was unavailable, or the publications changed
      // while it ran: tomorrow for the budget, otherwise in half an hour (a new publication brings its own event sooner).
      if (outcome.status === "done" && (outcome.detail as { workflow?: string } | undefined)?.workflow === "complete") {
        const remaining = await translationPlan(env.DB!, ticker);
        const repository = new D1SecRepository(env.DB!);
        if (!remaining) { await env.DB!.prepare("DELETE FROM sec_cache WHERE cache_key = ?").bind(stalledKey(ticker)).run(); return outcome; }
        if (await budgetSpent(env, now)) return { status: "later", afterMs: untilTomorrow(now), detail: { remaining: true, waiting: "daily translation budget" } };
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
