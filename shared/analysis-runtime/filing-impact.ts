import type { PublishedArtifact } from "../analysis-contract/artifact.ts";
import type { FilingImpactPublication } from "../analysis-contract/filing-impact.ts";

/** Translated HTML retains its canonical source identity; a later filing can never fill an older edition's bridge. */
export function filingImpactOf(artifact: PublishedArtifact | null | undefined): FilingImpactPublication | null {
  const impact = artifact?.filingImpact;
  if (!artifact || !impact || impact.schemaVersion !== "filing-impact.v1") return null;
  const source = impact.artifact;
  return source.id === artifact.id && source.ticker === artifact.ticker && source.accession === artifact.subject
    && source.version === artifact.version && source.hash === (artifact.sourceHash ?? artifact.hash) ? impact : null;
}

export type FilingImpactSelection = { accession: string; version: string; hash: string; preview: string | null };
export function filingImpactSelection(params: URLSearchParams): FilingImpactSelection | null {
  const accession = params.get("filingImpact");
  if (accession === null) return null;
  return { accession, version: params.get("artifactVersion") ?? "", hash: params.get("artifactHash") ?? "", preview: params.get("artifact-preview") };
}
export function validFilingImpactSelection(selection: FilingImpactSelection): boolean {
  return /^\d{10}-\d{2}-\d{6}$/.test(selection.accession) && /^[1-9]\d{0,8}$/.test(selection.version) && /^[0-9a-f]{64}$/.test(selection.hash);
}

export function filingImpactLink(artifact: PublishedArtifact, locale: string, preview?: string | null): string {
  const params = new URLSearchParams({ view: "valuation", filingImpact: artifact.subject, artifactVersion: String(artifact.version), artifactHash: artifact.sourceHash ?? artifact.hash, lang: locale });
  if (preview) params.set("artifact-preview", preview);
  return `/companies/${encodeURIComponent(artifact.ticker)}?${params}`;
}
