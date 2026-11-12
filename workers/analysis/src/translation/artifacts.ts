import type { ArtifactDocument } from "../../../../shared/analysis-contract/artifact.ts";
import { extractArtifactTranslation } from "../../../../shared/analysis-runtime/artifact/localization.ts";
import { documentHtml } from "../artifact/document.ts";
import { previewToken, readArtifactTranslation, readArtifactVersion, recordCheck, type ArtifactStoreEnv, type StoredArtifact } from "../artifact/store.ts";
import { reviewRendering } from "../artifact/qa.ts";
import type { AnalysisEnv } from "../operations.ts";
import { outboxStatement } from "../pipeline/outbox.ts";
import { sha256 } from "../sha256.ts";
import { readStoredFindings } from "../findings/read.ts";

export type ArtifactSource = {
  resource: "artifact"; scope: string; strings: string[];
  artifact: { id: string; stored: StoredArtifact; plan: ReturnType<typeof extractArtifactTranslation> };
};

export async function readArtifactSources(env: ArtifactStoreEnv, ticker: string): Promise<ArtifactSource[]> {
  const findings = await readStoredFindings(env.DB!, ticker);
  const prefix = findings?.fingerprint ? `${findings.fingerprint.slice(0, 16)}.` : "";
  const rows = (await env.DB!.prepare("SELECT artifact_id, published_version FROM analysis_artifacts WHERE ticker = ? AND published_version IS NOT NULL AND (kind != 'dossier' OR (? != '' AND substr(subject,1,?) = ?)) ORDER BY CASE kind WHEN 'filing-report' THEN 0 WHEN 'company-analysis' THEN 1 ELSE 2 END, published_at DESC")
    .bind(ticker, prefix, prefix.length, prefix).all<{ artifact_id: string; published_version: number }>()).results;
  const sources: ArtifactSource[] = [];
  for (const row of rows) {
    const stored = await readArtifactVersion(env, row.artifact_id, row.published_version);
    if (!stored || stored.document.lang === "zh-CN") continue;
    const plan = extractArtifactTranslation(stored.document);
    sources.push({ resource: "artifact", scope: `${row.artifact_id}@${row.published_version}`, strings: plan.units.map(u => u.text), artifact: { id: row.artifact_id, stored, plan } });
  }
  return sources;
}

export async function artifactSourceSettled(env: Pick<ArtifactStoreEnv, "DB">, source: ArtifactSource, version: string): Promise<boolean> {
  const row = await readArtifactTranslation(env, source.artifact.id, source.artifact.stored.document.version, source.artifact.stored.hash);
  return !!row && row.translator_version === version && (row.status === "ready" || row.status === "failed");
}

export async function artifactTranslationProgress(env: ArtifactStoreEnv, source: ArtifactSource, version: string, completed: number, failed: boolean): Promise<void> {
  const { id, stored, plan } = source.artifact;
  const status = failed ? "failed" : "translating", at = new Date().toISOString();
  const previous = await readArtifactTranslation(env, id, stored.document.version, stored.hash);
  if (previous?.translator_version === version && previous.status === status && previous.completed === completed && previous.total === plan.units.length) return;
  await env.DB!.batch([env.DB!.prepare(`INSERT INTO analysis_artifact_translations
    (artifact_id, source_version, source_hash, locale, translator_version, status, completed, total, updated_at)
    VALUES (?, ?, ?, 'zh-CN', ?, ?, ?, ?, ?)
    ON CONFLICT(artifact_id, source_version, locale) DO UPDATE SET source_hash=excluded.source_hash,
      translator_version=excluded.translator_version, status=excluded.status, completed=excluded.completed,
      total=excluded.total, error=NULL, updated_at=excluded.updated_at`)
    .bind(id, stored.document.version, stored.hash, version, status, completed, plan.units.length, at),
    outboxStatement(env.DB!, { type: "translations.published", ticker: stored.document.ticker }, at)]);
}

export type TranslationReview = (pairs: Array<{ source: string; target: string; context: string; values: Readonly<Record<string, string>> }>) => Promise<{ problems: string[]; translations: string[] }>;
export class ArtifactTranslationDeferred extends Error {}

