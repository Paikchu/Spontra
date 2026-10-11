import { LIBRARY_PARSER_VERSION } from "../../../../shared/analysis-runtime/filing-library/parse.ts";
import { prepareLibraryDocument } from "../filing-library/prepare.ts";
import { pendingLibraryDocuments } from "../filing-library/store.ts";
import type { TaskImplementation, TaskOutcome } from "./tasks.ts";

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
} satisfies Record<string, TaskImplementation>;
