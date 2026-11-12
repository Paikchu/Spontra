import { useEffect, useState } from "react";
import type { PublishedArtifact } from "@/shared/analysis-contract/artifact";
import { useLocale } from "@/packages/web/src/i18n";

/**
 * A draft the visual review opened through its signed preview link (`?artifact-preview=`): it takes the published
 * artifact's place for this one subject, so the review sees the draft in the real stage.
 */
/** `subject` "*" takes any draft of the kind, as the stage does for its conversation reports. */
export function usePreview(kind: PublishedArtifact["kind"], subject: string | null): PublishedArtifact | null {
  const [token] = useState(() => new URLSearchParams(location.search).get("artifact-preview"));
  const [draft, setDraft] = useState<PublishedArtifact | null>(null);
  useEffect(() => {
    if (!token || !subject) return;
    const controller = new AbortController();
    fetch(`/api/business/v1/artifact-preview/${encodeURIComponent(token)}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() as Promise<{ artifact: PublishedArtifact }> : null)
      .then(body => { if (body?.artifact && body.artifact.kind === kind && (subject === "*" || body.artifact.subject === subject)) setDraft(body.artifact); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [token, kind, subject]);
  return draft;
}

/**
 * A published artifact read from its company route (e.g. "company-analysis", "dossier/<finding>"); null while loading or
 * when there is none. `rev` (when it was published) keys the read, so a newer artifact is a new address.
 */
export function usePublishedArtifact(ticker: string, path: string | null, rev?: string | null): PublishedArtifact | null {
  const [loaded, setLoaded] = useState<{ ticker: string; path: string; artifact: PublishedArtifact } | null>(null);
  const locale = useLocale();
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ schema: "artifact-i18n-v1", ...locale === "en" ? {} : { lang: locale }, ...rev ? { rev } : {} });
    fetch(`/api/business/v1/companies/${encodeURIComponent(ticker)}/artifacts/${path}${params.size ? `?${params}` : ""}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() as Promise<{ artifact?: PublishedArtifact | null }> : null)
      .then(body => { if (!controller.signal.aborted && body?.artifact) setLoaded({ ticker, path, artifact: body.artifact }); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [ticker, path, rev, locale]);
  return loaded?.ticker === ticker && loaded.path === path ? loaded.artifact : null;
}
