import { readFilingDocuments } from "../financial-data/provider.ts";
import type { AnalysisEnv } from "../operations.ts";
import { discoveryStateKey, type DiscoveryState } from "../pipeline/discovery.ts";
import type { TaskImplementation, TaskOutcome } from "../pipeline/tasks.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { archiveDocuments, archiveHolds, archivingReader } from "./archive.ts";
import { archiveRoot } from "./gateway.ts";

const MINUTE = 60_000;
/** Filings stored per run; the rest follow at once in the next run. */
const PER_RUN = 2;
const secAccessPaused = (error: unknown) => error instanceof Error && error.message === "SEC_ACCESS_PAUSED";

/**
 * Stores the current reports collection does not read (8-Ks without Item 2.02), so the SEC report reads every filing
 * it analyses from the archive (docs/sec-archive.md). The list comes from discovery's state in D1, newest first; a
 * filing already archived is passed over, and each one stored emits `filing.archived` like any other.
 */
export const ARCHIVE_TASKS = {
  archive: {
    version: "archive.v1",
    async run(env, ticker, { causeId }): Promise<TaskOutcome> {
      const db = env.DB!;
      const state = (await new D1SecRepository(db).getCache<DiscoveryState>(discoveryStateKey(ticker)))?.payload;
      if (!state?.current?.length) return { status: "done", detail: { skipped: "no current reports to archive" } };
      const archive = { DB: db, SEC_FILINGS: env.SEC_FILINGS, SEC_USER_AGENT: env.SEC_USER_AGENT };
      const pending = [];
      for (const filing of state.current) if (/^[A-Za-z0-9_.-]+\.html?$/.test(filing.document) && !await archiveHolds(archive, ticker, filing.accession)) pending.push(filing);
      if (!pending.length) return { status: "done", detail: { archived: 0 } };
      const reader = archivingReader(archive, ticker, causeId);
      const archived: string[] = [];
      try {
        for (const filing of pending.slice(0, PER_RUN)) {
          const url = `${archiveRoot(Number(state.cik), filing.accession)}/${filing.document}`;
          const documents = await readFilingDocuments(url, reader, filing.accession, filing.form);
          await archiveDocuments(reader, { accession: filing.accession, filedAt: filing.filingDate, cik: state.cik, industry: "unknown" }, documents, { form: filing.form, reportDate: filing.reportDate });
          archived.push(filing.accession);
        }
      } catch (error) {
        if (secAccessPaused(error)) return { status: "later", afterMs: 15 * MINUTE, detail: { waiting: "SEC access paused", archived } };
        throw error;
      }
      const remaining = pending.length - archived.length;
      return remaining ? { status: "later", afterMs: 1000, detail: { archived, remaining } } : { status: "done", detail: { archived } };
    },
  },
} satisfies Record<string, TaskImplementation>;
