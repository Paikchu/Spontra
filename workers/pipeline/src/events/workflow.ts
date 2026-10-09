import type { CompanyEvent, EventExhibit, EventForm, EventsPublication, EventSummary, InsiderTransaction } from "../../../../shared/analysis-contract/events.ts";
import { classifyEvent, parseItems, readEventsPublication } from "../../../../shared/analysis-runtime/events.ts";
import { dataTickersFor, trackedTickersFor, type SecCronEnv } from "../core.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { SecFilingFeed, SecFilingSummary } from "../sec/sec.ts";
import { form4XmlUrl, parseForm4 } from "./form4.ts";
import { eventsCacheKey, exhibitsCacheKey, insiderCacheKey } from "./read.ts";

export type EventsSweepEnv = Pick<SecCronEnv, "DB" | "SEC_DATA_TICKERS" | "SEC_TRACKED_TICKERS" | "SEC_AI_TICKERS" | "SEC_AI_ENABLED"> & { SEC_USER_AGENT: string; EVENTS_ENABLED?: string };

/** How often EDGAR's submission list is re-read per company; Form 4 and exhibit reads continue every tick until none are pending. */
const REFRESH_MS = 6 * 60 * 60_000;
const WINDOW_MONTHS = 24;
/** Bounds per tick, so one company with a long insider history never monopolises the SEC request budget. */
const LIMITS = { tickers: 2, insiderReads: 8, exhibitReads: 6, currentReports: 80, insiderFilings: 160 };
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

type Fetcher = typeof fetch;
const secHeaders = (userAgent: string, accept: string) => ({ accept, "user-agent": userAgent });

