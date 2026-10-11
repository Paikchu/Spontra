import type { LibraryCanonical, LibraryFoundSection } from "../../../../shared/analysis-contract/filing-library.ts";
import { libraryHash } from "../../../../shared/analysis-runtime/filing-library/parse.ts";
import { findSecurity } from "../catalog/security-directory.ts";
import type { SecPipelineEnv } from "../operations.ts";
import { cardDocuments, cardsPublished } from "./cards.ts";

/**
 * The recall layer (docs/sec-filing-library.md): the sections that have index cards are uploaded, verbatim, to one
 * Cloudflare AI Search instance with built-in storage, keyed by section id. It finds sections by meaning across
 * companies; whatever it returns is only a list of section ids, read back from D1. It never holds model writing.
 */
export const SEARCH_INSTANCE = "sec-filing-library";
const SEARCH_CONFIG = {
  id: SEARCH_INSTANCE,
  index_method: { vector: true, keyword: true },
  fusion_method: "rrf" as const,
  indexing_options: { keyword_tokenizer: "porter" as const },
  // A section is at most about 8,000 characters (larger ones are split at parse time), so one chunk holds it.
  chunk: true, chunk_size: 2048, chunk_overlap: 0,
  cache: false,
  custom_metadata: [
    { field_name: "ticker", data_type: "text" as const }, { field_name: "form", data_type: "text" as const },
    { field_name: "canonical", data_type: "text" as const }, { field_name: "topic", data_type: "text" as const },
    { field_name: "period_end", data_type: "text" as const },
  ],
};
/** A section with less text than this is a heading, not something to find. */
const MIN_CHARS = 200;
/** Uploads and deletes one run makes; the rest waits for the next run, right away. */
const RUN_BUDGET = 120, PARALLEL = 6;
/** Errors that concern one item's content; any other error is the service or the binding, and stops the run. */
const ITEM_ERROR = /too large|exceed|invalid|unsupported|unprocessable|payload|413|415|422/i;

export const searchEnabled = (env: SecPipelineEnv) => !!env.AI_SEARCH && env.LIBRARY_SEARCH_ENABLED !== "false";

const message = (error: unknown) => String((error as Error)?.message ?? error);
const NOT_FOUND = /not.?found|404|does not exist/i;
/** Whether this isolate has seen the instance exist; the handle itself is per request and is never kept. */
let instanceExists = false;
/** The instance, created on first use. Another isolate creating it at the same time is not an error. */
export async function searchInstance(env: SecPipelineEnv): Promise<AiSearchInstance> {
  if (!instanceExists) {
    try { await env.AI_SEARCH!.get(SEARCH_INSTANCE).info(); }
    catch (error) {
      if (!NOT_FOUND.test(message(error))) throw error;
      try { await env.AI_SEARCH!.create(SEARCH_CONFIG); }
      catch (created) { if (!/already exists|duplicate|conflict/i.test(message(created))) throw created; }
    }
    instanceExists = true;
  }
  return env.AI_SEARCH!.get(SEARCH_INSTANCE);
}

type Wanted = { sectionId: string; documentId: string; canonical: string; path: string[]; form: string; reportDate: string; filedAt: string; topic: string | null; passageIds: string };

/** What should be in the index for a company: every non-boilerplate section with text of its own in the carded documents. */
async function wantedSections(db: D1Database, ticker: string): Promise<Array<Wanted & { contentSha: string }>> {
  const documents = await cardDocuments(db, ticker);
  if (!documents.length) return [];
  const rows = (await db.prepare(`SELECT s.section_id, s.document_id, s.canonical, s.path, d.form, d.report_date, d.filed_at, c.topic,
      (SELECT group_concat(passage_id) FROM sec_passages p WHERE p.section_id = s.section_id) passage_ids,
      (SELECT SUM(chars) FROM sec_passages p WHERE p.section_id = s.section_id) own
    FROM sec_sections s JOIN sec_documents d ON d.document_id = s.document_id LEFT JOIN sec_section_cards c ON c.section_id = s.section_id
    WHERE s.document_id IN (SELECT value FROM json_each(?)) AND s.role != 'boilerplate' ORDER BY s.document_id, s.ordinal`).bind(JSON.stringify(documents))
    .all<{ section_id: string; document_id: string; canonical: string; path: string; form: string; report_date: string; filed_at: string; topic: string | null; passage_ids: string | null; own: number | null }>()).results;
  return rows.filter(r => (r.own ?? 0) >= MIN_CHARS).map(r => {
    const wanted = { sectionId: r.section_id, documentId: r.document_id, canonical: r.canonical, path: JSON.parse(r.path) as string[], form: r.form, reportDate: r.report_date, filedAt: r.filed_at, topic: r.topic, passageIds: r.passage_ids ?? "" };
    return { ...wanted, contentSha: libraryHash(JSON.stringify([wanted.passageIds, wanted.path, wanted.form, wanted.reportDate, wanted.topic, wanted.canonical])) };
  });
}

