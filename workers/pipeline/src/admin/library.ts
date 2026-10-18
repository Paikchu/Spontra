import { INDUSTRY_CATEGORIES, LIBRARY_CANONICALS, type IndustryCategory, type LibraryCanonical, type LibraryCard, type LibraryDocumentDetail, type LibraryOverview, type LibrarySectionDetail } from "../../../../shared/analysis-contract/filing-library.ts";
import { LIBRARY_PARSER_VERSION } from "../../../../shared/analysis-runtime/filing-library/parse.ts";
import { overrideLink, readLinksView } from "../filing-library/links.ts";
import { searchStatus } from "../filing-library/search.ts";
import { countPendingLibraryDocuments, libraryOutline, librarySectionPassages, listLibraryDocuments, readLibraryDocument } from "../filing-library/store.ts";
import { libraryFactsAcross, libraryFindAcross } from "../filing-library/tool.ts";
import { libraryWiki } from "../filing-library/wiki.ts";
import type { SecPipelineEnv } from "../operations.ts";
import { flushOutbox, outboxStatement } from "../pipeline/outbox.ts";
import { authenticateAdmin } from "./auth.ts";
import { readSectorView, readTagCompanies, readTagsView, requestTags, setPairTier, setTagStatus } from "../business-tags/view.ts";
import { TIER_ORDER } from "../../../../shared/analysis-runtime/business-tags.ts";
import type { PeerTier } from "../../../../shared/analysis-contract/business-tags.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
const DOCUMENT = /^[a-f0-9]{64}$/, SECTION = /^s[a-f0-9]{28}$/, TICKER = /^[A-Z][A-Z0-9.-]{0,11}$/, SLUG = /^[\p{L}\p{N}-]{1,60}$/u;
const category = (value: string | null): IndustryCategory | undefined => value && Object.hasOwn(INDUSTRY_CATEGORIES, value) ? value as IndustryCategory : undefined;
const tickerList = (value: string | null) => value ? value.split(",").map(t => t.trim().toUpperCase()).filter(t => TICKER.test(t)).slice(0, 20) : undefined;

type CardRecord = { section_id: string; gist: string | null; entities: string; topic: string | null; answers: string; metrics: string; notes: string; model: string; reasoning: string; status: LibraryCard["status"]; created_at: string };
const cardOf = (r: CardRecord): LibraryCard => ({
  sectionId: r.section_id, gist: r.gist, entities: JSON.parse(r.entities), topic: r.topic, answers: JSON.parse(r.answers), metrics: JSON.parse(r.metrics),
  notes: JSON.parse(r.notes), model: r.model, reasoning: r.reasoning, status: r.status, createdAt: r.created_at,
});

export async function readLibraryOverview(env: SecPipelineEnv): Promise<LibraryOverview> {
  const db = env.DB!;
  const [pending, totals, cards, structures, companies, problems] = await Promise.all([
    countPendingLibraryDocuments(db, LIBRARY_PARSER_VERSION),
    db.prepare("SELECT COUNT(*) documents, SUM(status = 'ready') ready, SUM(status = 'unreadable') unreadable, SUM(sections) sections, SUM(passages) passages FROM sec_documents").first<{ documents: number; ready: number; unreadable: number; sections: number; passages: number }>(),
    db.prepare("SELECT COUNT(*) n FROM sec_section_cards WHERE status != 'failed'").first<{ n: number }>(),
    db.prepare("SELECT structure, doc_type, COUNT(*) documents FROM sec_documents WHERE status = 'ready' GROUP BY structure, doc_type ORDER BY documents DESC").all<{ structure: LibraryOverview["structures"][number]["structure"]; doc_type: LibraryOverview["structures"][number]["docType"]; documents: number }>(),
    db.prepare(`SELECT ticker, COUNT(*) documents, SUM(status = 'unreadable') unreadable, SUM(json_extract(structure_check,'$.status') = 'segments_missing') segments_missing, MAX(filed_at) latest
      FROM sec_documents GROUP BY ticker ORDER BY ticker`).all<{ ticker: string; documents: number; unreadable: number; segments_missing: number; latest: string }>(),
    db.prepare(`SELECT document_id, ticker, form, doc_type, filed_at, status, failure_reason, structure, structure_check FROM sec_documents
      WHERE status = 'unreadable' OR json_extract(structure_check,'$.status') = 'segments_missing' OR (structure != 'items' AND doc_type = 'primary' AND form IN ('10-K','10-Q','20-F'))
      ORDER BY filed_at DESC LIMIT 60`).all<{ document_id: string; ticker: string; form: string; doc_type: LibraryOverview["problems"][number]["docType"]; filed_at: string; status: "ready" | "unreadable"; failure_reason: string | null; structure: LibraryOverview["problems"][number]["structure"]; structure_check: string }>(),
  ]);
  return {
    enabled: env.FILING_LIBRARY_ENABLED !== "false", parserVersion: LIBRARY_PARSER_VERSION, pending,
    totals: { documents: totals?.documents ?? 0, ready: totals?.ready ?? 0, unreadable: totals?.unreadable ?? 0, sections: totals?.sections ?? 0, passages: totals?.passages ?? 0, cards: cards?.n ?? 0 },
    structures: structures.results.map(r => ({ structure: r.structure, docType: r.doc_type, documents: r.documents })),
    companies: companies.results.map(r => ({ ticker: r.ticker, documents: r.documents, unreadable: r.unreadable, segmentsMissing: r.segments_missing, latestFiledAt: r.latest })),
    problems: problems.results.map(r => ({ documentId: r.document_id, ticker: r.ticker, form: r.form, docType: r.doc_type, filedAt: r.filed_at, status: r.status, failureReason: r.failure_reason, structure: r.structure, structureCheck: JSON.parse(r.structure_check) })),
  };
}