/** Reads one company's events: EDGAR's list when it is due, otherwise the stored list, then fills summaries, exhibits and Form 4 figures within the tick's budget. */
export async function refreshCompanyEvents(env: EventsSweepEnv, ticker: string, fetcher: Fetcher, now: Date): Promise<{ published: boolean; insiderReads: number; exhibitReads: number }> {
  const db = env.DB;
  if (!db) throw new Error("No D1 binding");
  const repository = new D1SecRepository(db);
  const stored = await repository.getCache<unknown>(eventsCacheKey(ticker));
  const publication = stored ? readEventsPublication(stored.payload, ticker) : null;
  const feed = await repository.getCache<SecFilingFeed>(`sec:filings:${ticker}`);
  const cik = feed?.payload.company?.cik ?? feed?.payload.filings[0]?.cik;
  if (!cik) return { published: false, insiderReads: 0, exhibitReads: 0 };
  const cikNumber = Number(cik);
  const listDue = !publication || now.getTime() - Date.parse(publication.checkedAt) >= REFRESH_MS;
  let raw: RawEventFiling[];
  let checkedAt = publication?.checkedAt ?? now.toISOString();
  if (listDue) {
    const response = await fetcher(`https://data.sec.gov/submissions/CIK${cik}.json`, { cache: "no-store", headers: secHeaders(env.SEC_USER_AGENT, "application/json"), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`SEC HTTP ${response.status}`);
    raw = parseEventSubmissions(await response.json(), cikNumber, now);
    checkedAt = now.toISOString();
  } else {
    raw = publication!.events.map(e => ({
      form: e.form, accessionNumber: e.id, filingDate: e.filedAt, reportDate: e.eventDate, items: e.items.join(","), description: e.description,
      primaryDocument: e.documentUrl.slice(e.documentUrl.lastIndexOf("/", e.documentUrl.lastIndexOf("/") - 1) + 1), archiveRoot: e.documentUrl.slice(0, e.documentUrl.indexOf("/", "https://www.sec.gov/Archives/edgar/data/".length + String(cikNumber).length + 1)),
    }));
  }
  const previous = new Map((publication?.events ?? []).map(e => [e.id, e]));
  let insiderReads = 0, exhibitReads = 0, pendingInsider = 0;
  const events: CompanyEvent[] = [];
  for (const filing of raw) {
    const prior = previous.get(filing.accessionNumber);
    const isInsider = filing.form.startsWith("4");
    const archiveRoot = filing.archiveRoot;
    const documentUrl = `${archiveRoot}/${filing.primaryDocument}`;
    let insider: InsiderTransaction | null = prior?.insider ?? null;
    if (isInsider && !insider) {
      const cached = await repository.getCache<InsiderTransaction | { unreadable: true }>(insiderCacheKey(ticker, filing.accessionNumber));
      if (cached && !("unreadable" in cached.payload)) insider = cached.payload;
      else if (!cached && insiderReads < LIMITS.insiderReads) {
        insiderReads++;
        try {
          const response = await fetcher(form4XmlUrl(archiveRoot, filing.primaryDocument), { cache: "no-store", headers: secHeaders(env.SEC_USER_AGENT, "application/xml,text/xml,*/*"), signal: AbortSignal.timeout(20_000) });
          const parsed = response.ok ? parseForm4(await response.text()) : null;
          await repository.setCache(insiderCacheKey(ticker, filing.accessionNumber), parsed ?? { unreadable: true }, now.toISOString());
          insider = parsed;
        } catch { /* Left pending; the next tick reads it again. */ }
      }
      if (!insider) { pendingInsider++; continue; }
    }
    let exhibits = prior?.exhibits ?? [];
    if (!isInsider && !exhibits.length) {
      const cached = await repository.getCache<EventExhibit[]>(exhibitsCacheKey(ticker, filing.accessionNumber));
      if (cached) exhibits = cached.payload;
      else if (exhibitReads < LIMITS.exhibitReads) {
        exhibitReads++;
        try {
          const response = await fetcher(`${archiveRoot}/${filing.accessionNumber}-index.htm`, { cache: "no-store", headers: secHeaders(env.SEC_USER_AGENT, "text/html"), signal: AbortSignal.timeout(20_000) });
          exhibits = response.ok ? parseExhibitIndex(await response.text(), archiveRoot) : [];
          if (response.ok) await repository.setCache(exhibitsCacheKey(ticker, filing.accessionNumber), exhibits, now.toISOString());
        } catch { exhibits = []; }
      }
    }
    const summary = isInsider ? null : toSummary(await repository.getSummary(ticker, filing.accessionNumber)) ?? prior?.summary ?? null;
    const items = parseItems(filing.items);
    const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(filing.reportDate) ? filing.reportDate : filing.filingDate;
    events.push({
      id: filing.accessionNumber, ticker, form: filing.form, filedAt: filing.filingDate, eventDate, items,
      class: classifyEvent(filing.form, items, filing.description || summary?.headline || ""), description: filing.description.slice(0, 300),
      edgarUrl: `${archiveRoot}/${filing.accessionNumber}-index.html`, documentUrl, exhibits, summary, insider,
    });
  }
  const next: EventsPublication = { schemaVersion: "events.v1", ticker, checkedAt, events, pendingInsider };
  await repository.setCache(eventsCacheKey(ticker), next, now.toISOString());
  return { published: true, insiderReads, exhibitReads };
}

/** Which companies the sweep serves: every data company, with the AI companies first so the map's findings pages fill first. */
export function eventTickersFor(env: EventsSweepEnv): string[] {
  return [...new Set([...trackedTickersFor(env), ...dataTickersFor(env)])];
}

/** Deterministic and bounded: no model call, at most two companies per tick, and a company is only re-read when its list is due or has pending Form 4 reads. */
export async function runEventsSweep(env: EventsSweepEnv, fetcher: Fetcher = fetch, now = new Date()): Promise<{ checked: number; refreshed: string[]; skipped: string[]; failed: string[]; insiderReads: number }> {
  const result = { checked: 0, refreshed: [] as string[], skipped: [] as string[], failed: [] as string[], insiderReads: 0 };
  if (!env.DB || env.EVENTS_ENABLED === "false") return result;
  const repository = new D1SecRepository(env.DB);
  for (const ticker of eventTickersFor(env)) {
    if (result.refreshed.length >= LIMITS.tickers) break;
    result.checked++;
    try {
      const stored = await repository.getCache<unknown>(eventsCacheKey(ticker));
      const publication = stored ? readEventsPublication(stored.payload, ticker) : null;
      const due = !publication || publication.pendingInsider > 0 || now.getTime() - Date.parse(publication.checkedAt) >= REFRESH_MS;
      if (!due) { result.skipped.push(ticker); continue; }
      const outcome = await refreshCompanyEvents(env, ticker, fetcher, now);
      result.insiderReads += outcome.insiderReads;
      if (outcome.published) result.refreshed.push(ticker); else result.skipped.push(ticker);
    } catch (error) {
      console.warn("events sweep failed", { ticker, error: error instanceof Error ? error.message : String(error) });
      result.failed.push(ticker);
    }
  }
  return result;
}