/** The item's text: a header naming the company, form, period and heading path, then the section's own passages verbatim. */
async function itemContent(db: D1Database, ticker: string, w: Wanted): Promise<string> {
  const passages = (await db.prepare("SELECT text FROM sec_passages WHERE section_id = ? ORDER BY ordinal").bind(w.sectionId).all<{ text: string }>()).results;
  const company = findSecurity(ticker)?.name ?? ticker;
  return `# ${company} (${ticker}) · ${w.form} · period ${w.reportDate} · filed ${w.filedAt.slice(0, 10)}\n## ${w.path.join(" › ")}\n\n${passages.map(p => p.text).join("\n\n")}\n`;
}

/**
 * Brings one company's items in line with the library: uploads sections that are new or whose text, path or topic
 * changed, and deletes items for sections that left the carded documents. Each upload is recorded in D1, so a run
 * that stops half way resumes where it left off.
 */
export async function syncSearchItems(env: SecPipelineEnv, ticker: string): Promise<{ uploaded: number; deleted: number; failed: number; remaining: number }> {
  const db = env.DB!;
  // Items carry the card's topic; uploading before the cards exist would upload every section twice.
  if (!await cardsPublished(db, ticker)) return { uploaded: 0, deleted: 0, failed: 0, remaining: 0 };
  const wanted = await wantedSections(db, ticker);
  const stored = new Map((await db.prepare("SELECT section_id, item_id, content_sha256, status FROM sec_search_items WHERE ticker = ?").bind(ticker)
    .all<{ section_id: string; item_id: string | null; content_sha256: string; status: string }>()).results.map(r => [r.section_id, r]));
  const uploads = wanted.filter(w => { const s = stored.get(w.sectionId); return !s || s.content_sha256 !== w.contentSha || s.status === "error"; });
  const keep = new Set(wanted.map(w => w.sectionId));
  const deletes = [...stored.values()].filter(s => !keep.has(s.section_id));
  const result = { uploaded: 0, deleted: 0, failed: 0, remaining: 0 };
  if (!uploads.length && !deletes.length) return result;
  const instance = await searchInstance(env);
  const deleting = deletes.slice(0, RUN_BUDGET), uploading = uploads.slice(0, RUN_BUDGET - deleting.length);
  for (const s of deleting) {
    if (s.item_id) {
      try { await instance.items.delete(s.item_id); }
      catch (error) { if (!NOT_FOUND.test(message(error))) throw error; }
    }
    await db.prepare("DELETE FROM sec_search_items WHERE section_id = ?").bind(s.section_id).run();
    result.deleted++;
  }
  const record = (w: Wanted & { contentSha: string }, itemId: string | null, error: string | null, at: string) => db.prepare(`INSERT INTO sec_search_items (section_id, ticker, document_id, item_id, content_sha256, status, error, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(section_id) DO UPDATE SET ticker = excluded.ticker, document_id = excluded.document_id, item_id = COALESCE(excluded.item_id, sec_search_items.item_id),
    content_sha256 = excluded.content_sha256, status = excluded.status, error = excluded.error, uploaded_at = excluded.uploaded_at`)
    .bind(w.sectionId, ticker, w.documentId, itemId, w.contentSha, error ? "error" : "uploaded", error, at);
  // A few uploads at a time: each waits on the service, not on this Worker's CPU.
  for (let i = 0; i < uploading.length; i += PARALLEL) {
    const outcomes = await Promise.allSettled(uploading.slice(i, i + PARALLEL).map(async w => {
      const item = await instance.items.upload(`${w.sectionId}.md`, await itemContent(db, ticker, w), {
        metadata: { ticker, form: w.form, canonical: w.canonical, topic: w.topic ?? "", period_end: w.reportDate },
      });
      return item.id;
    }));
    const at = new Date().toISOString(), statements: D1PreparedStatement[] = [];
    let unexpected: unknown = null;
    outcomes.forEach((o, k) => {
      const w = uploading[i + k]!;
      if (o.status === "fulfilled") { statements.push(record(w, o.value, null, at)); result.uploaded++; return; }
      // The service refusing this one item is recorded and retried next run; anything else stops the run for the queue to retry.
      if (ITEM_ERROR.test(message(o.reason))) { statements.push(record(w, null, message(o.reason).slice(0, 300), at)); result.failed++; }
      else unexpected ??= o.reason;
    });
    if (statements.length) await db.batch(statements);
    if (unexpected) throw unexpected;
  }
  result.remaining = Math.max(0, uploads.length + deletes.length - RUN_BUDGET);
  return result;
}

