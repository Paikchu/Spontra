import { isOfferingForm, isProspectusSupplement, isProxyForm } from "../../../../shared/analysis-runtime/events.ts";
import { issuerDirectory, refreshListings } from "../catalog/issuer-directory.ts";
import { secArchiveDocumentUrl, secArchiveRoot } from "../../../../shared/analysis-runtime/sec-sources.ts";
import { edgarListings } from "../sec-archive/index.ts";
import { archivedForm, collectedForm, reportedForm } from "./filing-forms.ts";
import type { AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { knownCik } from "./identity.ts";
import { outboxStatement } from "./outbox.ts";
import { scopeTickers } from "./router.ts";
import { scheduledAnalysisPauses } from "./scheduled-analysis.ts";
import { requestFilingMaterial } from "../filing-material/index.ts";

export const DISCOVERY_HEARTBEAT_KEY = "pipeline:discovery-heartbeat";
export const DISCOVERY_STATE_PREFIX = "sec:discovery:v1:";
export const discoveryStateKey = (ticker: string) => `${DISCOVERY_STATE_PREFIX}${ticker}`;
/** Forms something downstream reads: periodic reports, current reports and insider transactions with amendments, offerings and proxies. */
const ANNOUNCED = (form: string) => /^(?:10-[QK]|20-F|40-F|6-K|8-K|4)(?:\/A)?$/.test(form) || isOfferingForm(form) || isProxyForm(form);
const REMEMBERED = 200;

/**
 * `collectable`: accessions of the filings collection reads (periodic reports, 6-Ks, earnings 8-Ks), newest first; `collected`
 * the same filings with what reading one needs, so collection depends on no other writer's index (a data-only issuer has none).
 * `fiscalYearEnd` (`MMDD`) and `name` are the issuer's as its submissions state them; EDGAR leaves the year end out for some foreign issuers.
 * `annualForm`: the form of its latest annual report ("10-K", "20-F", "40-F"), so a foreign issuer reads as one before any filing is collected.
 * `current`: the current reports and 40-Fs the `archive` task stores (pipeline/filing-forms.ts), whether or not collection reads them too.
 */
export type CollectableFiling = { accession: string; form: string; filedAt: string; reportDate: string | null; url: string };
export type DiscoveryState = { cik: string; accessions: string[]; checkedAt: string; collectable?: string[]; collected?: CollectableFiling[]; fiscalYearEnd?: string | null; name?: string | null; annualForm?: string | null; current?: DiscoveredFiling[] };
export type DiscoveredFiling = { accession: string; form: string; items: string; filingDate: string; reportDate: string; document: string };
const COLLECTED = (f: { form: string; items: string }) => collectedForm(f.form, f.items);
const CURRENT = (f: { form: string }) => archivedForm(f.form);


type Filing = { accession: string; form: string; items: string; filingDate: string; reportDate: string; primaryDocument: string };

function recentFilings(payload: unknown): Filing[] {
  const recent = (payload as { filings?: { recent?: Record<string, unknown[]> } } | null)?.filings?.recent;
  if (!recent || !Array.isArray(recent.accessionNumber)) return [];
  const column = (name: string, i: number) => String((recent[name] as unknown[] | undefined)?.[i] ?? "");
  return recent.accessionNumber.map((_, i) => ({
    accession: column("accessionNumber", i), form: column("form", i), items: column("items", i), filingDate: column("filingDate", i),
    reportDate: column("reportDate", i), primaryDocument: column("primaryDocument", i),
  })).filter(f => /^\d{10}-\d{2}-\d{6}$/.test(f.accession));
}

/** The form of the issuer's latest annual report in its whole recent list, amendments read as the report they amend. */
function annualForm(payload: unknown): string | null {
  const forms = (payload as { filings?: { recent?: { form?: unknown[] } } } | null)?.filings?.recent?.form;
  const form = Array.isArray(forms) ? forms.map(String).find(f => /^(?:10-K|20-F|40-F)(?:\/A)?$/.test(f)) : undefined;
  return form ? form.replace(/\/A$/, "") : null;
}

/**
 * The pipeline's only Cron. EDGAR pushes nothing, so every data company's submission list is read and compared with
 * the accessions seen last time; each new filing becomes a `filing.discovered` event, written in the same batch as
 * the new state. A company seen for the first time only records its baseline; one the pipeline has never collected
 * also has its first collection requested (`company.added`, `collection.requested`). Writes a heartbeat when done, and
 * fails the invocation when no company could be read, so an outage raises the Worker's error notification.
 * While scheduled analysis is off for a company its listings stay current for manual runs, but no event is written and
 * the accessions seen stay as they were, so the first sweep after it is on again announces what was filed meanwhile; a
 * company without a baseline waits for that sweep too.
 */
export async function runSecDiscovery(env: AnalysisEnv, now = new Date(), fetcher: typeof fetch = fetch) {
  const db = env.DB!;
  const repository = new D1SecRepository(db);
  const listings = edgarListings(env, { fetcher });
  const pauses = await scheduledAnalysisPauses(db);
  const result = { paused: [] as string[], checked: 0, discovered: [] as string[], baseline: [] as string[], bootstrapped: [] as string[], unknown: [] as string[], failed: [] as string[] };
  // The two reference directories (catalog/issuer-directory.ts) are read here at most once a day; every other reader
  // uses the stored copies. EDGAR's names the CIK of a company the pipeline has not collected yet.
  let directory: Promise<Record<string, string>> | null = null;
  const ciks = () => directory ??= issuerDirectory(db, listings, now).then(entries => Object.fromEntries(entries.filter(e => e[3]).map(e => [e[0], e[3]])));
  await Promise.all([ciks().catch(() => undefined), refreshListings(db, fetcher, now).catch(() => undefined)]);
  for (const ticker of await scopeTickers(env, "map")) {
    const announcing = pauses.at(ticker) === null;
    if (!announcing) result.paused.push(ticker);
    let cik = await knownCik(db, ticker);
    let bootstrap = false;
    // A company on the data list the pipeline has never collected: its CIK comes from EDGAR's issuer directory, and
    // its first collection is asked for in the same batch as its baseline.
    if (!cik) {
      const listed = await ciks().then(d => ({ cik: d[ticker] ?? null, read: true })).catch(() => ({ cik: null, read: false }));
      cik = listed.cik; bootstrap = cik !== null;
      // The directory was read and does not list the ticker: say so where the admin's company list looks.
      if (!cik && listed.read) await repository.setCache(`sec:financial-discovery-failure:v1:${ticker}`, { reason: "SEC_ISSUER_NOT_FOUND" }, now.toISOString()).catch(() => undefined);
    }
    if (!cik) { result.unknown.push(ticker); continue; }
    try {
      const submissions = await listings.submissions(cik) as { fiscalYearEnd?: unknown; name?: unknown } | null;
      const filings = recentFilings(submissions);
      if (!filings.length) throw new Error("EMPTY_SUBMISSIONS");
      const previous = (await repository.getCache<DiscoveryState>(discoveryStateKey(ticker)))?.payload;
      if (!previous && !announcing) { result.checked++; continue; }
      const at = now.toISOString();
      const known = new Set(previous?.accessions ?? []);
      // The bounded memory (REMEMBERED) is for the diff; the lists below are read from the whole recent block, as
      // the SEC report reads its own window of filings, so a run of other forms never pushes a filing out of them.
      const remembered = filings.slice(0, REMEMBERED);
      const fresh = previous && announcing ? remembered.filter(f => !known.has(f.accession) && ANNOUNCED(f.form)) : [];
      for (const filing of fresh) {
        const root = secArchiveRoot(Number(cik), filing.accession);
        await requestFilingMaterial(env, { ticker, accession: filing.accession, cik,
          form: filing.form, filedAt: filing.filingDate, reportDate: filing.reportDate,
          companyName: typeof submissions?.name === "string" ? submissions.name : ticker,
          primaryDocument: filing.primaryDocument, documentUrl: secArchiveDocumentUrl(root, filing.primaryDocument),
          indexUrl: secArchiveDocumentUrl(root, `${filing.accession}-index.htm`) });
      }
      const collectable = filings.filter(COLLECTED).slice(0, 20);
      const collected = collectable.filter(f => /^[\w.-]+\.html?$/i.test(f.primaryDocument)).map(f => ({ accession: f.accession, form: f.form, filedAt: f.filingDate,
        reportDate: /^\d{4}-\d{2}-\d{2}$/.test(f.reportDate) ? f.reportDate : null,
        url: secArchiveDocumentUrl(secArchiveRoot(Number(cik), f.accession), f.primaryDocument) }));
      await db.batch([
        db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
          .bind(discoveryStateKey(ticker), JSON.stringify({ cik, accessions: announcing || !previous ? remembered.map(f => f.accession) : previous.accessions, checkedAt: at, collectable: collectable.map(f => f.accession), collected,
            fiscalYearEnd: typeof submissions?.fiscalYearEnd === "string" && /^\d{4}$/.test(submissions.fiscalYearEnd) ? submissions.fiscalYearEnd : null,
            name: typeof submissions?.name === "string" && submissions.name.trim() ? submissions.name.trim() : null, annualForm: annualForm(submissions),
            // The report's own window of filings (its discovery reads the newest 40 business filings) and, apart from
            // them, the prospectus supplements, so a run of supplements never pushes a report out of the list.
            current: [...filings.filter(f => reportedForm(f.form)).slice(0, 40), ...filings.filter(f => isProspectusSupplement(f.form)).slice(0, 40)].map(f => ({ accession: f.accession, form: f.form, items: f.items, filingDate: f.filingDate, reportDate: f.reportDate, document: f.primaryDocument })) } satisfies DiscoveryState), at),
        // Oldest first, so subscribers that read the newest state see the filings in the order they were made.
        ...fresh.reverse().map(f => outboxStatement(db, { type: "filing.discovered", ticker, cik, detail: { form: f.form, items: f.items, accession: f.accession } }, at)),
        ...(bootstrap ? [outboxStatement(db, { type: "company.added", ticker, cik }, at), outboxStatement(db, { type: "collection.requested", ticker, cik }, at)] : []),
        // A baseline announces no filing, so the current reports it lists are asked to be archived here; so are those of
        // a state saved before `current` existed, whose archive task ran on its version change with nothing to list.
        ...(announcing && (!previous || !previous.current) && filings.some(CURRENT) ? [outboxStatement(db, { type: "archive.requested", ticker, cik }, at)] : []),
      ]);
      if (bootstrap) result.bootstrapped.push(ticker);
      if (!previous) result.baseline.push(ticker);
      result.discovered.push(...fresh.map(f => `${ticker}:${f.form}:${f.accession}`));
      result.checked++;
    } catch (error) {
      console.error(JSON.stringify({ event: "sec-discovery", ticker, error: error instanceof Error ? error.message : String(error) }));
      result.failed.push(ticker);
    }
  }
  if (result.checked) await repository.setCache(DISCOVERY_HEARTBEAT_KEY, { checked: result.checked, discovered: result.discovered.length, failed: result.failed }, now.toISOString());
  if (!result.checked && result.failed.length) throw new Error(`SEC discovery read no company (${result.failed.length} failed)`);
  return result;
}
