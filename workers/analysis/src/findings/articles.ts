import { SEC_DOMAIN } from "../../../../shared/analysis-runtime/sec-sources.ts";
import type { FindingsResponse, PublishedFindingArticle } from "../../../../shared/analysis-contract/findings.ts";
import type { Locale } from "../../../../shared/analysis-runtime/locale.ts";
import { dossierSubject, readArtifactVersion, localizedEdition, artifactId, type ArtifactStoreEnv } from "../artifact/store.ts";

/** Read a single published pointer, then pin both the source and translated title to that exact version. */
export async function enrichFindings(env: ArtifactStoreEnv, response: FindingsResponse, locale: Locale = "en"): Promise<FindingsResponse> {
  const publication = response.findings;
  if (!publication?.fingerprint || !env.DB) return response;
  const articles = await Promise.all(Object.keys(response.dossiers ?? {}).map(async (findingId): Promise<PublishedFindingArticle | null> => {
    const subject = dossierSubject(publication.fingerprint!, findingId);
    const id = artifactId("dossier", publication.ticker, subject);
    const row = await env.DB!.prepare("SELECT published_version, published_at FROM analysis_artifacts WHERE artifact_id = ? AND published_version IS NOT NULL")
      .bind(id).first<{ published_version: number; published_at: string }>();
    if (!row) return null;
    const stored = await readArtifactVersion(env, id, row.published_version);
    if (!stored) return null;
    const artifact = await localizedEdition(env, id, stored, row.published_at, locale);
    const sourceAccessions = [...new Set(stored.document.sources.flatMap(source => {
      if (!source.url) return [];
      // SEC archive URLs contain the full 18-digit accession directory. No date-nearest guessing.
      let url: URL;
      try { url = new URL(source.url); } catch { return []; }
      if (url.protocol !== "https:" || ![SEC_DOMAIN, `www.${SEC_DOMAIN}`].includes(url.hostname)) return [];
      const match = /^\/Archives\/edgar\/data\/\d+\/(\d{10})(\d{2})(\d{6})(?:\/|$)/i.exec(url.pathname);
      return match ? [`${match[1]}-${match[2]}-${match[3]}`] : [];
    }))];
    return { findingId, title: artifact.title, lang: artifact.lang, version: artifact.version, hash: artifact.hash,
      publishedAt: row.published_at, periodEnd: publication.periodEnd, sourceAccessions, subject };
  }));
  return { ...response, findings: { ...publication, ...(response.pendingResearch ? { pendingResearch: response.pendingResearch } : {}), articles: Object.fromEntries(articles.filter((a): a is PublishedFindingArticle => a !== null).map(a => [a.findingId, a])) } };
}
