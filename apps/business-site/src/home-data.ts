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
 * A fresh cached digest (session storage, 10 minutes) is shown from the first paint; a render without
 * storage (the server-side translation check) reads nothing.
 */
export function useHomeDigest(locale: string): { digest: HomeDigest | null; status: DigestStatus; retry: () => void } {
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
        try { sessionStorage.setItem(keyOf(locale), JSON.stringify({ at: Date.now(), body: parsed })); } catch { /* Storage may be disabled. */ }
      } catch (error) {
        if (!live || (error instanceof DOMException && error.name === "AbortError")) return;
        if (!have) setStatus("error");
      }
    };
    void run();
    return () => { live = false; controller.abort(); window.clearTimeout(timer); };
  }, [locale, attempt]);

  return { digest, status, retry };
}
