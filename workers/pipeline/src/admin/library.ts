import type { LibraryCard, LibraryDocumentDetail, LibraryOverview, LibrarySectionDetail } from "../../../../shared/analysis-contract/filing-library.ts";
import { LIBRARY_PARSER_VERSION } from "../../../../shared/analysis-runtime/filing-library/parse.ts";
import { countPendingLibraryDocuments, libraryOutline, librarySectionPassages, listLibraryDocuments, readLibraryDocument } from "../filing-library/store.ts";
import type { SecPipelineEnv } from "../operations.ts";
import { flushOutbox, outboxStatement } from "../pipeline/outbox.ts";
import { authenticateAdmin } from "./auth.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
const DOCUMENT = /^[a-f0-9]{64}$/, SECTION = /^s[a-f0-9]{28}$/, TICKER = /^[A-Z][A-Z0-9.-]{0,11}$/;

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
