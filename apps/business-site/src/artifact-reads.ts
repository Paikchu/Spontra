import { useEffect, useState } from "react";
import type { PublishedArtifact } from "@/shared/analysis-contract/artifact";

/**
 * A draft the visual review opened through its signed preview link (`?artifact-preview=`): it takes the published
 * artifact's place for this one subject, so the review sees the draft in the real stage.
 */
/** `subject` "*" takes any draft of the kind (a valuation report's subject is its run's generation). */
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

/** A published artifact read from its company route (e.g. "company-analysis", "dossier/<finding>"); null while loading or when there is none. */
export function usePublishedArtifact(ticker: string, path: string | null, version?: number | null): PublishedArtifact | null {
  const [artifact, setArtifact] = useState<PublishedArtifact | null>(null);
  useEffect(() => {
    setArtifact(null);
    if (!path) return;
    const controller = new AbortController();
    fetch(`/api/business/v1/companies/${encodeURIComponent(ticker)}/artifacts/${path}${version ? `?v=${version}` : ""}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() as Promise<{ artifact?: PublishedArtifact | null }> : null)
      .then(body => { if (!controller.signal.aborted && body?.artifact) setArtifact(body.artifact); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [ticker, path, version]);
  return artifact;
}
