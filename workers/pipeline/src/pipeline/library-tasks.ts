import { LIBRARY_PARSER_VERSION } from "../../../../shared/analysis-runtime/filing-library/parse.ts";
import { LIBRARY_CARD_VERSION } from "../../../../shared/analysis-runtime/filing-library/cards.ts";
import { pendingCardPlan } from "../filing-library/cards.ts";
import { prepareLibraryDocument } from "../filing-library/prepare.ts";
import { pendingLibraryDocuments } from "../filing-library/store.ts";
import type { TaskImplementation, TaskOutcome } from "./tasks.ts";
import { driveWorkflow, failedInputKey } from "./workflow-task.ts";
import { D1SecRepository } from "../sec/d1.ts";

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
   * so a document split again with the same text starts nothing. A failed run is a dead letter, not retried on the same input.
   */
  "library-cards": {
    version: LIBRARY_CARD_VERSION,
    async run(env, ticker, { now, causeId }): Promise<TaskOutcome> {
      if (env.LIBRARY_CARDS_ENABLED === "false" || !env.DEEPSEEK_API_KEY) return { status: "done", detail: { skipped: "index cards disabled" } };
      return driveWorkflow(env, `library-cards:${ticker}`, env.LIBRARY_CARDS_WORKFLOW, async () => {
        const plan = await pendingCardPlan(env.DB!, ticker);
        if (!plan) return null;
        const failed = (await new D1SecRepository(env.DB!).getCache<{ fingerprint: string }>(failedInputKey("library-cards", ticker)))?.payload?.fingerprint;
        if (failed === plan.fingerprint) return { status: "done", detail: { skipped: "failed on this input before; replay the dead letter to retry" } };
        return { id: `library-cards-${ticker.replace(/[^A-Za-z0-9]/g, "-")}-${plan.fingerprint.slice(0, 16)}-${now.getTime()}`, params: { ticker, fingerprint: plan.fingerprint }, fingerprint: plan.fingerprint };
      }, { deadLetter: { task: "library-cards", ticker, causeId } });
    },
  },
} satisfies Record<string, TaskImplementation>;
