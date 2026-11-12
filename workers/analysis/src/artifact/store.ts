import type { ArtifactDocument, ArtifactKind, PublishedArtifact } from "../../../../shared/analysis-contract/artifact.ts";
import { sha256 } from "../sha256.ts";
import { documentHtml } from "./document.ts";
import { isLocale, type Locale } from "../../../../shared/analysis-runtime/locale.ts";

/**
 * Artifact persistence (docs/analysis-html-artifact.md §7.7, §8): every draft the visual review renders and every
 * published version is an immutable R2 object holding the document, its HTML and its compiled CSS; D1 points at the
 * published version and records each check. A published version is exactly the HTML that passed its checks.
 */
type Bucket = { get(key: string): Promise<{ text(): Promise<string> } | null>; put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown> };
export type ArtifactStoreEnv = { DB?: D1Database; SEC_FILINGS: Bucket; REPORT_ADMIN_PASSWORD?: string; DEEPSEEK_API_KEY?: string };
export type StoredArtifact = { document: ArtifactDocument; html: string; css: string; hash: string; degraded: string[] };
type Stored = StoredArtifact;
export type ArtifactTranslationRow = {
  artifact_id: string; source_version: number; source_hash: string; locale: "zh-CN"; translator_version: string;
  status: "translating" | "checking" | "ready" | "failed"; completed: number; total: number;
  r2_key: string | null; hash: string | null; error: string | null; updated_at: string;
};

export const artifactId = (kind: ArtifactKind, ticker: string, subject: string) => `${kind}:${ticker}:${subject}`;
/** A finding's dossier is bound to the findings publication it was written for: a new publication waits for its own. */
export const dossierSubject = (findingsFingerprint: string, findingId: string) => `${findingsFingerprint.slice(0, 16)}.${findingId}`;

/** The findings of this publication whose dossier artifact is published, with when each was published (the page's cache key). */
export async function publishedDossiers(db: D1Database, ticker: string, findingsFingerprint: string): Promise<Record<string, string>> {
  const prefix = `${findingsFingerprint.slice(0, 16)}.`;
  const rows = await db.prepare("SELECT subject, published_at FROM analysis_artifacts WHERE kind = 'dossier' AND ticker = ? AND published_version IS NOT NULL AND substr(subject, 1, ?) = ?")
    .bind(ticker, prefix.length, prefix).all<{ subject: string; published_at: string }>().catch(() => ({ results: [] as Array<{ subject: string; published_at: string }> }));
  return Object.fromEntries(rows.results.map(r => [r.subject.slice(prefix.length), r.published_at]));
}
const objectKey = (id: string, version: number) => `artifacts/${id.replace(/[^A-Za-z0-9:._-]/g, "_").replace(/:/g, "/")}/v${version}.json`;

