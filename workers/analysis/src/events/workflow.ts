import type { CompanyEvent, EventExhibit, EventForm, EventsPublication, EventSummary, InsiderTransaction } from "../../../../shared/analysis-contract/events.ts";
import { annotateEvent, eventImportance, classifyEvent, filingDocumentTitle, indexPrimaryDescription, parseItems, readEventsPublication } from "../../../../shared/analysis-runtime/events.ts";
import type { SecCronEnv } from "../core.ts";
import { knownCik } from "../pipeline/identity.ts";
import { outboxStatement } from "../pipeline/outbox.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { throttledSecReader } from "../financial-data/provider.ts";
import type { SecFilingFeed, SecFilingSummary } from "../sec/sec.ts";
import { form4XmlUrl, normalizeCik, parseForm4 } from "./form4.ts";
import { eventsCacheKey, exhibitsCacheKey, insiderCacheKey } from "./read.ts";

export type EventsSweepEnv = Pick<SecCronEnv, "DB" | "SEC_DATA_TICKERS" | "SEC_AI_TICKERS" | "SEC_AI_ENABLED"> & { SEC_USER_AGENT: string; EVENTS_ENABLED?: string };

/** How old a stored submission list may be before a run re-reads it anyway; a discovered filing always re-reads it. */
const REFRESH_MS = 6 * 60 * 60_000;
const WINDOW_MONTHS = 24;
/** Bounds per run, so one company with a long insider history never monopolises the SEC request budget. */
const LIMITS = { insiderReads: 8, exhibitReads: 6, currentReports: 80, insiderFilings: 160 };
const EVENT_FORMS = new Set<EventForm>(["8-K", "8-K/A", "6-K", "6-K/A", "4", "4/A"]);

export type RawEventFiling = {
  form: EventForm; accessionNumber: string; filingDate: string; reportDate: string; items: string; description: string; primaryDocument: string; archiveRoot: string;
};

const asRecord = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const asArray = (v: unknown): unknown[] => Array.isArray(v) ? v : [];

/** The 8-K/6-K and Form 4 filings in EDGAR's submission list, newest first, inside the window and the per-form caps. */
export function parseEventSubmissions(payload: unknown, cikNumber: number, now: Date): RawEventFiling[] {
  const recent = asRecord(asRecord(asRecord(payload)?.filings)?.recent);
  if (!recent) return [];
  const column = (name: string) => asArray(recent[name]);
  const accessions = column("accessionNumber"), forms = column("form"), filingDates = column("filingDate"), reportDates = column("reportDate");
  const primaries = column("primaryDocument"), descriptions = column("primaryDocDescription"), items = column("items");
  const cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - WINDOW_MONTHS);
  const floor = cutoff.toISOString().slice(0, 10);
  const filings: RawEventFiling[] = [];
  for (let i = 0; i < accessions.length; i++) {
    const form = String(forms[i] ?? "") as EventForm, accessionNumber = String(accessions[i] ?? ""), filingDate = String(filingDates[i] ?? "");
    if (!EVENT_FORMS.has(form) || !accessionNumber || !/^\d{4}-\d{2}-\d{2}$/.test(filingDate) || filingDate < floor) continue;
    filings.push({
      form, accessionNumber, filingDate, reportDate: String(reportDates[i] ?? ""), items: String(items[i] ?? ""), description: String(descriptions[i] ?? ""),
      primaryDocument: String(primaries[i] ?? ""), archiveRoot: `https://www.sec.gov/Archives/edgar/data/${cikNumber}/${accessionNumber.replaceAll("-", "")}`,
    });
  }
  filings.sort((a, b) => b.filingDate.localeCompare(a.filingDate) || b.accessionNumber.localeCompare(a.accessionNumber));
  const insider = filings.filter(f => f.form.startsWith("4")).slice(0, LIMITS.insiderFilings);
  const current = filings.filter(f => !f.form.startsWith("4")).slice(0, LIMITS.currentReports);
  return [...current, ...insider].sort((a, b) => b.filingDate.localeCompare(a.filingDate) || b.accessionNumber.localeCompare(a.accessionNumber));
}

/** Exhibits from the filing index page: the row's type column (EX-99.1) and its document link. */
export function parseExhibitIndex(html: string, archiveRoot: string): EventExhibit[] {
  const out: EventExhibit[] = [];
  const row = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = row.exec(html))) {
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1]);
    if (cells.length < 4) continue;
    const type = cells[3].replace(/<[^>]+>/g, "").trim().toUpperCase();
    if (!/^EX-(?!101)\d+(?:\.\d+)?$/.test(type)) continue;
    const href = /href="([^"]+)"/i.exec(cells[2])?.[1];
    if (!href) continue;
    const file = href.split("/").pop() ?? "";
    const title = cells[1].replace(/<[^>]+>/g, "").trim() || type;
    out.push({ type, title: title.slice(0, 200), url: `${archiveRoot}/${file}` });
  }
  return out.slice(0, 30);
}

