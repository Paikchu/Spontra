import { useCallback, useEffect, useRef, useState } from "react";
import type { HomeDigest } from "../../../shared/analysis-contract/home.ts";
import { parseHomeDigest } from "./home-model";

const TTL = 10 * 60 * 1000;
const keyOf = (locale: string) => `spontra-home-v1:${locale}`;

export type DigestStatus = "loading" | "ready" | "error";

/**
 * One homepage read, reused by the page and the company-page search.
 * Storage is read in an effect so a render (including the translation check) never touches it.
 */
export function useHomeDigest(locale: string): { digest: HomeDigest | null; status: DigestStatus; retry: () => void } {
  const [digest, setDigest] = useState<HomeDigest | null>(null);
  const [status, setStatus] = useState<DigestStatus>("loading");
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
    let have = false;
    const controller = new AbortController();
    try {
      const raw = sessionStorage.getItem(keyOf(locale));
      if (raw) {
        const saved = JSON.parse(raw) as { at?: unknown; body?: unknown };
        const parsed = typeof saved.at === "number" && Date.now() - saved.at < TTL ? parseHomeDigest(saved.body) : null;
        if (parsed) {
          have = true;
          setDigest(parsed);
          setStatus("ready");
        }
      }
    } catch {
      /* Storage may be disabled. */
    }
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
