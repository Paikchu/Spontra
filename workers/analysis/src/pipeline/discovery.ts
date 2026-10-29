import { canonicalTicker } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import { throttledSecReader } from "../financial-data/provider.ts";
import type { AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { knownCik } from "./identity.ts";
import { outboxStatement } from "./outbox.ts";
import { scopeTickers } from "./router.ts";

export const DISCOVERY_HEARTBEAT_KEY = "pipeline:discovery-heartbeat";
export const DISCOVERY_STATE_PREFIX = "sec:discovery:v1:";
const stateKey = (ticker: string) => `${DISCOVERY_STATE_PREFIX}${ticker}`;
/** Forms something downstream reads: periodic reports, current reports and insider transactions, with amendments. */
const ANNOUNCED = /^(?:10-[QK]|20-F|40-F|6-K|8-K|4)(?:\/A)?$/;
const REMEMBERED = 200;

/**
 * `collectable`: accessions of the filings collection reads (periodic reports, 6-Ks, earnings 8-Ks), newest first; `collected`
 * the same filings with what reading one needs, so collection depends on no other writer's index (a data-only issuer has none).
 * `fiscalYearEnd` (`MMDD`) and `name` are the issuer's as its submissions state them; EDGAR leaves the year end out for some foreign issuers.
 * `annualForm`: the form of its latest annual report ("10-K", "20-F", "40-F"), so a foreign issuer reads as one before any filing is collected.
 */
export type CollectableFiling = { accession: string; form: string; filedAt: string; reportDate: string | null; url: string };
export type DiscoveryState = { cik: string; accessions: string[]; checkedAt: string; collectable?: string[]; collected?: CollectableFiling[]; fiscalYearEnd?: string | null; name?: string | null; annualForm?: string | null };
/** The forms a collection job lists (provider.ts `readSecDocumentBatch`). */
const COLLECTED = (f: { form: string; items: string }) => /^(?:10-[QK]|20-F)(?:\/A)?$/.test(f.form) || f.form === "6-K" || (f.form === "8-K" && f.items.includes("2.02"));

/**
 * EDGAR's issuer directory, read once per run and only when a company's CIK is not yet known: every listed symbol
 * mapped to its ten-digit CIK, with a second share class filed under the data ticker it resolves to.
 */
export function parseIssuerDirectory(payload: unknown): Record<string, string> {
  const root = payload as { fields?: unknown; data?: unknown } | null;
  const fields = Array.isArray(root?.fields) ? root.fields.map(String) : [];
  const symbol = fields.indexOf("ticker"), cik = fields.indexOf("cik");
  const out: Record<string, string> = {};
  if (symbol < 0 || cik < 0 || !Array.isArray(root?.data)) return out;
  for (const row of root!.data as unknown[][]) {
    const ticker = canonicalTicker(String(row[symbol] ?? ""));
    const id = String(row[cik] ?? "").padStart(10, "0");
    if (ticker && /^\d{10}$/.test(id) && Number(id) > 0 && !out[ticker]) out[ticker] = id;
  }
  return out;
}
const issuerDirectory = (reader: { read: (url: string) => Promise<Response> }) => {
  let loaded: Promise<Record<string, string>> | null = null;
  return () => loaded ??= reader.read("https://www.sec.gov/files/company_tickers_exchange.json").then(r => r.json()).then(parseIssuerDirectory);
};
type Filing = { accession: string; form: string; items: string; filingDate: string; reportDate: string; primaryDocument: string };

function recentFilings(payload: unknown): Filing[] {
  const recent = (payload as { filings?: { recent?: Record<string, unknown[]> } } | null)?.filings?.recent;
  if (!recent || !Array.isArray(recent.accessionNumber)) return [];
  const column = (name: string, i: number) => String((recent[name] as unknown[] | undefined)?.[i] ?? "");
  return recent.accessionNumber.slice(0, REMEMBERED).map((_, i) => ({
    accession: column("accessionNumber", i), form: column("form", i), items: column("items", i), filingDate: column("filingDate", i),
    reportDate: column("reportDate", i), primaryDocument: column("primaryDocument", i),
  })).filter(f => /^\d{10}-\d{2}-\d{6}$/.test(f.accession));
}

/** The form of the issuer's latest annual report in its whole recent list, amendments read as the report they amend. */
export function annualForm(payload: unknown): string | null {
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
 */
export async function runSecDiscovery(env: AnalysisEnv, now = new Date(), fetcher: typeof fetch = fetch) {
  const db = env.DB!;
  const repository = new D1SecRepository(db);
  const reader = throttledSecReader(env.SEC_USER_AGENT, fetcher, 200);
  const result = { checked: 0, discovered: [] as string[], baseline: [] as string[], bootstrapped: [] as string[], unknown: [] as string[], failed: [] as string[] };
  const directory = issuerDirectory(reader);
  for (const ticker of await scopeTickers(env, "data")) {
    let cik = await knownCik(db, ticker);
    let bootstrap = false;
    // A company on the data list the pipeline has never collected: its CIK comes from EDGAR's issuer directory, and
    // its first collection is asked for in the same batch as its baseline.
    if (!cik) {
      const listed = await directory().then(d => ({ cik: d[ticker] ?? null, read: true })).catch(() => ({ cik: null, read: false }));
      cik = listed.cik; bootstrap = cik !== null;
      // The directory was read and does not list the ticker: say so where the admin's company list looks.
      if (!cik && listed.read) await repository.setCache(`sec:financial-discovery-failure:v1:${ticker}`, { reason: "SEC_ISSUER_NOT_FOUND" }, now.toISOString()).catch(() => undefined);
    }
    if (!cik) { result.unknown.push(ticker); continue; }
    try {
      const submissions = await (await reader.read(`https://data.sec.gov/submissions/CIK${cik}.json`)).json() as { fiscalYearEnd?: unknown; name?: unknown } | null;
      const filings = recentFilings(submissions);
      if (!filings.length) throw new Error("EMPTY_SUBMISSIONS");
      const previous = (await repository.getCache<DiscoveryState>(stateKey(ticker)))?.payload;
      const at = now.toISOString();
      const known = new Set(previous?.accessions ?? []);
      const fresh = previous ? filings.filter(f => !known.has(f.accession) && ANNOUNCED.test(f.form)) : [];
      const collectable = filings.filter(COLLECTED).slice(0, 20);
      const collected = collectable.filter(f => /^[\w.-]+\.html?$/i.test(f.primaryDocument)).map(f => ({ accession: f.accession, form: f.form, filedAt: f.filingDate,
        reportDate: /^\d{4}-\d{2}-\d{2}$/.test(f.reportDate) ? f.reportDate : null,
        url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${f.accession.replaceAll("-", "")}/${f.primaryDocument}` }));
      await db.batch([
        db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
          .bind(stateKey(ticker), JSON.stringify({ cik, accessions: filings.map(f => f.accession), checkedAt: at, collectable: collectable.map(f => f.accession), collected,
            fiscalYearEnd: typeof submissions?.fiscalYearEnd === "string" && /^\d{4}$/.test(submissions.fiscalYearEnd) ? submissions.fiscalYearEnd : null,
            name: typeof submissions?.name === "string" && submissions.name.trim() ? submissions.name.trim() : null, annualForm: annualForm(submissions) } satisfies DiscoveryState), at),
        // Oldest first, so subscribers that read the newest state see the filings in the order they were made.
        ...fresh.reverse().map(f => outboxStatement(db, { type: "filing.discovered", ticker, cik, detail: { form: f.form, items: f.items, accession: f.accession } }, at)),
        ...(bootstrap ? [outboxStatement(db, { type: "company.added", ticker, cik }, at), outboxStatement(db, { type: "collection.requested", ticker, cik }, at)] : []),
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