/** A translation has its own R2 object and D1 pointer; the original artifact is never rewritten. */
export async function publishArtifactTranslation(env: AnalysisEnv, source: ArtifactSource, values: ReadonlyMap<string, string>, version: string,
  runId: string, review: TranslationReview): Promise<boolean> {
  const { id, stored, plan } = source.artifact;
  if (await artifactSourceSettled(env, source, version)) return false;
  const db = env.DB!, doc = stored.document;
  let translated: ArtifactDocument;
  try {
    const reviewed = await review(plan.units.map(u => ({ source: u.text, target: values.get(u.id)!, context: u.context, values: u.values })));
    if (reviewed.problems.length) throw new Error(reviewed.problems.join("; "));
    translated = plan.apply(new Map(plan.units.map((unit, index) => [unit.id, reviewed.translations[index]!] as const)));
    const html = documentHtml(translated), hash = await sha256(`${html}\n${stored.css}`);
    const key = `artifact-translations/${id.replace(/:/g, "/")}/v${doc.version}/zh-CN/${version}/${hash}.json`;
    await env.SEC_FILINGS!.put(key, JSON.stringify({ document: translated, html, css: stored.css, hash, degraded: stored.degraded } satisfies StoredArtifact), { httpMetadata: { contentType: "application/json" } });
    const checkingAt = new Date().toISOString();
    await db.batch([db.prepare("UPDATE analysis_artifact_translations SET status='checking', r2_key=?, hash=?, updated_at=? WHERE artifact_id=? AND source_version=? AND locale='zh-CN' AND source_hash=?")
      .bind(key, hash, checkingAt, id, doc.version, stored.hash), outboxStatement(db, { type: "translations.published", ticker: doc.ticker }, checkingAt)]);
    const token = await previewToken(env, doc.kind, doc.ticker, doc.subject, doc.version, Date.now(), "zh-CN");
    const origin = env.BUSINESS_SITE_ORIGIN!;
    const url = new URL(`/companies/${encodeURIComponent(doc.ticker)}`, origin);
    if (doc.kind === "filing-report") url.searchParams.set("report", doc.subject);
    else if (doc.kind === "company-analysis") url.searchParams.set("view", "company");
    else if (doc.kind === "dossier") url.searchParams.set("finding", doc.subject.slice(doc.subject.indexOf(".") + 1));
    url.searchParams.set("lang", "zh-CN"); url.searchParams.set("artifact-preview", token);
    // Translation checks exercise the actual report and its interactions, without another content-generation run.
    const qa = await reviewRendering(env, url.href, doc.blocks.map(b => b.id), { ticker: doc.ticker, runId }, { visual: false, expectedHash: hash });
    await recordCheck(env, doc.kind, doc.ticker, doc.subject, doc.version, "translation:zh-CN", 1, { sourceHash: stored.hash, translatedHash: hash, ...qa });
    if (qa.unavailable || qa.errors?.length) throw new ArtifactTranslationDeferred(qa.unavailable || qa.errors!.join("; "));
    if (qa.issues.some(i => i.severity === "blocker" || i.severity === "major"))
      throw new Error(qa.issues.filter(i => i.severity !== "minor").map(i => `${i.block}: ${i.problem}`).join("; "));
    const at = new Date().toISOString();
    await db.batch([
      db.prepare("UPDATE analysis_artifact_translations SET status='ready', completed=total, error=NULL, published_r2_key=r2_key, published_hash=hash, published_at=?, updated_at=? WHERE artifact_id=? AND source_version=? AND locale='zh-CN' AND source_hash=?")
        .bind(at, at, id, doc.version, stored.hash),
      outboxStatement(db, { type: "translations.published", ticker: doc.ticker }, at),
    ]);
    return true;
  } catch (error) {
    const failedAt = new Date().toISOString();
    await db.batch([db.prepare("UPDATE analysis_artifact_translations SET status=?, error=?, updated_at=? WHERE artifact_id=? AND source_version=? AND locale='zh-CN' AND source_hash=?")
      .bind(error instanceof ArtifactTranslationDeferred ? "translating" : "failed", error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000), failedAt, id, doc.version, stored.hash),
      outboxStatement(db, { type: "translations.published", ticker: doc.ticker }, failedAt)]);
    console.error(JSON.stringify({ event: "artifact-translation-failed", artifact: id, version: doc.version, error: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}