/**
 * Sections whose text is about `question`, by vector and keyword search together, optionally within some
 * companies, one part of the filing or one card topic. Only ids come from AI Search; the rest is read from D1.
 */
export async function libraryRecall(env: SecPipelineEnv, request: { question: string; tickers?: string[]; canonical?: LibraryCanonical; topic?: string; limit?: number }): Promise<LibraryFoundSection[]> {
  const instance = await searchInstance(env);
  const filters: VectorizeVectorMetadataFilter = {};
  if (request.tickers?.length) filters.ticker = request.tickers.length === 1 ? request.tickers[0] : { $in: request.tickers };
  if (request.canonical) filters.canonical = request.canonical;
  if (request.topic) filters.topic = request.topic.replace(/^[a-z]+\./, "");
  const limit = Math.min(Math.max(request.limit ?? 20, 1), 50);
  const response = await instance.search({
    query: request.question,
    ai_search_options: { retrieval: { retrieval_type: "hybrid", max_num_results: limit, return_on_failure: false, ...(Object.keys(filters).length ? { filters } : {}) } },
  });
  const scores = new Map<string, number>();
  for (const chunk of response.chunks ?? []) {
    const id = chunk.item?.key?.replace(/\.md$/, "");
    if (id && /^s[a-f0-9]{28}$/.test(id)) scores.set(id, Math.max(scores.get(id) ?? 0, chunk.score ?? 0));
  }
  if (!scores.size) return [];
  const rows = (await env.DB!.prepare(`SELECT d.ticker, d.document_id, d.form, d.filed_at, s.section_id, s.path, s.canonical, c.topic, c.gist, c.entities
    FROM sec_sections s JOIN sec_documents d ON d.document_id = s.document_id LEFT JOIN sec_section_cards c ON c.section_id = s.section_id
    WHERE s.section_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify([...scores.keys()]))
    .all<{ ticker: string; document_id: string; form: string; filed_at: string; section_id: string; path: string; canonical: string; topic: string | null; gist: string | null; entities: string | null }>()).results;
  return rows.map(r => ({
    ticker: r.ticker, documentId: r.document_id, form: r.form, filedAt: r.filed_at, sectionId: r.section_id, path: JSON.parse(r.path), canonical: r.canonical,
    topic: r.topic, gist: r.gist, entities: r.entities ? JSON.parse(r.entities) : [], score: Math.round((scores.get(r.section_id) ?? 0) * 1000) / 1000, via: "recall" as const,
  })).sort((a, b) => b.score - a.score);
}

/** The recall layer's state for the admin: the instance's own counts and what D1 says was uploaded. */
export async function searchStatus(env: SecPipelineEnv): Promise<Record<string, unknown>> {
  const items = (await env.DB!.prepare("SELECT ticker, status, COUNT(*) n, MAX(uploaded_at) last FROM sec_search_items GROUP BY ticker, status ORDER BY ticker").all()).results;
  if (!searchEnabled(env)) return { enabled: false, items };
  try {
    const instance = await searchInstance(env);
    const [info, stats] = await Promise.all([instance.info(), instance.stats()]);
    return { enabled: true, instance: { id: info.id, status: info.status ?? null, chunkSize: info.chunk_size ?? null, metadata: info.custom_metadata ?? [] }, stats, items };
  } catch (error) { return { enabled: true, error: String((error as Error)?.message ?? error).slice(0, 300), items }; }
}