export async function readLibraryDocumentDetail(db: D1Database, documentId: string): Promise<LibraryDocumentDetail | null> {
  const document = await readLibraryDocument(db, documentId);
  if (!document) return null;
  const [outline, cards] = await Promise.all([
    libraryOutline(db, documentId),
    db.prepare("SELECT section_id, gist, entities, topic, answers, metrics, notes, model, reasoning, status, created_at FROM sec_section_cards WHERE document_id = ?").bind(documentId).all<CardRecord>(),
  ]);
  return { document, outline, cards: cards.results.map(cardOf) };
}

export async function readLibrarySectionDetail(db: D1Database, documentId: string, sectionId: string): Promise<LibrarySectionDetail | null> {
  const outline = await libraryOutline(db, documentId);
  const section = outline.find(s => s.sectionId === sectionId);
  if (!section) return null;
  const prefix = JSON.stringify(section.path).slice(0, -1);
  const ids = outline.filter(s => JSON.stringify(s.path).startsWith(prefix)).map(s => s.sectionId);
  const [passages, card] = await Promise.all([
    librarySectionPassages(db, documentId, ids),
    db.prepare("SELECT section_id, gist, entities, topic, answers, metrics, notes, model, reasoning, status, created_at FROM sec_section_cards WHERE section_id = ?").bind(sectionId).first<CardRecord>(),
  ]);
  return { section, passages, card: card ? cardOf(card) : null };
}

