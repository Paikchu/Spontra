import { LIBRARY_PARSER_VERSION } from "../../../../shared/analysis-runtime/filing-library/parse.ts";
import { LIBRARY_CARD_VERSION } from "../../../../shared/analysis-runtime/filing-library/cards.ts";
import { LIBRARY_LINKS_VERSION } from "../../../../shared/analysis-runtime/filing-library/links.ts";
import { pendingCardPlan } from "../filing-library/cards.ts";
import { linkInput, linksCacheKey } from "../filing-library/links.ts";
import { searchEnabled, syncSearchItems } from "../filing-library/search.ts";
import { STORAGE_SWEEP_VERSION, sweepStorage } from "../storage/sweep.ts";
import { prepareLibraryDocument } from "../filing-library/prepare.ts";
import { pendingLibraryDocuments } from "../filing-library/store.ts";
import type { TaskImplementation, TaskOutcome } from "./tasks.ts";
import { driveWorkflow, failedInputOutcome } from "./workflow-task.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { BUSINESS_TAGS_VERSION } from "../../../../shared/analysis-runtime/business-tags.ts";
import { tagsCacheKey, tagsPlan } from "../business-tags/input.ts";

/** Source bytes and wall time one run spends; what is left is split by the next run, right away. */
const BYTE_BUDGET = 24_000_000, TIME_BUDGET_MS = 60_000, BATCH = 60;

export const LIBRARY_TASKS = {
  /**
   * Splits the company's archived documents that have no rows for this parser version and source into the filing
   * library, oldest first so each is compared with its prepared predecessor. A new parser version re-splits every
   * company once; ids of unchanged text survive it.
   */
  library: {
    version: LIBRARY_PARSER_VERSION,
    async run(env, ticker, { causeId }): Promise<TaskOutcome> {
      if (env.FILING_LIBRARY_ENABLED === "false") return { status: "done", detail: { skipped: "filing library disabled" } };
      const started = Date.now();
      const pending = await pendingLibraryDocuments(env.DB!, LIBRARY_PARSER_VERSION, BATCH, ticker);
      const detail = { prepared: 0, unreadable: 0, superseded: 0, bytes: 0, pending: pending.length };
      for (const document of pending) {
        if (detail.prepared + detail.unreadable && (detail.bytes + document.bytes > BYTE_BUDGET || Date.now() - started > TIME_BUDGET_MS)) {
          return { status: "later", afterMs: 1000, detail };
        }
        const result = await prepareLibraryDocument(env, document, causeId);
        if (result.status === "ready") detail.prepared++; else if (result.status === "superseded") detail.superseded++; else detail.unreadable++;
        detail.bytes += document.bytes;
      }
      return pending.length === BATCH ? { status: "later", afterMs: 1000, detail } : { status: "done", detail };
    },
  },

  /**
   * Index cards for the sections of the company's recent documents: one Workflow per change of what needs a card,
   * so a document split again with the same text starts nothing. A failed run is retried after a growing wait, then dead-lettered.
   */
  "library-cards": {
    version: LIBRARY_CARD_VERSION,
    async run(env, ticker, { now, causeId, trigger }): Promise<TaskOutcome> {
      if (env.LIBRARY_CARDS_ENABLED === "false" || !env.ANTHROPIC_API_KEY) return { status: "done", detail: { skipped: "index cards disabled" } };
      return driveWorkflow(env, `library-cards:${ticker}`, env.LIBRARY_CARDS_WORKFLOW, async () => {
        const plan = await pendingCardPlan(env.DB!, ticker);
        if (!plan) return null;
        const failed = await failedInputOutcome(env, "library-cards", ticker, plan.fingerprint, now);
        if (failed) return failed;
        return { id: `library-cards-${ticker.replace(/[^A-Za-z0-9]/g, "-")}-${plan.fingerprint.slice(0, 16)}-${now.getTime()}`, params: { ticker, fingerprint: plan.fingerprint }, fingerprint: plan.fingerprint };
      }, { deadLetter: { task: "library-cards", ticker, causeId }, trigger });
    },
  },

  /**
   * Business links: which sections describe each of the company's businesses, and the cross-company category it
   * belongs to. One Workflow per change of the annual report's cards or the map's businesses; confirmed links are
   * changed only by an admin.
   */
  "library-links": {
    version: LIBRARY_LINKS_VERSION,
    async run(env, ticker, { now, causeId, trigger }): Promise<TaskOutcome> {
      if (env.LIBRARY_CARDS_ENABLED === "false" || !env.ANTHROPIC_API_KEY) return { status: "done", detail: { skipped: "index cards disabled" } };
      return driveWorkflow(env, `library-links:${ticker}`, env.LIBRARY_LINKS_WORKFLOW, async () => {
        const input = await linkInput(env.DB!, ticker);
        if (!input) return null;
        if ((await new D1SecRepository(env.DB!).getCache<{ fingerprint: string }>(linksCacheKey(ticker)))?.payload?.fingerprint === input.fingerprint) return null;
        const failed = await failedInputOutcome(env, "library-links", ticker, input.fingerprint, now);
        if (failed) return failed;
        return { id: `library-links-${ticker.replace(/[^A-Za-z0-9]/g, "-")}-${input.fingerprint.slice(0, 16)}-${now.getTime()}`, params: { ticker, fingerprint: input.fingerprint }, fingerprint: input.fingerprint };
      }, { deadLetter: { task: "library-links", ticker, causeId }, trigger });
    },
  },

  /**
   * Comparable units, their sector tags and business tags, and the pairs they make with other companies'
   * (docs/peer-similarity-design.md): one Workflow per change of the company's links or map businesses.
   */
  "business-tags": {
    version: BUSINESS_TAGS_VERSION,
    async run(env, ticker, { now, causeId, trigger }): Promise<TaskOutcome> {
      if (env.BUSINESS_TAGS_ENABLED === "false" || !env.ANTHROPIC_API_KEY) return { status: "done", detail: { skipped: "business tags disabled" } };
      return driveWorkflow(env, `business-tags:${ticker}`, env.BUSINESS_TAGS_WORKFLOW, async () => {
        const plan = await tagsPlan(env.DB!, ticker);
        if (!plan) return null;
        if ((await new D1SecRepository(env.DB!).getCache<{ fingerprint: string }>(tagsCacheKey(ticker)))?.payload?.fingerprint === plan.fingerprint) return null;
        const failed = await failedInputOutcome(env, "business-tags", ticker, plan.fingerprint, now);
        if (failed) return failed;
        return { id: `business-tags-${ticker.replace(/[^A-Za-z0-9]/g, "-")}-${plan.fingerprint.slice(0, 16)}-${now.getTime()}`, params: { ticker, fingerprint: plan.fingerprint }, fingerprint: plan.fingerprint };
      }, { deadLetter: { task: "business-tags", ticker, causeId }, trigger });
    },
  },

  /** The recall layer: uploads what changed among the carded sections and deletes what left them, within a budget per run. */
  "library-search": {
    version: "library-search.v1",
    async run(env, ticker): Promise<TaskOutcome> {
      if (!searchEnabled(env)) return { status: "done", detail: { skipped: "recall layer not configured" } };
      const result = await syncSearchItems(env, ticker);
      return result.remaining ? { status: "later", afterMs: 1000, detail: result } : { status: "done", detail: result };
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
