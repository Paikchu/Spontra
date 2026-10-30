import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocale } from "@/packages/web/src/i18n";
import { stageChartBox } from "./chart-box";
import { crossfade } from "./page-turn";
import type { PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";
import type { PeersPublication } from "@/shared/analysis-contract/peers";
import type { EventsPublication } from "@/shared/analysis-contract/events";
import type { PublicFilingDigestPage } from "@/shared/analysis-contract/filings";
import { MAP_RESOURCES, type MapResource, type MapRevisions } from "@/shared/analysis-contract/revisions";
import type { FindingFundamentals } from "@/shared/analysis-runtime/findings";
import type { ValuationResponse } from "@/shared/analysis-contract/valuation";
import { CompanyHttpError, fetchCapital, fetchCompany, fetchEvents, fetchFindings, fetchRevisions, fetchSupplement, fetchValuation, publicationFlow, type CompanyPublication, type FindingsBundle } from "./company-data";
import { nextPending, readRevisions, resourcesToRead } from "./revision-reads";
import type { CompanyOpening, OpeningRequests } from "./company-opening";

/** Everything the company page draws from, as one value so a newer read can replace parts of it at once. */
export type CompanyData = {
  publication: CompanyPublication | null;
  flow: PublicBusinessFlow | null;
  capital: PublicCapitalStructure | null;
  /** The company and its comparable peers, read with the capital structure, for the checkup's ranks. */
  peers: PeersPublication | null;
  findings: FindingsBundle | null;
  fundamentals: FindingFundamentals | null;
  events: EventsPublication | null;
  filings: PublicFilingDigestPage | null;
  /** The valuation assessment with its availability; absent until read. */
  valuation: ValuationResponse | null;
};
const EMPTY: CompanyData = { publication: null, flow: null, capital: null, peers: null, findings: null, fundamentals: null, events: null, filings: null, valuation: null };

/** The main view becomes available once its own opening resources have settled. */
export type { OpeningFace } from "./opening-face";
export { openingFace } from "./opening-face";

type OpeningRead = {
  data: CompanyData;
  failed: boolean;
  eventsPhase: "ready" | "loading" | "error";
  revisions: MapRevisions;
  httpStatus: number | null;
};
type OpeningPart = { resource: MapResource; data?: Partial<CompanyData>; failed?: boolean; httpStatus?: number; eventsError?: boolean };

/** Deep links keep the target's evidence ready before the map resolves and normalizes its URL. */
function primaryResources(search: string, valuation: ValuationResponse | null): readonly MapResource[] {
  const params = new URLSearchParams(search);
  // These lenses verify figures against the combined statements, findings and event evidence.
  if (["finding", "check", "report"].some(key => params.has(key))) return MAP_RESOURCES;
  if (params.has("event")) return MAP_RESOURCES.filter(resource => resource !== "filings");
  const requestedView = params.get("view");
  const statementLink = ["business", "metric"].some(key => params.has(key));
  const opensValuation = !!valuation && valuation.availability !== "hidden" && (requestedView === "valuation" || (!requestedView && !statementLink && !!valuation?.report));
  if (opensValuation) return ["company", "valuation"];
  // Tabs, headline figures and checks are part of the first statement frame. Keep their geometry and meaning stable;
  // the filing/event history can arrive later without blocking them.
  return ["company", "valuation", "capital", "findings", "fundamentals"];
}

/** Start every versioned read together; publish the primary view before unrelated supplements finish. */
async function loadOpening(ticker: string, request: OpeningRequests, onSeen: (ticker: string) => void, search: string, onPrimary?: (read: OpeningRead) => void): Promise<OpeningRead> {
  const { signal } = request;
  const revisions = await request.revisions;
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const read = async (resource: MapResource): Promise<OpeningPart> => {
    try {
      if (resource === "company") {
        const publication = await fetchCompany(ticker, signal, revisions?.company, request.response("company"));
        if (!signal.aborted) onSeen(ticker);
        return { resource, data: { publication, flow: publicationFlow(publication, ticker) } };
      }
      if (resource === "events") {
        const result = await fetchEvents(ticker, signal, revisions?.events, request.response("events"));
        return { resource, data: result.events ? { events: result.events } : undefined, eventsError: result.error };
      }
      return { resource, data: await readResource(ticker, resource, revisions?.[resource], signal, request.response(resource)) ?? undefined };
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      return { resource, failed: resource === "company", httpStatus: error instanceof CompanyHttpError ? error.status : 0 };
    }
  };
  const collect = (parts: OpeningPart[]): OpeningRead => {
    const result: OpeningRead = { data: { ...EMPTY }, failed: false, eventsPhase: "loading", revisions: {}, httpStatus: null };
    for (const part of parts) {
      Object.assign(result.data, part.data);
      if (part.failed) { result.failed = true; result.httpStatus = part.httpStatus ?? 0; }
      if (part.resource === "events") result.eventsPhase = part.eventsError ? "error" : "ready";
      const rev = revisions?.[part.resource];
      if (rev && part.data && (part.resource !== "company" || part.data.flow)) result.revisions[part.resource] = rev;
    }
    return result;
  };
  const reads = new Map(MAP_RESOURCES.map(resource => [resource, read(resource)]));
  // Attach the full read immediately so cancellation cannot leave a secondary rejection unobserved.
  const complete = Promise.all(reads.values());
  void complete.catch(() => {});
  const valuation = await reads.get("valuation")!;
  const primary = primaryResources(search, valuation.data?.valuation ?? null);
  if (onPrimary && primary.length < MAP_RESOURCES.length) {
    const parts = await Promise.all(primary.map(resource => reads.get(resource)!));
    if (!signal.aborted) onPrimary(collect(parts));
  }
  const parts = await complete;
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return collect(parts);
}

/** What a newer revision brings that the reader can see: kinds of new rows, or none when only figures or prose moved. */
export type UpdateNews = "findings" | "reports" | "events";
/** A newer read, already loaded, waiting for the reader to take it. */
export type PendingUpdate = { revisions: MapRevisions; patch: Partial<CompanyData>; news: UpdateNews[] };

/** How often a visible page asks whether anything was published; a return to the tab asks at once, at most every half minute. */
const CHECK_EVERY = 3 * 60_000;
const MIN_GAP = 30_000;

type Supplement = "fundamentals" | "events" | "filings";

/** The resource's part of the page's data, read at the given revision; null where the resource has nothing to show. */
async function readResource(ticker: string, resource: MapResource, rev: string | undefined, signal: AbortSignal, response?: Promise<Response>): Promise<Partial<CompanyData> | null> {
  if (resource === "company") {
    const publication = await fetchCompany(ticker, signal, rev, response);
    const flow = publicationFlow(publication, ticker);
    return flow ? { publication, flow } : null;
  }
  if (resource === "findings") {
    const findings = await fetchFindings(ticker, signal, rev, response);
    return findings ? { findings } : null;
  }
  if (resource === "capital") {
    const read = await fetchCapital(ticker, signal, rev, response);
    return read ? { capital: read.capital, peers: read.peers } : null;
  }
  if (resource === "valuation") {
    const valuation = await fetchValuation(ticker, signal, rev, response);
    return valuation ? { valuation } : null;
  }
  const value = await fetchSupplement<CompanyData[Supplement]>(ticker, resource, signal, rev, response);
  return value ? { [resource]: value } : null;
}

const newIds = (next: string[] | undefined, before: string[] | undefined) => !!next?.some(id => !(before ?? []).includes(id));

function newsOf(patch: Partial<CompanyData>, now: CompanyData): UpdateNews[] {
  const news: UpdateNews[] = [];
  if (newIds(patch.findings?.findings.findings.map(f => f.id), now.findings?.findings.findings.map(f => f.id))) news.push("findings");
  if (newIds(patch.filings?.filings.map(f => f.accessionNumber), now.filings?.filings.map(f => f.accessionNumber))
    || newIds(patch.flow?.quarters.map(q => q.periodEnd), now.flow?.quarters.map(q => q.periodEnd))) news.push("reports");
  if (newIds(patch.events?.events.map(e => e.id), now.events?.events.map(e => e.id))) news.push("events");
  return news;
}

/**
 * The company page's data, read at the revisions current when it opens, then kept watch over: while the page is visible
 * it asks for the revisions every few minutes and whenever the reader returns to it. A newer revision is read in the
 * background and offered as a pending update; the page changes only when the reader takes it. The offer is made once
 * per page view: updates arriving while it is up join it, and after it is taken or dismissed none is offered again. A revision whose read
 * shows nothing new, or fills a part the page has nothing for, is taken silently. Only a read that answered moves a
 * resource's revision on, so a failed read is tried again at the next check.
 *
 * First visits commit the primary view, then supplements in one background transition. A language change still
 * commits the whole read together, keeping the current page visible until the translated resources settle.
 */
export function useLiveCompany(ticker: string, onSeen: (ticker: string) => void, opening: CompanyOpening) {
  const locale = useLocale();
  const [data, setData] = useState<CompanyData>(EMPTY);
  const [failed, setFailed] = useState(false);
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [settled, setSettled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<PendingUpdate | null>(null);
  /** The notice comes up once per page view: once the reader takes or dismisses it, later updates wait for the next load. */
  const [closed, setClosed] = useState(false);
  /** How many updates the reader took, so lists can tell rows an update brought from rows that loaded late. */
  const [updates, setUpdates] = useState(0);
  /** The events block's own state, so a failed events read does not take the map down with it. */
  const [eventsPhase, setEventsPhase] = useState<"ready" | "loading" | "error">("loading");
  /** The revisions of what is on screen, per resource that was read; null until the first read has started. */
  const shown = useRef<MapRevisions | null>(null);
  const current = useRef(data);
  const staged = useRef<PendingUpdate | null>(null);
  /** False while an opening read or a language refetch is in flight, so a revision check cannot patch the other language in. */
  const checksReady = useRef(false);
  const loadGen = useRef(0);
  useLayoutEffect(() => { current.current = data; staged.current = pending; });

  useEffect(() => {
    const request = opening.start();
    const { signal } = request;
    const gen = ++loadGen.current;
    const swapping = current.current.flow != null;
    checksReady.current = false;
    if (swapping) setPending(null);
    void (async () => {
      try {
        const commit = (result: OpeningRead, finished = false) => {
          if (signal.aborted || gen !== loadGen.current) return;
          setData(result.data);
          setFailed(result.failed && !result.data.flow);
          setHttpStatus(result.failed && !result.data.flow ? result.httpStatus : null);
          setEventsPhase(result.eventsPhase);
          setReady(true);
          if (finished) setSettled(true);
          shown.current = result.revisions;
        };
        let primaryShown = false;
        const result = await loadOpening(ticker, request, onSeen, location.search, swapping ? undefined : first => {
          if (signal.aborted || gen !== loadGen.current) return;
          primaryShown = true;
          commit(first);
        });
        if (signal.aborted || gen !== loadGen.current) return;
        // A language refetch without a statement keeps the page already on screen.
        if (swapping && !result.data.flow) { setSettled(true); checksReady.current = true; return; }
        const complete = () => commit(result, true);
        if (primaryShown) startTransition(complete);
        else crossfade(() => { stageChartBox(); complete(); }, "map");
        checksReady.current = true;
      } catch {
        if (signal.aborted || gen !== loadGen.current) return;
        if (swapping) { setSettled(true); checksReady.current = true; return; }
        setFailed(true);
        setHttpStatus(0);
        setReady(true);
        setSettled(true);
      }
    })();
    return () => request.abort();
  }, [ticker, attempt, onSeen, locale, opening]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let checking = false, last = Date.now();
    const check = async () => {
      if (checking || !checksReady.current || document.visibilityState !== "visible" || Date.now() - last < MIN_GAP) return;
      const base = shown.current;
      if (!base || !current.current.flow) return;
      checking = true;
      last = Date.now();
      try {
        const latest = await fetchRevisions(ticker, signal);
        if (!latest || signal.aborted) return;
        const resources = resourcesToRead(base, latest, staged.current?.revisions);
        if (!resources.length) return;
        const read = await readRevisions(resources, latest, current.current, (r, rev) => readResource(ticker, r, rev, signal));
        if (signal.aborted) return;
        shown.current = { ...shown.current, ...read.same, ...read.filled.revisions };
        if (Object.keys(read.filled.patch).length) {
          if (read.filled.patch.events) setEventsPhase("ready");
          setData(d => ({ ...d, ...read.filled.patch }));
        }
        const next = nextPending(staged.current, read);
        if (JSON.stringify(next?.revisions ?? null) !== JSON.stringify(staged.current?.revisions ?? null))
          setPending(next && { ...next, news: newsOf(next.patch, { ...current.current, ...read.filled.patch }) });
      } catch { /* The next check tries again. */ } finally { checking = false; }
    };
    const run = () => { void check(); };
    const timer = setInterval(run, CHECK_EVERY);
    document.addEventListener("visibilitychange", run);
    addEventListener("focus", run);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
      removeEventListener("focus", run);
    };
  }, [ticker, locale]);

  const apply = useCallback(() => {
    const update = staged.current;
    if (!update) return;
    setData(d => ({ ...d, ...update.patch }));
    setUpdates(n => n + 1);
    shown.current = { ...shown.current, ...update.revisions };
    setPending(null);
    setClosed(true);
  }, []);
  const dismiss = useCallback(() => setClosed(true), []);
  const retry = useCallback(() => { setFailed(false); setHttpStatus(null); setReady(false); setSettled(false); setEventsPhase("loading"); setData(EMPTY); setPending(null); setAttempt(n => n + 1); }, []);
  const retryEvents = useCallback(() => {
    const controller = new AbortController();
    setEventsPhase("loading");
    void fetchEvents(ticker, controller.signal, shown.current?.events).then(result => {
      if (controller.signal.aborted) return;
      if (result.events) setData(currentData => ({ ...currentData, events: result.events }));
      setEventsPhase(result.error ? "error" : "ready");
    }).catch(error => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setEventsPhase("error");
    });
  }, [ticker]);
  const update = closed ? null : pending;
  return { data, updates, failed, httpStatus, ready, settled, eventsPhase, retry, retryEvents, update, apply, dismiss };
}