function toSummary(summary: SecFilingSummary | null): EventSummary | null {
  if (!summary || summary.source === "error" || !summary.headline) return null;
  return {
    headline: summary.headline, bullets: summary.bullets.map(b => ({ label: b.label, detail: b.detail, importance: b.importance })).slice(0, 12),
    analystView: summary.analystView, eventCategory: summary.eventCategory ?? null, generatedAt: summary.generatedAt,
  };
}

/** What the insider cache holds per accession: the parsed transaction, a document SEC did not serve, or another issuer's filing. */
export type InsiderCacheEntry = InsiderTransaction | { unreadable: true } | { otherIssuer: string };

/**
 * A Form 4 belongs on the company's rail only when the company is its issuer. A transaction read before the issuer was
 * parsed carries no issuer and is kept; `scripts/clean-foreign-insider.ts` re-reads those.
 */
export function sameIssuer(insider: Pick<InsiderTransaction, "issuerCik">, companyCik: string | number): boolean {
  return !insider.issuerCik || normalizeCik(insider.issuerCik) === normalizeCik(companyCik);
}

type Fetcher = typeof fetch;
/** A 403 or 429 from SEC: the caller stops for a while instead of trying the next read (provider.ts). */
export const secAccessPaused = (error: unknown) => error instanceof Error && error.message === "SEC_ACCESS_PAUSED";

/**
 * Rebuilds the company's event rail. `forceList` re-reads EDGAR's submission list (a new filing was discovered);
 * otherwise the stored list is kept and only pending Form 4 and exhibit reads advance, a bounded number per call.
 * `pending` counts reads still outstanding and `progressed` whether this call stored any, so a caller continues
 * only while it is getting somewhere. Every SEC read goes through the throttled reader; SEC pausing access
 * (`SEC_ACCESS_PAUSED`) ends the call at once so the caller can back off.
 */
