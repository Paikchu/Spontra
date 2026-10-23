import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocale } from "@/packages/web/src/i18n";
import { stageChartBox } from "./chart-box";
import { crossfade } from "./page-turn";
import type { PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";
import type { PeersPublication } from "@/shared/analysis-contract/peers";
import type { EventsPublication } from "@/shared/analysis-contract/events";
import type { PublicFilingDigestPage } from "@/shared/analysis-contract/filings";
import type { MapResource, MapRevisions } from "@/shared/analysis-contract/revisions";
import type { FindingFundamentals } from "@/shared/analysis-runtime/findings";
import { fetchCapital, fetchCompany, fetchFindings, fetchRevisions, fetchSupplement, publicationFlow, type CompanyPublication, type FindingsBundle } from "./company-data";
import { nextPending, readRevisions, resourcesToRead } from "./revision-reads";

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
};
const EMPTY: CompanyData = { publication: null, flow: null, capital: null, peers: null, findings: null, fundamentals: null, events: null, filings: null };

/** What the company page shows. The map waits until the opening read has settled, so it never paints half-empty. */
export type { OpeningFace } from "./opening-face";
export { openingFace } from "./opening-face";

const OPENING_RESOURCES = ["capital", "findings", "fundamentals", "events", "filings"] as const;

/** One settled read of everything the first paint draws. A failed supplement leaves its part empty; a failed company is `failed`. */
async function loadOpening(ticker: string, signal: AbortSignal, onSeen: (ticker: string) => void): Promise<{ data: CompanyData; failed: boolean; revisions: MapRevisions }> {
  const revisions = await fetchRevisions(ticker, signal).catch(() => null);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const data: CompanyData = { ...EMPTY };
  const got: MapRevisions = {};
  let failed = false;
  const take = (resource: MapResource) => { const rev = revisions?.[resource]; if (rev) got[resource] = rev; };
  const aborted = (error: unknown) => signal.aborted || (error instanceof DOMException && error.name === "AbortError");
  await Promise.all([
    fetchCompany(ticker, signal, revisions?.company).then(publication => {
      if (signal.aborted) return;
      onSeen(ticker);
      const flow = publicationFlow(publication, ticker);
      data.publication = publication;
      data.flow = flow;
      if (flow) take("company");
    }).catch(error => { if (aborted(error)) throw error; failed = true; }),
    ...OPENING_RESOURCES.map(resource => readResource(ticker, resource, revisions?.[resource], signal).then(part => {
      if (part) { Object.assign(data, part); take(resource); }
    }).catch(error => { if (aborted(error)) throw error; })),
  ]);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return { data, failed, revisions: got };
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
async function readResource(ticker: string, resource: MapResource, rev: string | undefined, signal: AbortSignal): Promise<Partial<CompanyData> | null> {
  if (resource === "company") {
    const publication = await fetchCompany(ticker, signal, rev);
    const flow = publicationFlow(publication, ticker);
    return flow ? { publication, flow } : null;
  }
  if (resource === "findings") {
    const findings = await fetchFindings(ticker, signal, rev);
    return findings ? { findings } : null;
  }
  if (resource === "capital") {
    const read = await fetchCapital(ticker, signal, rev);
    return read ? { capital: read.capital, peers: read.peers } : null;
  }
  const value = await fetchSupplement<CompanyData[Supplement]>(ticker, resource, signal, rev);
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
 * The opening read of a company, and a language change, each commit once: the map stays on its skeleton or on the
 * page already up until every resource has answered, then crossfades. A language change never clears what is showing.
 */
export function useLiveCompany(ticker: string, onSeen: (ticker: string) => void) {
  const locale = useLocale();
  const [data, setData] = useState<CompanyData>(EMPTY);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<PendingUpdate | null>(null);
  /** The notice comes up once per page view: once the reader takes or dismisses it, later updates wait for the next load. */
  const [closed, setClosed] = useState(false);
  /** How many updates the reader took, so lists can tell rows an update brought from rows that loaded late. */
  const [updates, setUpdates] = useState(0);
  /** The revisions of what is on screen, per resource that was read; null until the first read has started. */
  const shown = useRef<MapRevisions | null>(null);
  const current = useRef(data);
  const staged = useRef<PendingUpdate | null>(null);
  /** False while an opening read or a language refetch is in flight, so a revision check cannot patch the other language in. */
  const checksReady = useRef(false);
  const loadGen = useRef(0);
  useLayoutEffect(() => { current.current = data; staged.current = pending; });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const gen = ++loadGen.current;
    const swapping = current.current.flow != null;
    checksReady.current = false;
    if (swapping) setPending(null);
    void (async () => {
      try {
        const result = await loadOpening(ticker, signal, onSeen);
        if (signal.aborted || gen !== loadGen.current) return;
        // A language refetch that came back without a statement leaves the page that is already up.
        if (swapping && !result.data.flow) { checksReady.current = true; return; }
        const commit = () => {
          stageChartBox();
          setData(result.data);
          setFailed(result.failed && !result.data.flow);
          setReady(true);
          shown.current = result.revisions;
          checksReady.current = true;
        };
        crossfade(commit, "map");
      } catch {
        if (signal.aborted || gen !== loadGen.current) return;
        if (swapping) { checksReady.current = true; return; }
        setFailed(true);
        setReady(true);
      }
    })();
    return () => controller.abort();
  }, [ticker, attempt, onSeen, locale]);

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
        if (Object.keys(read.filled.patch).length) setData(d => ({ ...d, ...read.filled.patch }));
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
  const retry = useCallback(() => { setFailed(false); setReady(false); setData(EMPTY); setPending(null); setAttempt(n => n + 1); }, []);
  const update = closed ? null : pending;
  return { data, updates, failed, ready, retry, update, apply, dismiss };
}
