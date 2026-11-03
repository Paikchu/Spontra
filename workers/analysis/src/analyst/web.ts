import type { FindingPassage } from "../../../../shared/analysis-contract/findings.ts";
import { excerpt } from "../business-explainer/agent.ts";
import { sha256 } from "../sha256.ts";
import type { AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { SearchHit } from "../web-search/types.ts";

/**
 * Web evidence for the analyst: searches and page reads through the cached search service, each page kept as a
 * dated excerpt in D1 under its own id, so a quote from it can be re-read and re-verified when the page is served,
 * long after the search cache has expired. Nothing from the web is ever a number of the site's own.
 */
export const EXCLUDED_HOSTS = ["reddit.com", "youtube.com", "quora.com", "x.com", "twitter.com", "facebook.com", "tiktok.com", "ycharts.com", "macrotrends.net", "stocktwits.com", "pinterest.com"];
export const WEB_SCOPE = (ticker: string) => ({ scope: `spontra:analyst:${ticker}`, maxAgeMs: 7 * 24 * 60 * 60_000 });
const PAGE_CACHE_MS = 30 * 24 * 60 * 60_000, EXCERPT_CHARS = 9000;
export const webMaterialKey = (ticker: string, id: string) => `research:v1:${ticker}:${id}`;

/** A page as kept for re-verification: where it came from, when, and the excerpt the agent saw. */
export type WebMaterialRecord = { id: string; url: string; title: string; publishedAt: string | null; retrievedAt: string; textSha256: string; excerpt: string };

/** Lines written at a reader rather than to one: instructions a page may carry for an assistant are not evidence. */
export function stripInstructions(text: string): string {
  return text.split("\n").filter(line => !/^\s*(?:(?:please\s+)?(?:ignore|disregard|forget)\b.*(?:instructions|prompt|rules)|(?:you are|you're|as an?)\s+(?:an?\s+)?(?:ai|assistant|language model|llm)\b|system prompt|assistant:|\[inst\]|<\|)/i.test(line)).join("\n");
}

export const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url.slice(0, 40); } };
const validDate = (value: string | null | undefined) => value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;

/** The id a page reads under: 'w' plus a hash of its URL, shaped like a passage id so the same verification path serves it. */
export async function webMaterialId(url: string): Promise<string> { return "w" + (await sha256(url.trim())).slice(0, 27); }

export type WebReadResult = { record: WebMaterialRecord; passage: FindingPassage };

/**
 * Reads one page the agent found: fetches it through the cached service, keeps a focused excerpt with instruction
 * lines removed, stores the record under its id, and returns the passage form the verifier reads.
 */
export async function readWebPage(env: AnalysisEnv, ticker: string, hit: SearchHit, terms: string[], now: string, fetchContent: (url: string) => Promise<{ text: string }>): Promise<WebReadResult | null> {
  const page = await fetchContent(hit.url).catch(() => null);
  if (!page?.text?.trim()) return null;
  const text = stripInstructions(excerpt(page.text, terms, EXCERPT_CHARS) || page.text.slice(0, EXCERPT_CHARS));
  if (text.trim().length < 80) return null;
  const id = await webMaterialId(hit.url);
  const record: WebMaterialRecord = { id, url: hit.url, title: hit.title.slice(0, 300), publishedAt: validDate(hit.publishedAt), retrievedAt: now, textSha256: await sha256(text), excerpt: text };
  if (env.DB) await new D1SecRepository(env.DB).setCache(webMaterialKey(ticker, id), record, now).catch(() => undefined);
  return { record, passage: webPassage(record) };
}

export function webPassage(record: WebMaterialRecord): FindingPassage {
  return { passageId: record.id, documentId: record.url, title: record.title, form: "web", filedAt: record.publishedAt ?? record.retrievedAt, url: record.url, path: [hostOf(record.url)], text: record.excerpt, table: null };
}

/** The stored web materials a publication quotes, as passages; absent records are left out and their quotes withdraw. */
export async function webPassages(db: D1Database, ticker: string, ids: string[]): Promise<FindingPassage[]> {
  const repository = new D1SecRepository(db);
  const out: FindingPassage[] = [];
  for (const id of [...new Set(ids)].slice(0, 40)) {
    const stored = await repository.getCache<WebMaterialRecord>(webMaterialKey(ticker, id)).catch(() => null);
    if (stored?.payload?.excerpt && stored.payload.id === id) out.push(webPassage(stored.payload));
  }
  return out;
}

export { PAGE_CACHE_MS };