export async function refreshCompanyEvents(env: EventsSweepEnv, ticker: string, fetcher: Fetcher, now: Date, options: { forceList?: boolean; causeId?: string | null } = {}): Promise<{ published: boolean; insiderReads: number; exhibitReads: number; pending: number; progressed: boolean }> {
  const db = env.DB;
  if (!db) throw new Error("No D1 binding");
  const repository = new D1SecRepository(db);
  const stored = await repository.getCache<unknown>(eventsCacheKey(ticker));
  const publication = stored ? readEventsPublication(stored.payload, ticker) : null;
  const feed = await repository.getCache<SecFilingFeed>(`sec:filings:${ticker}`);
  const cik = feed?.payload.company?.cik ?? feed?.payload.filings[0]?.cik ?? await knownCik(db, ticker);
  if (!cik) return { published: false, insiderReads: 0, exhibitReads: 0, pending: 0, progressed: false };
  const cikNumber = Number(cik);
  const reader = throttledSecReader(env.SEC_USER_AGENT, fetcher, 200);
  const listDue = options.forceList || !publication || now.getTime() - Date.parse(publication.checkedAt) >= REFRESH_MS;
  let raw: RawEventFiling[];
  let checkedAt = publication?.checkedAt ?? now.toISOString();
  if (listDue) {
    raw = parseEventSubmissions(await (await reader.read(`https://data.sec.gov/submissions/CIK${cik}.json`)).json(), cikNumber, now);
    checkedAt = now.toISOString();
  } else {
    raw = publication!.events.map(e => ({
      form: e.form, accessionNumber: e.id, filingDate: e.filedAt, reportDate: e.eventDate, items: e.items.join(","), description: e.description,
      primaryDocument: e.documentUrl.slice(e.documentUrl.lastIndexOf("/", e.documentUrl.lastIndexOf("/") - 1) + 1), archiveRoot: e.documentUrl.slice(0, e.documentUrl.indexOf("/", "https://www.sec.gov/Archives/edgar/data/".length + String(cikNumber).length + 1)),
    }));
  }
  const previous = new Map((publication?.events ?? []).map(e => [e.id, e]));
  let insiderReads = 0, exhibitReads = 0, pendingInsider = 0, pendingExhibits = 0, saved = 0;
  const events: CompanyEvent[] = [];
  for (const filing of raw) {
    const prior = previous.get(filing.accessionNumber);
    const isInsider = filing.form.startsWith("4");
    const archiveRoot = filing.archiveRoot;
    const documentUrl = `${archiveRoot}/${filing.primaryDocument}`;
    let insider: InsiderTransaction | null = prior?.insider ?? null;
    if (isInsider && !insider) {
      const cached = (await repository.getCache<InsiderCacheEntry>(insiderCacheKey(ticker, filing.accessionNumber)))?.payload;
      // Another issuer's filing, recorded once so it is neither read again nor counted as pending.
      if (cached && "otherIssuer" in cached) continue;
      if (cached && !("unreadable" in cached)) insider = cached;
      else if (!cached && insiderReads < LIMITS.insiderReads) {
        insiderReads++;
        try {
          let parsed: InsiderTransaction | null = null;
          try { parsed = parseForm4(await (await reader.read(form4XmlUrl(archiveRoot, filing.primaryDocument))).text()); }
          catch (error) { if (secAccessPaused(error)) throw error; /* A document SEC does not serve is unreadable, as before. */ }
          const foreign = parsed && !sameIssuer(parsed, cikNumber);
          await repository.setCache(insiderCacheKey(ticker, filing.accessionNumber), foreign ? { otherIssuer: parsed!.issuerCik! } : parsed ?? { unreadable: true }, now.toISOString());
          saved++;
          if (foreign) continue;
          insider = parsed;
        } catch (error) { if (secAccessPaused(error)) throw error; /* Left pending; the next tick reads it again. */ }
      }
      if (!insider) { pendingInsider++; continue; }
    }
    // The company's submission list also carries the Form 4s it filed as a holder of other companies' stock.
    if (insider && !sameIssuer(insider, cikNumber)) continue;
    let exhibits = prior?.exhibits ?? [];
    // The submissions feed often describes a 6-K as "6-K". The filing index's Description cell is the same request the exhibit list uses.
    // A later submissions read names the form again ("6-K"). Keep a document title already taken from the filing index.
    let description = filing.description;
    if (!filingDocumentTitle({ description }) && prior && filingDocumentTitle(prior)) description = prior.description;
    if (!isInsider && !exhibits.length) {
      const cached = await repository.getCache<EventExhibit[]>(exhibitsCacheKey(ticker, filing.accessionNumber));
      if (cached) exhibits = cached.payload;
      else if (exhibitReads < LIMITS.exhibitReads) {
        exhibitReads++;
        try {
          const indexHtml = await (await reader.read(`${archiveRoot}/${filing.accessionNumber}-index.htm`)).text();
          exhibits = parseExhibitIndex(indexHtml, archiveRoot);
          const indexed = indexPrimaryDescription(indexHtml);
          if (indexed) description = indexed;
          await repository.setCache(exhibitsCacheKey(ticker, filing.accessionNumber), exhibits, now.toISOString()); saved++;
        } catch (error) { if (secAccessPaused(error)) throw error; exhibits = []; pendingExhibits++; }
      } else pendingExhibits++;
    }
    const summary = isInsider ? null : toSummary(await repository.getSummary(ticker, filing.accessionNumber)) ?? prior?.summary ?? null;
    const items = parseItems(filing.items);
    const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(filing.reportDate) ? filing.reportDate : filing.filingDate;
    events.push(annotateEvent({
      id: filing.accessionNumber, ticker, form: filing.form, filedAt: filing.filingDate, eventDate, items,
      class: classifyEvent(filing.form, items, description || summary?.headline || ""), description: description.slice(0, 300),
      edgarUrl: `${archiveRoot}/${filing.accessionNumber}-index.html`, documentUrl, exhibits, summary, insider,
    }));
  }
  const sortedEvents = events.sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.eventDate.localeCompare(a.eventDate));
  const next: EventsPublication = { schemaVersion: "events.v1", ticker, checkedAt, events: sortedEvents.map(event => ({ ...event, importance: eventImportance(event, sortedEvents) })), pendingInsider };
  await db.batch([
    db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
      .bind(eventsCacheKey(ticker), JSON.stringify(next), now.toISOString()),
    // The classes filed since the last publication ride in the event, so a subscriber can take only financing or deal news.
    outboxStatement(db, { type: "events.published", ticker, causeId: options.causeId ?? null, detail: { classes: [...new Set(events.filter(e => !previous.has(e.id)).map(e => e.class))].join(",") } }, now.toISOString()),
  ]);
  return { published: true, insiderReads, exhibitReads, pending: pendingInsider + pendingExhibits, progressed: saved > 0 };
}
