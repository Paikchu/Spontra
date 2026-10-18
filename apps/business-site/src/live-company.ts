import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";
import type { EventsPublication } from "@/shared/analysis-contract/events";
import type { PublicFilingDigestPage } from "@/shared/analysis-contract/filings";
import type { MapResource, MapRevisions } from "@/shared/analysis-contract/revisions";
import type { FindingFundamentals } from "@/shared/analysis-runtime/findings";
import { fetchCompany, fetchFindings, fetchRevisions, fetchSupplement, publicationFlow, type CompanyPublication, type FindingsBundle } from "./company-data";
import { nextPending, readRevisions, resourcesToRead } from "./revision-reads";

/** Everything the company page draws from, as one value so a newer read can replace parts of it at once. */
export type CompanyData = {
  publication: CompanyPublication | null;
  flow: PublicBusinessFlow | null;
  capital: PublicCapitalStructure | null;
  findings: FindingsBundle | null;
  fundamentals: FindingFundamentals | null;
  events: EventsPublication | null;
  filings: PublicFilingDigestPage | null;
};
const EMPTY: CompanyData = { publication: null, flow: null, capital: null, findings: null, fundamentals: null, events: null, filings: null };

/** What a newer revision brings that the reader can see: kinds of new rows, or none when only figures or prose moved. */
export type UpdateNews = "findings" | "reports" | "events";
/** A newer read, already loaded, waiting for the reader to take it. */
export type PendingUpdate = { revisions: MapRevisions; patch: Partial<CompanyData>; news: UpdateNews[] };

/** How often a visible page asks whether anything was published; a return to the tab asks at once, at most every half minute. */
const CHECK_EVERY = 3 * 60_000;
const MIN_GAP = 30_000;

type Supplement = "capital" | "fundamentals" | "events" | "filings";

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
 */
export function useLiveCompany(ticker: string, onSeen: (ticker: string) => void) {
  const [data, setData] = useState<CompanyData>(EMPTY);
  const [failed, setFailed] = useState(false);
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
  useLayoutEffect(() => { current.current = data; staged.current = pending; });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const revisions = await fetchRevisions(ticker, signal).catch(() => null);
      if (signal.aborted) return;
      // Without revisions the page still loads; the first check then reads everything and keeps what differs.
      shown.current = {};
      const seen = (resource: MapResource) => { const rev = revisions?.[resource]; if (rev) shown.current = { ...shown.current, [resource]: rev }; };
      fetchCompany(ticker, signal, revisions?.company)
        .then(publication => {
          if (signal.aborted) return;
          onSeen(ticker);
          const flow = publicationFlow(publication, ticker);
          if (flow) seen("company");
          setData(d => ({ ...d, publication, flow }));
        })
        .catch(() => { if (!signal.aborted) setFailed(true); });
      // Balance sheet, cash flow, findings and the SEC series they resolve against load on their own; the map is drawn without waiting for them.
      for (const resource of ["capital", "findings", "fundamentals", "events", "filings"] as const)
        readResource(ticker, resource, revisions?.[resource], signal)
          .then(part => { if (!signal.aborted && part) { seen(resource); setData(d => ({ ...d, ...part })); } })
          .catch(() => { /* Supplementary: the map stands on its own. */ });
    })();
    return () => controller.abort();
  }, [ticker, attempt, onSeen]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let checking = false, last = Date.now();
    const check = async () => {
      if (checking || document.visibilityState !== "visible" || Date.now() - last < MIN_GAP) return;
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
  }, [ticker]);

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
  const retry = useCallback(() => { setFailed(false); setAttempt(n => n + 1); }, []);
  const update = closed ? null : pending;
  return { data, updates, failed, retry, update, apply, dismiss };
}
