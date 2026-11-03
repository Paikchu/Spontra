import { readFilingDocuments } from "../financial-data/provider.ts";
import type { AnalysisEnv } from "../operations.ts";
import { discoveryStateKey, type DiscoveryState } from "../pipeline/discovery.ts";
import type { TaskImplementation, TaskOutcome } from "../pipeline/tasks.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { archiveDocuments, archivingReader } from "./archive.ts";
import { secArchiveDocumentUrl, secArchiveRoot } from "../../../../shared/analysis-runtime/sec-sources.ts";

const MINUTE = 60_000;
/** Filings stored per run; the rest follow at once in the next run. */
const PER_RUN = 2;
const secAccessPaused = (error: unknown) => error instanceof Error && error.message === "SEC_ACCESS_PAUSED";
/** Written once a filing's body and exhibits are all stored (or the filing is recorded as one that cannot be); a run interrupted between documents stores the rest next time. */
export const archiveCompleteKey = (ticker: string, accession: string) => `sec-archive:complete:v1:${ticker}:${accession}`;
const archiveAttemptsKey = (ticker: string, accession: string) => `sec-archive:attempts:v1:${ticker}:${accession}`;
/** Failed reads of one filing before it is recorded as unsupported, so a filing SEC never serves does not hold the others up. */
const MAX_ATTEMPTS = 5;
/** A document over the archive's size cap never fits: recorded at once, not retried. */
const PERMANENT = new Set(["SEC_DOCUMENT_TOO_LARGE"]);

/**
 * Stores every current report, 40-F and prospectus supplement (pipeline/filing-forms.ts `archivedForm`), so the SEC
 * report and the item analysis read every filing from the archive (docs/sec-archive.md); a document collection already
 * stored is read back, not downloaded. The list comes from discovery's state in D1, newest first; a filing whose
 * documents are all stored is passed over, and each one stored emits `filing.archived` like any other. A filing that
 * cannot be stored (a document over the size cap, or one SEC fails to serve MAX_ATTEMPTS times) is recorded as
 * unsupported and the rest of the list goes on.
 */
export const ARCHIVE_TASKS = {
  archive: {
    version: "archive.v1",
    async run(env, ticker, { causeId }): Promise<TaskOutcome> {
      const db = env.DB!;
      const repository = new D1SecRepository(db);
      const state = (await repository.getCache<DiscoveryState>(discoveryStateKey(ticker)))?.payload;
      if (!state?.current?.length) return { status: "done", detail: { skipped: "no current reports to archive" } };
      const archive = { DB: db, SEC_FILINGS: env.SEC_FILINGS, SEC_USER_AGENT: env.SEC_USER_AGENT };
      const pending = [];
      for (const filing of state.current) if (/^[A-Za-z0-9_.-]+\.html?$/.test(filing.document) && !await repository.getCache(archiveCompleteKey(ticker, filing.accession))) pending.push(filing);
      if (!pending.length) return { status: "done", detail: { archived: 0 } };
      const reader = archivingReader(archive, ticker, causeId);
      const archived: string[] = [], unsupported: string[] = [], failed: string[] = [];
      for (const filing of pending.slice(0, PER_RUN)) {
        const stamp = new Date().toISOString();
        try {
          const url = secArchiveDocumentUrl(secArchiveRoot(Number(state.cik), filing.accession), filing.document);
          // No form: a 6-K notice is read with its exhibits (the announcement is in them), not as the collector reads it.
          const documents = await readFilingDocuments(url, reader, filing.accession);
          await archiveDocuments(reader, { accession: filing.accession, filedAt: filing.filingDate, cik: state.cik, industry: "unknown" }, documents, { form: filing.form, reportDate: filing.reportDate });
          await repository.setCache(archiveCompleteKey(ticker, filing.accession), { documents: documents.length }, stamp);
          archived.push(filing.accession);
        } catch (error) {
          if (secAccessPaused(error)) return { status: "later", afterMs: 15 * MINUTE, detail: { waiting: "SEC access paused", archived, unsupported, failed } };
          const reason = error instanceof Error ? error.message.slice(0, 200) : String(error);
          const attempts = ((await repository.getCache<{ attempts: number }>(archiveAttemptsKey(ticker, filing.accession)))?.payload.attempts ?? 0) + 1;
          if (PERMANENT.has(reason) || attempts >= MAX_ATTEMPTS) {
            await repository.setCache(archiveCompleteKey(ticker, filing.accession), { unsupported: reason, attempts }, stamp);
            unsupported.push(filing.accession);
          } else {
            await repository.setCache(archiveAttemptsKey(ticker, filing.accession), { attempts, reason }, stamp);
            failed.push(filing.accession);
          }
          console.error(JSON.stringify({ event: "sec-archive-error", ticker, accession: filing.accession, attempts, reason }));
        }
      }
      const remaining = pending.length - archived.length - unsupported.length - failed.length;
      const detail = { archived, ...(unsupported.length ? { unsupported } : {}), ...(failed.length ? { failed } : {}) };
      // A read that failed on the way is tried again after a pause; the rest of the list goes on at once.
      if (remaining) return { status: "later", afterMs: 1000, detail: { ...detail, remaining } };
      return failed.length ? { status: "later", afterMs: 15 * MINUTE, detail } : { status: "done", detail };
    },
  },
} satisfies Record<string, TaskImplementation>;
