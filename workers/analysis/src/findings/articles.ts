import { dossierPresentation } from "../../../../shared/analysis-runtime/artifact/dossier-presentation.ts";
import { SEC_DOMAIN } from "../../../../shared/analysis-runtime/sec-sources.ts";
import type { FindingsPublication, FindingsResponse, PublishedFindingArticle } from "../../../../shared/analysis-contract/findings.ts";
import { findingLeadsOf } from "../../../../shared/analysis-runtime/findings.ts";
import { isLocale, type Locale } from "../../../../shared/analysis-runtime/locale.ts";
import { dossierSubject, readArtifactVersion, localizedEdition, artifactId, type ArtifactStoreEnv } from "../artifact/store.ts";

/** Read a single published pointer, then pin both the source and translated title to that exact version. */
export async function enrichFindings(env: ArtifactStoreEnv, response: FindingsResponse, chinese: FindingsPublication | null, locale: Locale): Promise<FindingsResponse> {
  const original = response.findings;
  if (!original || !chinese) return response;
  const publication = locale === "zh-CN" ? chinese : original;
  const chineseLeads = new Map(findingLeadsOf(chinese).map(lead => [lead.id, lead.title]));
  const navigationTitles = Object.fromEntries(findingLeadsOf(original).map(lead => [lead.id, { en: lead.title, "zh-CN": chineseLeads.get(lead.id) ?? lead.title }]));
  const findings = { ...publication, ...(response.pendingResearch ? { pendingResearch: response.pendingResearch } : {}), navigationTitles };
  const { fingerprint } = original;
  const database = env.DB;
  if (!fingerprint || !database) return { ...response, findings };
  const entries = await Promise.all(Object.keys(response.dossiers ?? {}).map(async findingId => {
    const subject = dossierSubject(fingerprint, findingId);
    const id = artifactId("dossier", publication.ticker, subject);
    const row = await database.prepare("SELECT published_version, published_at FROM analysis_artifacts WHERE artifact_id = ? AND published_version IS NOT NULL")
      .bind(id).first<{ published_version: number; published_at: string }>();
    if (!row) return null;
    const stored = await readArtifactVersion(env, id, row.published_version);
    if (!stored) return null;
    const source = dossierPresentation(stored.document);
    const sourceLang = isLocale(stored.document.lang) ? stored.document.lang : "en";
    const localized = await localizedEdition(env, id, stored, row.published_at, "zh-CN");
    const artifact = locale === "zh-CN" ? localized : { title: source.title, lang: sourceLang, version: stored.document.version, hash: stored.hash };
    const sourceAccessions = [...new Set(stored.document.sources.flatMap(source => {
      if (!source.url) return [];
      // SEC archive URLs contain the full 18-digit accession directory. No date-nearest guessing.
      let url: URL;
      try { url = new URL(source.url); } catch { return []; }
      if (url.protocol !== "https:" || ![SEC_DOMAIN, `www.${SEC_DOMAIN}`].includes(url.hostname)) return [];
      const match = /^\/Archives\/edgar\/data\/\d+\/(\d{10})(\d{2})(\d{6})(?:\/|$)/i.exec(url.pathname);
      return match ? [`${match[1]}-${match[2]}-${match[3]}`] : [];
    }))];
    const article: PublishedFindingArticle = { findingId, status: source.status, title: artifact.title, lang: artifact.lang, version: artifact.version, hash: artifact.hash,
      publishedAt: row.published_at, periodEnd: publication.periodEnd, sourceAccessions, subject };
    return { article, sourceTitle: source.title, sourceLang, localizedTitle: localized.lang === "zh-CN" ? localized.title : null };
  }));
  const articles = Object.fromEntries(entries.flatMap(entry => {
    if (!entry) return [];
    const { article, sourceTitle, sourceLang, localizedTitle } = entry;
    const titles = navigationTitles[article.findingId];
    if (titles && sourceLang === "en") titles.en = sourceTitle;
    if (titles && localizedTitle) titles["zh-CN"] = localizedTitle;
    return [[article.findingId, article]];
  }));
  return { ...response, findings: { ...findings, articles } };
}
