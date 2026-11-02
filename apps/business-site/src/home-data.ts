import { useCallback, useEffect, useRef, useState } from "react";
import type { HomeDigest } from "../../../shared/analysis-contract/home.ts";
import { parseHomeDigest } from "./home-model";

const TTL = 10 * 60 * 1000;
const keyOf = (locale: string) => `spontra-home-v1:${locale}`;

export type DigestStatus = "loading" | "ready" | "error";

function readCached(locale: string): HomeDigest | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(keyOf(locale));
    if (!raw) return null;
    const saved = JSON.parse(raw) as { at?: unknown; body?: unknown };
    return typeof saved.at === "number" && Date.now() - saved.at < TTL ? parseHomeDigest(saved.body) : null;
  } catch {
    return null; /* Storage may be disabled. */
  }
}

/**
 * One homepage read, reused by the page and the company-page search.
 * A fresh cached digest (session storage, 10 minutes) is shown from the first paint and read again on every mount; a
 * render without storage (the server-side translation check) reads nothing.
 *
 * `covered` answers for `ticker`: a company the digest in hand does not list is read once more before it counts as not
 * covered, so a newly added company is not turned away by an older copy. undefined while that read is out; null when the
 * catalog could not load.
 */
export function useHomeDigest(locale: string, ticker: string | null = null): { digest: HomeDigest | null; status: DigestStatus; retry: () => void; covered: boolean | null | undefined } {
  const [digest, setDigest] = useState<HomeDigest | null>(() => readCached(locale));
  const [status, setStatus] = useState<DigestStatus>(() => (readCached(locale) ? "ready" : "loading"));
  const [cachedFor, setCachedFor] = useState(locale);
  if (cachedFor !== locale) {
    // A locale switch shows that locale's cached digest at once, as a reset during render rather than an effect.
    setCachedFor(locale);
    const cached = readCached(locale);
    if (cached) {
      setDigest(cached);
      setStatus("ready");
    }
  }
  const [attempt, setAttempt] = useState(0);
  /** `asked` is the ticker the latest read was started for; `answered` the read that has finished. */
  const [rendered, setRendered] = useState(ticker);
  const [asked, setAsked] = useState(ticker);
  const [reads, setReads] = useState(0);
  const [answered, setAnswered] = useState(-1);
  if (rendered !== ticker) {
    setRendered(ticker);
    setAsked(null);
  }
  const listed = !!ticker && !!digest?.companies.some(company => company.ticker === ticker);
  if (ticker && asked !== ticker && !listed && status === "ready") {
    setAsked(ticker);
    setReads(n => n + 1);
  }
  const covered = !ticker ? null : listed ? true : status === "error" ? null : asked === ticker && answered === reads ? false : undefined;
  const retried = useRef(false);
  const retry = useCallback(() => {
    retried.current = false;
    setStatus("loading");
    setAttempt(n => n + 1);
  }, []);

  useEffect(() => {
    let live = true;
    let timer = 0;
    let have = readCached(locale) !== null;
    const controller = new AbortController();
    const read = reads;
    const run = async () => {
      try {
        const response = await fetch(`/api/business/v1/home?lang=${encodeURIComponent(locale)}`, { signal: controller.signal, headers: { accept: "application/json" } });
        if (response.status === 429 && !retried.current) {
          retried.current = true;
          timer = window.setTimeout(() => { if (live) setAttempt(n => n + 1); }, 30_000);
        }
        if (!response.ok) throw new Error(String(response.status));
        const parsed = parseHomeDigest(await response.json());
        if (!parsed) throw new Error("invalid");
        if (!live) return;
        have = true;
        setDigest(parsed);
        setStatus("ready");
        setAnswered(read);
        try { sessionStorage.setItem(keyOf(locale), JSON.stringify({ at: Date.now(), body: parsed })); } catch { /* Storage may be disabled. */ }
      } catch (error) {
        if (!live || (error instanceof DOMException && error.name === "AbortError")) return;
        setAnswered(read);
        if (!have) setStatus("error");
      }
    };
    void run();
    return () => { live = false; controller.abort(); window.clearTimeout(timer); };
  }, [locale, attempt, reads]);

  return { digest, status, retry, covered };
}
