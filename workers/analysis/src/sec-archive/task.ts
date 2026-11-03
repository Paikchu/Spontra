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
/** A filing whose read failed is tried again this much later; the others go on meanwhile. */
const RETRY_MS = 15 * MINUTE;
type Attempts = { attempts: number; reason: string; retryAt: string };
/** A document over the archive's size cap never fits: recorded at once, not retried. */
const PERMANENT = new Set(["SEC_DOCUMENT_TOO_LARGE"]);

/**
 * Stores every filing the SEC report and the item analysis read (pipeline/filing-forms.ts `archivedForm`), so they read
 * every filing from the archive (docs/sec-archive.md); a document collection already stored is read back, not downloaded. The list comes from discovery's state in D1, newest first; a filing whose
 * documents are all stored is passed over, and each one stored emits `filing.archived` like any other. A filing that
 * cannot be stored (a document over the size cap, or one SEC fails to serve MAX_ATTEMPTS times) is recorded as
 * unsupported and the rest of the list goes on.
 */
export const ARCHIVE_TASKS = {
  archive: {
    version: "archive.v1",
    async run(env, ticker, { causeId, now }): Promise<TaskOutcome> {
      const db = env.DB!;
      const repository = new D1SecRepository(db);
      const state = (await repository.getCache<DiscoveryState>(discoveryStateKey(ticker)))?.payload;
      if (!state?.current?.length) return { status: "done", detail: { skipped: "no current reports to archive" } };
      const archive = { DB: db, SEC_FILINGS: env.SEC_FILINGS, SEC_USER_AGENT: env.SEC_USER_AGENT };
      // Pending: not stored yet, and not waiting out a failed read's retry delay; a filing waiting is tried after it.
      const pending = [], deferred: string[] = [];
      for (const filing of state.current) {
        if (!/^[A-Za-z0-9_.-]+\.html?$/.test(filing.document) || await repository.getCache(archiveCompleteKey(ticker, filing.accession))) continue;
        const tried = (await repository.getCache<Attempts>(archiveAttemptsKey(ticker, filing.accession)))?.payload;
        if (tried && Date.parse(tried.retryAt) > now.getTime()) { deferred.push(tried.retryAt); continue; }
        pending.push(filing);
      }
      const untilRetry = () => deferred.length ? Math.max(1000, Math.min(...deferred.map(at => Date.parse(at))) - now.getTime()) : null;
      if (!pending.length) return untilRetry() === null ? { status: "done", detail: { archived: 0 } } : { status: "later", afterMs: untilRetry()!, detail: { archived: 0, deferred: deferred.length } };
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
          const attempts = ((await repository.getCache<Attempts>(archiveAttemptsKey(ticker, filing.accession)))?.payload.attempts ?? 0) + 1;
          if (PERMANENT.has(reason) || attempts >= MAX_ATTEMPTS) {
            await repository.setCache(archiveCompleteKey(ticker, filing.accession), { unsupported: reason, attempts }, stamp);
            unsupported.push(filing.accession);
          } else {
            await repository.setCache(archiveAttemptsKey(ticker, filing.accession), { attempts, reason, retryAt: new Date(now.getTime() + RETRY_MS).toISOString() } satisfies Attempts, stamp);
            failed.push(filing.accession);
          }
          console.error(JSON.stringify({ event: "sec-archive-error", ticker, accession: filing.accession, attempts, reason }));
        }
      }
      const remaining = pending.length - archived.length - unsupported.length - failed.length;
      const detail = { archived, ...(unsupported.length ? { unsupported } : {}), ...(failed.length ? { failed } : {}), ...(deferred.length ? { deferred: deferred.length } : {}) };
      // The rest of the list goes on at once; a filing whose read failed waits out its delay, tried again after the others.
      if (remaining) return { status: "later", afterMs: 1000, detail: { ...detail, remaining } };
      const wait = failed.length ? RETRY_MS : untilRetry();
      return wait === null ? { status: "done", detail } : { status: "later", afterMs: wait, detail };
    },
  },
} satisfies Record<string, TaskImplementation>;
