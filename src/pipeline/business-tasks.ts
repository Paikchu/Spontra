import { BUSINESS_CLASSIFICATION_VERSION, linkInput, linksCacheKey } from "../domains/business-map/classification";
import { STORAGE_SWEEP_VERSION, sweepStorage } from "../lib/storage/sweep.ts";
import type { TaskImplementation, TaskOutcome } from "./tasks.ts";
import { driveWorkflow, failedInputOutcome } from "./workflow-task.ts";
import { D1SecRepository } from "../domains/filing-analysis/sec/d1.ts";
import { BUSINESS_TAGS_VERSION, PEER_MATCH_VERSION } from "../domains/business-map/tags-runtime.ts";
import { matchCompany } from "../domains/business-map/tags/match.ts";
import { tagsCacheKey, tagsPlan, tagsSkipReason } from "../domains/business-map/tags/input.ts";

export const BUSINESS_TASKS = {
  "business-classification": {
    version: BUSINESS_CLASSIFICATION_VERSION,
    async run(env, ticker, { now, causeId, trigger }): Promise<TaskOutcome> {
      if (!env.DEEPSEEK_API_KEY) return { status: "done", detail: { skipped: "model not configured" } };
      return driveWorkflow(env, `business-classification:${ticker}`, env.BUSINESS_CLASSIFICATION_WORKFLOW, async () => {
        const input = await linkInput(env, ticker);
        if (!input) return null;
        if ((await new D1SecRepository(env.DB!).getCache<{ fingerprint: string }>(linksCacheKey(ticker)))?.payload?.fingerprint === input.fingerprint) return null;
        const failed = await failedInputOutcome(env, "business-classification", ticker, input.fingerprint, now);
        if (failed) return failed;
        return { id: `business-classification-${ticker.replace(/[^A-Za-z0-9]/g, "-")}-${input.fingerprint.slice(0, 16)}-${now.getTime()}`, params: { ticker, fingerprint: input.fingerprint }, fingerprint: input.fingerprint };
      }, { deadLetter: { task: "business-classification", ticker, causeId }, trigger });
    },
  },
  /**
   * Comparable units, their sector tags and business tags, and the pairs they make with other companies'
   *: one Workflow per change of the company's links or map businesses.
   */
  "business-tags": {
    version: `${BUSINESS_TAGS_VERSION}+${PEER_MATCH_VERSION}`,
    async run(env, ticker, { now, causeId, trigger }): Promise<TaskOutcome> {
      if (env.BUSINESS_TAGS_ENABLED === "false" || !env.DEEPSEEK_API_KEY) return { status: "done", detail: { skipped: "business tags disabled" } };
      return driveWorkflow(env, `business-tags:${ticker}`, env.BUSINESS_TAGS_WORKFLOW, async () => {
        const plan = await tagsPlan(env.DB!, ticker);
        if (!plan) return { status: "done", detail: { skipped: await tagsSkipReason(env.DB!, ticker) } };
        const repository = new D1SecRepository(env.DB!);
        const stored = (await repository.getCache<{ fingerprint: string; matchVersion?: string }>(tagsCacheKey(ticker)))?.payload;
        if (stored?.fingerprint === plan.fingerprint) {
          // The tags stand; only how they are compared changed: match again from the stored tags, no model.
          if (stored.matchVersion === PEER_MATCH_VERSION) return null;
          const matched = await matchCompany(env, ticker, now);
          await repository.setCache(tagsCacheKey(ticker), { ...stored, matchVersion: PEER_MATCH_VERSION }, now.toISOString());
          return { status: "done", detail: { rematched: matched } };
        }
        const failed = await failedInputOutcome(env, "business-tags", ticker, plan.fingerprint, now);
        if (failed) return failed;
        return { id: `business-tags-${ticker.replace(/[^A-Za-z0-9]/g, "-")}-${plan.fingerprint.slice(0, 16)}-${now.getTime()}`, params: { ticker, fingerprint: plan.fingerprint }, fingerprint: plan.fingerprint };
      }, { deadLetter: { task: "business-tags", ticker, causeId }, trigger });
    },
  },

  /** The daily storage sweep (`storage/sweep.ts`); a trigger within a day of the last full pass does nothing. */
  "storage-sweep": {
    version: STORAGE_SWEEP_VERSION,
    async run(env, _ticker, { now }): Promise<TaskOutcome> {
      if (env.STORAGE_SWEEP_ENABLED === "false") return { status: "done", detail: { skipped: "storage sweep disabled" } };
      const repository = new D1SecRepository(env.DB!);
      const last = (await repository.getCache<{ at: string; version: string }>("storage-sweep:v1:last"))?.payload;
      const resuming = !!(await repository.getCache("storage-sweep:v1:cursor"))?.payload;
      if (!resuming && last?.version === STORAGE_SWEEP_VERSION && now.getTime() - Date.parse(last.at) < 20 * 60 * 60_000) return { status: "done", detail: { skipped: "swept within the last day", last: last.at } };
      const result = await sweepStorage(env, now.getTime());
      if (!result.done) return { status: "later", afterMs: 1000, detail: result };
      await repository.setCache("storage-sweep:v1:last", { at: now.toISOString(), version: STORAGE_SWEEP_VERSION }, now.toISOString());
      return { status: "done", detail: result };
    },
  },
} satisfies Record<string, TaskImplementation>;
