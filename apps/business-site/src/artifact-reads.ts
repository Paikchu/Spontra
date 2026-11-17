import { useEffect, useState, useSyncExternalStore } from "react";
import type { PublishedArtifact } from "@/shared/analysis-contract/artifact";
import { useLocale } from "@/packages/web/src/i18n";
import { COMPANY_READ_SCHEMA } from "./company-opening";

/**
 * A draft the visual review opened through its signed preview link (`?artifact-preview=`): it takes the published
 * artifact's place for this one subject, so the review sees the draft in the real stage.
 */
/** `subject` "*" takes any draft of the kind, as the stage does for its conversation reports. */
const subscribeRoute = (changed: () => void) => { window.addEventListener("popstate", changed); window.addEventListener("spontra:filing-navigation", changed); return () => { window.removeEventListener("popstate", changed); window.removeEventListener("spontra:filing-navigation", changed); }; };
const routeSearch = () => location.search;
export function usePreviewRead(kind: PublishedArtifact["kind"], subject: string | null, ticker?: string): { artifact: PublishedArtifact | null; status: "none" | "loading" | "ready" | "failed"; token: string | null } {
  const search = useSyncExternalStore(subscribeRoute, routeSearch, () => "");
  const token = new URLSearchParams(search).get("artifact-preview");
  const key = JSON.stringify([token, kind, subject, ticker]);
  const [draft, setDraft] = useState<{ key: string; artifact: PublishedArtifact | null } | null>(null);
  useEffect(() => {
    if (token === null || !subject) return;
    const controller = new AbortController();
    fetch(`/api/business/v1/artifact-preview/${encodeURIComponent(token)}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() as Promise<{ artifact: PublishedArtifact }> : null)
      .then(body => { if (!controller.signal.aborted) { const artifact = body?.artifact; setDraft({ key, artifact: artifact && artifact.kind === kind && (subject === "*" || artifact.subject === subject) && (!ticker || artifact.ticker === ticker) ? artifact : null }); } })
      .catch(() => { if (!controller.signal.aborted) setDraft({ key, artifact: null }); });
    return () => controller.abort();
  }, [token, kind, subject, ticker, key]);
  if (token === null || !subject) return { artifact: null, status: "none", token };
  if (draft?.key !== key) return { artifact: null, status: "loading", token };
  return { artifact: draft.artifact, status: draft.artifact ? "ready" : "failed", token };
}
export function usePreview(kind: PublishedArtifact["kind"], subject: string | null): PublishedArtifact | null {
  return usePreviewRead(kind, subject).artifact;
}

/**
 * A published artifact read from its company route (e.g. "company-analysis", "dossier/<finding>"); null while loading or
 * when there is none. `rev` (when it was published) keys the read, so a newer artifact is a new address.
 */
export function usePublishedArtifact(ticker: string, path: string | null, rev?: string | null): PublishedArtifact | null {
  return usePublishedArtifactRead(ticker, path, rev).artifact;
}

/** A dossier distinguishes unfinished analysis from a failed read, and never shows a different revision while loading. */
export function usePublishedArtifactRead(ticker: string, path: string | null, rev?: string | null, retry = 0): { artifact: PublishedArtifact | null; status: "preparing" | "loading" | "ready" | "failed" } {
  const [loaded, setLoaded] = useState<{ key: string; artifact: PublishedArtifact | null; status: "preparing" | "ready" | "failed" } | null>(null);
  const locale = useLocale();
  const key = JSON.stringify([ticker, path, rev, locale, retry]);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ schema: COMPANY_READ_SCHEMA, ...locale === "en" ? {} : { lang: locale }, ...rev ? { rev } : {} });
    fetch(`/api/business/v1/companies/${encodeURIComponent(ticker)}/artifacts/${path}${params.size ? `?${params}` : ""}`, { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error(`Artifact read failed: ${r.status}`); return r.json() as Promise<{ artifact?: PublishedArtifact | null }>; })
      .then(body => { if (!controller.signal.aborted) setLoaded({ key, artifact: body.artifact ?? null, status: body.artifact ? "ready" : "preparing" }); })
      .catch(() => { if (!controller.signal.aborted) setLoaded({ key, artifact: null, status: "failed" }); });
    return () => controller.abort();
  }, [ticker, path, rev, locale, key]);
  return loaded?.key === key ? loaded : { artifact: null, status: path ? "loading" : "preparing" };
}