/** The filing library for the admin: overview, a company's documents, a document's outline, a section's passages, and a manual re-split. */
export async function handleLibraryAdminRequest(request: Request, env: SecPipelineEnv): Promise<Response> {
  if (!await authenticateAdmin(request, env.REPORT_ADMIN_PASSWORD)) return json({ error: "请登录财报管理后台。" }, 401);
  if (!env.DB) return json({ error: "数据服务暂时不可用。" }, 503);
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).slice(2).map(decodeURIComponent);
  if (request.method === "GET" && !parts.length) return json(await readLibraryOverview(env));
  if (request.method === "GET" && parts[0] === "companies" && parts.length === 2 && TICKER.test(parts[1]!)) return json({ documents: await listLibraryDocuments(env.DB, { ticker: parts[1], limit: 200 }) });
  const query = new URL(request.url).searchParams;
  // Cross-company reads: sections by index or by meaning, validated numbers by category, a company's derived page.
  if (request.method === "GET" && parts[0] === "find" && parts.length === 1) {
    const canonical = query.get("canonical");
    const question = query.get("q")?.trim().slice(0, 300) || undefined;
    return json(await libraryFindAcross(env, {
      tickers: tickerList(query.get("tickers")), topic: query.get("topic") ?? undefined, entity: query.get("entity") ?? undefined, keywords: query.get("keywords") ?? undefined,
      canonical: canonical && (LIBRARY_CANONICALS as readonly string[]).includes(canonical) ? canonical as LibraryCanonical : undefined, question,
      category: category(query.get("category")), businessKey: query.get("business") ?? undefined, limit: Math.min(Number(query.get("limit")) || 20, 50),
    }));
  }
  if (request.method === "GET" && parts[0] === "facts" && parts.length === 1) {
    return json({ facts: await libraryFactsAcross(env.DB, { tickers: tickerList(query.get("tickers")), category: category(query.get("category")), quarters: Math.min(Number(query.get("quarters")) || 2, 8) }) });
  }
  if (request.method === "GET" && parts[0] === "wiki" && parts.length === 2 && TICKER.test(parts[1]!)) return json(await libraryWiki(env.DB, parts[1]!));
  if (request.method === "GET" && parts[0] === "search" && parts.length === 1) return json(await searchStatus(env));
  if (parts[0] === "links") {
    if (request.method === "GET" && parts.length <= 2 && (parts.length === 1 || TICKER.test(parts[1]!))) return json(await readLinksView(env.DB, parts[1]));
    if (request.method === "POST" && parts.length === 3 && TICKER.test(parts[1]!) && parts[2] === "run") {
      // A fresh proposal: forget the input it was last proposed on, then ask the company's links task to run.
      await env.DB.batch([
        env.DB.prepare("DELETE FROM sec_cache WHERE cache_key = ?").bind(`library-links:v1:${parts[1]}`),
        outboxStatement(env.DB, { type: "library.links.requested", ticker: parts[1]! }),
      ]);
      await flushOutbox(env).catch(() => 0);
      return json({ status: "requested" }, 202);
    }
    if (request.method === "POST" && parts.length === 3 && TICKER.test(parts[1]!) && SLUG.test(parts[2]!)) {
      // Optional: an admin's category for one link, or `{ "automatic": true }` to hand it back to the review's result.
      let body: { automatic?: unknown; industryCategory?: unknown };
      try { body = await request.json() as typeof body; } catch { return json({ error: "请求格式无效。" }, 400); }
      if (body.automatic !== true && (body.industryCategory === undefined || (body.industryCategory !== null && !category(String(body.industryCategory))))) return json({ error: "未知的行业类别。" }, 400);
      const changed = await overrideLink(env.DB, parts[1]!, `${parts[1]}:${parts[2]}`, body.automatic === true ? { automatic: true } : { industryCategory: body.industryCategory as string | null });
      // A link's category is a sector tag of its unit: the company's tags are written again.
      if (changed) await requestTags(env, parts[1]!).catch(() => undefined);
      return changed ? json({ status: "saved" }) : json({ error: "未找到该业务。" }, 404);
    }
  }
  // Business tags (docs/peer-similarity-design.md): a company's units, tags and pairs; one sector's units; optional overrides.
  if (parts[0] === "tags") {
    if (request.method === "GET" && parts.length === 1) return json(await readTagCompanies(env.DB));
    if (request.method === "GET" && parts.length === 3 && parts[1] === "sectors") {
      const sector = category(parts[2]!);
      return sector ? json(await readSectorView(env.DB, sector)) : json({ error: "未知的行业类别。" }, 404);
    }
    if (request.method === "GET" && parts.length === 2 && TICKER.test(parts[1]!)) return json(await readTagsView(env, parts[1]!));
    if (request.method === "POST" && parts.length === 3 && TICKER.test(parts[1]!) && parts[2] === "run") {
      await requestTags(env, parts[1]!);
      return json({ status: "requested" }, 202);
    }
    if (request.method === "POST" && parts.length === 4 && TICKER.test(parts[1]!) && parts[2] === "tag" && /^t[a-f0-9]{24}$/.test(parts[3]!)) {
      let body: { status?: unknown };
      try { body = await request.json() as typeof body; } catch { return json({ error: "请求格式无效。" }, 400); }
      if (body.status !== "verified" && body.status !== "rejected") return json({ error: "未知的状态。" }, 400);
      return await setTagStatus(env, parts[1]!, parts[3]!, body.status) ? json({ status: "saved" }) : json({ error: "未找到该标签。" }, 404);
    }
    if (request.method === "POST" && parts.length === 3 && TICKER.test(parts[1]!) && parts[2] === "pair") {
      let body: { pairKey?: unknown; tier?: unknown; automatic?: unknown };
      try { body = await request.json() as typeof body; } catch { return json({ error: "请求格式无效。" }, 400); }
      if (typeof body.pairKey !== "string" || (body.automatic !== true && !(TIER_ORDER as readonly unknown[]).includes(body.tier))) return json({ error: "请求格式无效。" }, 400);
      const saved = await setPairTier(env, parts[1]!, body.pairKey, body.automatic === true ? { automatic: true } : { tier: body.tier as PeerTier });
      return saved ? json({ status: "saved" }) : json({ error: "未找到该配对。" }, 404);
    }
  }
  if (parts[0] === "documents" && DOCUMENT.test(parts[1] ?? "")) {
    const documentId = parts[1]!;
    if (request.method === "GET" && parts.length === 2) { const detail = await readLibraryDocumentDetail(env.DB, documentId); return detail ? json(detail) : json({ error: "未找到该文件。" }, 404); }
    if (request.method === "GET" && parts.length === 4 && parts[2] === "sections" && SECTION.test(parts[3]!)) {
      const detail = await readLibrarySectionDetail(env.DB, documentId, parts[3]!);
      return detail ? json(detail) : json({ error: "未找到该章节。" }, 404);
    }
    if (request.method === "POST" && parts.length === 3 && parts[2] === "rerun") {
      const document = await readLibraryDocument(env.DB, documentId);
      if (!document) return json({ error: "未找到该文件。" }, 404);
      // The document reads as stale and the company's library task is asked to run; both or neither.
      await env.DB.batch([
        env.DB.prepare("UPDATE sec_documents SET parser_version = 'rerun' WHERE document_id = ?").bind(documentId),
        outboxStatement(env.DB, { type: "library.requested", ticker: document.ticker, cik: document.documentUrl.match(/\/data\/(\d+)\//)?.[1]?.padStart(10, "0") ?? null, detail: { form: document.form, accession: document.accessionNumber } }),
      ]);
      await flushOutbox(env).catch(() => 0);
      return json({ status: "requested" }, 202);
    }
  }
  return json({ error: "Not found" }, 404);
}