/** Saves a version and returns its number and hash; the same HTML and CSS saved again is the same version. */
export async function saveVersion(env: ArtifactStoreEnv, document: Omit<ArtifactDocument, "version">, css: string, status: "draft" | "published", runId: string | null): Promise<{ version: number; hash: string; html: string }> {
  const db = env.DB!;
  const id = artifactId(document.kind, document.ticker, document.subject);
  const next = ((await db.prepare("SELECT MAX(version) v FROM analysis_artifact_versions WHERE artifact_id = ?").bind(id).first<{ v: number | null }>())?.v ?? 0) + 1;
  const full: ArtifactDocument = { ...document, version: next };
  const html = documentHtml(full);
  const hash = await sha256(`${html}\n${css}`);
  const same = await db.prepare("SELECT version FROM analysis_artifact_versions WHERE artifact_id = ? AND hash = ? ORDER BY version DESC LIMIT 1").bind(id, hash).first<{ version: number }>();
  if (same && status === "draft") return { version: same.version, hash, html };
  const degraded = full.blocks.filter(b => b.state === "conservative" || b.state === "safe-layout").map(b => b.id);
  const key = objectKey(id, next);
  await env.SEC_FILINGS.put(key, JSON.stringify({ document: full, html, css, hash, degraded } satisfies Stored), { httpMetadata: { contentType: "application/json" } });
  const at = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO analysis_artifacts (artifact_id, kind, ticker, subject, title, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(artifact_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`).bind(id, full.kind, full.ticker, full.subject, full.title, at),
    db.prepare("INSERT INTO analysis_artifact_versions (artifact_id, version, status, r2_key, hash, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, next, status, key, hash, runId, at),
  ]);
  return { version: next, hash, html };
}

/** Marks a saved version published; the caller commits any statements of its own (events, pointers) in the same batch. */
export function publishStatements(env: ArtifactStoreEnv, kind: ArtifactKind, ticker: string, subject: string, version: number, hash: string, degraded: string[], at: string): D1PreparedStatement[] {
  const db = env.DB!;
  const id = artifactId(kind, ticker, subject);
  return [
    db.prepare("UPDATE analysis_artifact_versions SET status = 'superseded' WHERE artifact_id = ? AND status = 'published'").bind(id),
    db.prepare("UPDATE analysis_artifact_versions SET status = 'published' WHERE artifact_id = ? AND version = ? AND hash = ?").bind(id, version, hash),
    db.prepare("UPDATE analysis_artifacts SET published_version = ?, published_hash = ?, published_at = ?, degraded = ?, updated_at = ? WHERE artifact_id = ?").bind(version, hash, at, JSON.stringify(degraded), at, id),
  ];
}

export async function readArtifactVersion(env: ArtifactStoreEnv, id: string, version: number): Promise<(Stored & { createdAt: string }) | null> {
  const row = await env.DB!.prepare("SELECT r2_key, created_at FROM analysis_artifact_versions WHERE artifact_id = ? AND version = ?").bind(id, version).first<{ r2_key: string; created_at: string }>();
  const object = row ? await env.SEC_FILINGS.get(row.r2_key) : null;
  return object ? { ...JSON.parse(await object.text()) as Stored, createdAt: row!.created_at } : null;
}

/** The published artifact for a subject, as the map reads it. */
export async function readPublishedArtifact(env: ArtifactStoreEnv, kind: ArtifactKind, ticker: string, subject: string, locale?: Locale | null): Promise<PublishedArtifact | null> {
  const id = artifactId(kind, ticker, subject);
  const row = await env.DB!.prepare("SELECT published_version, published_at FROM analysis_artifacts WHERE artifact_id = ? AND published_version IS NOT NULL").bind(id).first<{ published_version: number; published_at: string }>().catch(() => null);
  if (!row) return null;
  const stored = await readArtifactVersion(env, id, row.published_version);
  if (!stored) return null;
  const original = toPublished(id, stored, row.published_at);
  if (locale !== "zh-CN" || original.lang === "zh-CN") return original;
  const translated = await readArtifactTranslation(env, id, row.published_version, stored.hash);
  if (translated?.status === "ready" && translated.r2_key) {
    const object = await env.SEC_FILINGS.get(translated.r2_key);
    if (object) return { ...toPublished(id, JSON.parse(await object.text()) as Stored, translated.updated_at), translation: { locale: "zh-CN", status: "ready" } };
  }
  return { ...original, translation: { locale: "zh-CN", status: translated?.status === "ready" ? "pending" : translated?.status ?? "pending", completed: translated?.completed ?? 0, total: translated?.total ?? 0 } };
}

export function readArtifactTranslation(env: Pick<ArtifactStoreEnv, "DB">, id: string, version: number, sourceHash: string): Promise<ArtifactTranslationRow | null> {
  return env.DB!.prepare("SELECT * FROM analysis_artifact_translations WHERE artifact_id = ? AND source_version = ? AND source_hash = ? AND locale = 'zh-CN'")
    .bind(id, version, sourceHash).first<ArtifactTranslationRow>();
}

/** The published document itself, blocks and sources, for a session that revises it or a check that reads it again. */
export async function readPublishedDocument(env: ArtifactStoreEnv, kind: ArtifactKind, ticker: string, subject: string): Promise<ArtifactDocument | null> {
  const id = artifactId(kind, ticker, subject);
  const row = await env.DB!.prepare("SELECT published_version FROM analysis_artifacts WHERE artifact_id = ? AND published_version IS NOT NULL").bind(id).first<{ published_version: number }>().catch(() => null);
  return row ? (await readArtifactVersion(env, id, row.published_version))?.document ?? null : null;
}

const workKey = (id: string) => `artifacts/${id.replace(/[^A-Za-z0-9:._-]/g, "_").replace(/:/g, "/")}/work.json`;
/**
 * What the session that wrote the published version held beyond the document (docs/filing-analysis-optimization.md
 * §4.6): its notes, leads, computed figures and the texts of the sources it read, so the next session can revise the
 * report and a recheck can read every source back without a model.
 */
export async function saveWorkState(env: ArtifactStoreEnv, kind: ArtifactKind, ticker: string, subject: string, work: unknown): Promise<void> {
  await env.SEC_FILINGS.put(workKey(artifactId(kind, ticker, subject)), JSON.stringify(work), { httpMetadata: { contentType: "application/json" } });
}
export async function readWorkState<T>(env: ArtifactStoreEnv, kind: ArtifactKind, ticker: string, subject: string): Promise<T | null> {
  const object = await env.SEC_FILINGS.get(workKey(artifactId(kind, ticker, subject))).catch(() => null);
  try { return object ? JSON.parse(await object.text()) as T : null; } catch { return null; }
}

const toPublished = (id: string, s: Stored, at: string): PublishedArtifact => ({
  id, kind: s.document.kind, ticker: s.document.ticker, subject: s.document.subject, version: s.document.version,
  title: s.document.kind === "filing-report" ? s.document.blocks.find(b => b.id === "summary")?.title ?? s.document.title : s.document.title,
  html: s.html, css: s.css, hash: s.hash, publishedAt: at, degraded: s.degraded,
  lang: isLocale(s.document.lang) ? s.document.lang : "en", translation: null,
});

/** Records one check's result against a version, for the admin's record of how each block was settled. */
export async function recordCheck(env: ArtifactStoreEnv, kind: ArtifactKind, ticker: string, subject: string, version: number, stage: string, round: number, result: unknown): Promise<void> {
  await env.DB!.prepare("INSERT INTO analysis_artifact_checks (artifact_id, version, stage, round, result, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(artifactId(kind, ticker, subject), version, stage, round, JSON.stringify(result).slice(0, 200_000), new Date().toISOString()).run().catch(() => undefined);
}

const PREVIEW_MS = 30 * 60_000;
const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function previewKey(env: ArtifactStoreEnv) {
  const secret = env.REPORT_ADMIN_PASSWORD || env.DEEPSEEK_API_KEY;
  if (!secret) throw new Error("artifact preview: no key material");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(`artifact-preview:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** A short-lived link token for one draft version, so the visual review can open it in the real stage. */
export async function previewToken(env: ArtifactStoreEnv, kind: ArtifactKind, ticker: string, subject: string, version: number, now = Date.now(), locale?: "zh-CN"): Promise<string> {
  const body = b64(new TextEncoder().encode(JSON.stringify({ a: artifactId(kind, ticker, subject), v: version, e: now + PREVIEW_MS, ...(locale ? { l: locale } : {}) })));
  return `${body}.${b64(await crypto.subtle.sign("HMAC", await previewKey(env), new TextEncoder().encode(body)))}`;
}

/** The draft a valid, unexpired preview token names; null for anything else. */
export async function readPreview(env: ArtifactStoreEnv, token: string, now = Date.now()): Promise<PublishedArtifact | null> {
  const [body, signature] = token.split(".");
  if (!body || !signature || token.length > 1000) return null;
  const bytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  try {
    if (!await crypto.subtle.verify("HMAC", await previewKey(env), bytes(signature), new TextEncoder().encode(body))) return null;
    const claim = JSON.parse(new TextDecoder().decode(bytes(body))) as { a: string; v: number; e: number; l?: "zh-CN" };
    if (!(claim.e > now)) return null;
    let stored = await readArtifactVersion(env, claim.a, claim.v);
    if (stored && claim.l === "zh-CN") {
      const translated = await readArtifactTranslation(env, claim.a, claim.v, stored.hash);
      const object = translated?.r2_key ? await env.SEC_FILINGS.get(translated.r2_key) : null;
      stored = object ? { ...JSON.parse(await object.text()) as Stored, createdAt: translated!.updated_at } : null;
    }
    return stored ? toPublished(claim.a, stored, stored.createdAt) : null;
  } catch { return null; }
}
