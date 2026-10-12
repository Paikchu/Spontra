import type { IndustryCategory, LibraryCanonical, LibraryFactRow, LibraryFindResult, LibraryFoundSection, LibraryPassageView } from "../../../../shared/analysis-contract/filing-library.ts";
import { readCompletePublicationForTicker } from "../financial-data/publication.ts";
import type { SecPipelineEnv } from "../operations.ts";
import { readLinks } from "./links.ts";
import { libraryRecall, searchEnabled } from "./search.ts";
import { libraryOutline, librarySectionPassages, listLibraryDocuments } from "./store.ts";

/**
 * The tool agents read SEC filings through. Every call is a D1 lookup: no SEC, R2 or web request, no parsing.
 * `toc` and `find` route (outlines and index cards, never text); `read` returns verbatim passages with their ids;
 * `facts` returns the validated numbers the business map draws, not raw XBRL.
 */
export type TocEntry = { sectionId: string; path: string[]; canonical: LibraryCanonical; role: string; chars: number; change: string; gist: string | null; topic: string | null; entities: string[] };
export type TocDocument = { documentId: string; form: string; docType: string; filedAt: string; reportDate: string; url: string; structure: string; sections: TocEntry[] };
export type ReadPassage = { passageId: string; path: string; text: string };
export type FoundSection = LibraryFoundSection;

const terms = (text: string) => [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3))];

/** The company's recent documents with their outlines and cards; boilerplate is left out unless asked for. */
export async function libraryToc(db: D1Database, ticker: string, options: { forms?: string[]; limit?: number; includeBoilerplate?: boolean } = {}): Promise<TocDocument[]> {
  const documents = (await listLibraryDocuments(db, { ticker, forms: options.forms, limit: options.limit ?? 6 })).filter(d => d.status === "ready");
  return Promise.all(documents.map(async d => {
    const outline = (await libraryOutline(db, d.documentId)).filter(s => options.includeBoilerplate || s.role !== "boilerplate");
    const cards = new Map((await db.prepare("SELECT section_id, gist, topic, entities FROM sec_section_cards WHERE document_id = ?").bind(d.documentId)
      .all<{ section_id: string; gist: string | null; topic: string | null; entities: string }>()).results.map(c => [c.section_id, c]));
    return {
      documentId: d.documentId, form: d.form, docType: d.docType, filedAt: d.filedAt, reportDate: d.reportDate, url: d.documentUrl, structure: d.structure,
      sections: outline.map(s => { const c = cards.get(s.sectionId); return { sectionId: s.sectionId, path: s.path, canonical: s.canonical, role: s.role, chars: s.chars, change: s.change, gist: c?.gist ?? null, topic: c?.topic ?? null, entities: c ? JSON.parse(c.entities) as string[] : [] }; }),
    };
  }));
}

/** Passages ranked by how many focus terms they contain, kept in document order, within a character budget. */
export function rankPassages(passages: Array<LibraryPassageView & { path?: string }>, focus: string[], maxChars: number): LibraryPassageView[] {
  const words = focus.flatMap(terms);
  const score = (text: string) => { const lower = text.toLowerCase(); return words.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0); };
  const ranked = words.length ? passages.map((p, i) => ({ p, i, s: score(p.text) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i) : passages.map((p, i) => ({ p, i, s: 0 }));
  const kept: Array<{ p: LibraryPassageView; i: number }> = [];
  let used = 0;
  for (const x of ranked) { if (used + x.p.text.length > maxChars) { if (!kept.length) kept.push(x); continue; } kept.push(x); used += x.p.text.length; }
  return kept.sort((a, b) => a.i - b.i).map(x => x.p);
}

/** A section (with everything under it), or the passages most about `focus` within a document's core sections. */
export async function libraryRead(db: D1Database, request: { documentId: string; sectionId?: string; focus?: string[]; maxChars?: number; canonicals?: LibraryCanonical[] }): Promise<{ passages: ReadPassage[]; omitted: number }> {
  const outline = await libraryOutline(db, request.documentId);
  const pathOf = new Map(outline.map(s => [s.sectionId, s.path.join(" › ")]));
  let ids: string[];
  if (request.sectionId) {
    const root = outline.find(s => s.sectionId === request.sectionId);
    if (!root) return { passages: [], omitted: 0 };
    const prefix = JSON.stringify(root.path).slice(0, -1);
    ids = outline.filter(s => JSON.stringify(s.path).startsWith(prefix)).map(s => s.sectionId);
  } else ids = outline.filter(s => s.role !== "boilerplate" && (!request.canonicals || request.canonicals.includes(s.canonical))).map(s => s.sectionId);
  const all = await librarySectionPassages(db, request.documentId, ids);
  const kept = rankPassages(all, request.focus ?? [], request.maxChars ?? 12_000);
  return { passages: kept.map(p => ({ passageId: p.passageId, path: pathOf.get(p.sectionId) ?? "", text: p.text })), omitted: all.length - kept.length };
}

/** Sections across companies by card topic, by an entity the card names, or by words in their titles and gists; newest documents first. */
export async function libraryFind(db: D1Database, request: { tickers?: string[]; topic?: string; entity?: string; keywords?: string; canonical?: LibraryCanonical; sectionIds?: string[]; limit?: number }): Promise<FoundSection[]> {
  const where: string[] = ["d.status = 'ready'", "s.role != 'boilerplate'"], binds: unknown[] = [];
  if (request.tickers?.length) { where.push("d.ticker IN (SELECT value FROM json_each(?))"); binds.push(JSON.stringify(request.tickers)); }
  if (request.sectionIds) { where.push("s.section_id IN (SELECT value FROM json_each(?))"); binds.push(JSON.stringify(request.sectionIds)); }
  if (request.topic) { where.push("c.topic = ?"); binds.push(request.topic.replace(/^[a-z]+\./, "")); }
  if (request.canonical) { where.push("s.canonical = ?"); binds.push(request.canonical); }
  if (request.entity) { where.push("EXISTS (SELECT 1 FROM json_each(c.entities) e WHERE lower(e.value) = lower(?))"); binds.push(request.entity); }
  const rows = (await db.prepare(`SELECT d.ticker, d.document_id, d.form, d.filed_at, s.section_id, s.path, s.canonical, c.topic, c.gist, c.entities
    FROM sec_sections s JOIN sec_documents d ON d.document_id = s.document_id LEFT JOIN sec_section_cards c ON c.section_id = s.section_id
    WHERE ${where.join(" AND ")} ORDER BY d.filed_at DESC, s.ordinal LIMIT 600`).bind(...binds)
    .all<{ ticker: string; document_id: string; form: string; filed_at: string; section_id: string; path: string; canonical: string; topic: string | null; gist: string | null; entities: string | null }>()).results;
  const words = terms(request.keywords ?? "");
  const found = rows.map(r => {
    const path = JSON.parse(r.path) as string[], entities = r.entities ? JSON.parse(r.entities) as string[] : [];
    const haystack = `${path.join(" ")} ${r.gist ?? ""} ${entities.join(" ")}`.toLowerCase();
    return { ticker: r.ticker, documentId: r.document_id, form: r.form, filedAt: r.filed_at, sectionId: r.section_id, path, canonical: r.canonical, topic: r.topic, gist: r.gist, entities,
      score: words.length ? words.filter(w => haystack.includes(w)).length / words.length : 1, via: "index" as const };
  }).filter(r => r.score > 0);
  // One hit per company and section path: the newest document's.
  const seen = new Set<string>();
  return found.sort((a, b) => b.score - a.score || b.filedAt.localeCompare(a.filedAt)).filter(r => { const key = `${r.ticker}|${r.path.join("›")}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, request.limit ?? 20);
}

/** Interleaves sections by company, keeping each company's own order. */
export function alternate(found: FoundSection[]): FoundSection[] {
  const queues = new Map<string, FoundSection[]>();
  for (const f of found) queues.set(f.ticker, [...queues.get(f.ticker) ?? [], f]);
  const out: FoundSection[] = [];
  for (let round = 0; out.length < found.length; round++) for (const queue of queues.values()) if (queue[round]) out.push(queue[round]!);
  return out;
}

/**
 * Sections across companies: exact matches on card topic, entity, title words, a business or a cross-company
 * category from the index, then, for a natural-language question, sections found by meaning through AI Search.
 * A category reads the links whose category was verified by review or set by an admin.
 */
export async function libraryFindAcross(env: SecPipelineEnv, request: {
  tickers?: string[]; topic?: string; entity?: string; keywords?: string; canonical?: LibraryCanonical; question?: string;
  category?: IndustryCategory; businessKey?: string; limit?: number;
}): Promise<LibraryFindResult> {
  const db = env.DB!, limit = request.limit ?? 20;
  let tickers = request.tickers, sectionIds: string[] | undefined;
  if (request.category || request.businessKey) {
    const links = (await readLinks(db, { category: request.category }))
      .filter(l => (!request.businessKey || l.businessKey === request.businessKey) && (!tickers?.length || tickers.includes(l.ticker)));
    sectionIds = links.flatMap(l => l.sectionIds);
    tickers = [...new Set(links.map(l => l.ticker))];
    if (!tickers.length) return { found: [], recall: request.question ? "empty" : "off" };
  }
  // Asked across companies, each company's best sections take turns, so one filer's long report does not fill the list.
  const exact = request.topic || request.entity || request.keywords || request.canonical || sectionIds || !request.question
    ? alternate(await libraryFind(db, { tickers, topic: request.topic, entity: request.entity, keywords: request.keywords, canonical: request.canonical, sectionIds, limit: limit * 4 })).slice(0, limit) : [];
  if (!request.question) return { found: exact, recall: "off" };
  if (!searchEnabled(env)) return { found: exact, recall: "off" };
  try {
    const recalled = await libraryRecall(env, { question: request.question, tickers, canonical: request.canonical, topic: request.topic, limit });
    const seen = new Set(exact.map(f => f.sectionId));
    return { found: [...exact, ...recalled.filter(r => !seen.has(r.sectionId))].slice(0, limit * 2), recall: recalled.length ? "ok" : "empty" };
  } catch (error) { return { found: exact, recall: "error", recallError: String((error as Error)?.message ?? error).slice(0, 300) }; }
}

/** The validated quarterly numbers the map draws, one row per number, with the filing each comes from. */
export async function libraryFactRows(db: D1Database, ticker: string, options: { quarters?: number } = {}): Promise<LibraryFactRow[]> {
  const publication = await readCompletePublicationForTicker(db, ticker);
  if (publication.status !== "ready" || !publication.flow) return [];
  const rows: LibraryFactRow[] = [];
  const scaleName = (scale: number) => scale === 1_000_000 ? "million" : scale === 1_000 ? "thousand" : scale === 1 ? "" : `x${scale}`;
  for (const quarter of [...publication.flow.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).slice(0, options.quarters ?? 2)) {
    const unit = `${quarter.currency}${scaleName(quarter.scale) ? ` ${scaleName(quarter.scale)}` : ""}`;
    const source = (ids: string[] | undefined) => quarter.sources.find(s => ids?.includes(s.id))?.url ?? quarter.sources[0]?.url ?? "";
    const add = (business: string, flowNodeId: string | null, metric: string, amount: { value: string | null; sourceIds: string[] } | null | undefined) => {
      if (amount?.value != null) rows.push({ ticker, business, flowNodeId, metric, periodEnd: quarter.periodEnd, value: amount.value, unit, source: source(amount.sourceIds) });
    };
    for (const [metric, amount] of Object.entries(quarter.figures)) add("total", null, metric, amount);
    for (const s of quarter.segments) {
      add(s.name, s.id, "revenue", s.revenue);
      for (const c of s.children ?? []) add(`${s.name} › ${c.name}`, c.id, "revenue", c.revenue);
    }
  }
  return rows;
}

/** The same numbers across companies: for a category, the businesses whose link carries it. */
export async function libraryFactsAcross(db: D1Database, request: { tickers?: string[]; category?: IndustryCategory; quarters?: number }): Promise<LibraryFactRow[]> {
  if (!request.category) return (await Promise.all((request.tickers ?? []).map(t => libraryFactRows(db, t, request)))).flat();
  const links = (await readLinks(db, { category: request.category })).filter(l => l.flowNodeId && (!request.tickers?.length || request.tickers.includes(l.ticker)));
  const byTicker = new Map<string, Set<string>>();
  for (const l of links) byTicker.set(l.ticker, (byTicker.get(l.ticker) ?? new Set()).add(l.flowNodeId!));
  return (await Promise.all([...byTicker].map(async ([ticker, nodes]) => (await libraryFactRows(db, ticker, request)).filter(r => r.flowNodeId && nodes.has(r.flowNodeId))))).flat();
}

/** The validated quarterly numbers as lines a model reads: `公司 · 业务 · 指标 · 期间 · 数值 · 单位 · 来源申报`. */
export async function libraryFacts(db: D1Database, ticker: string, options: { quarters?: number } = {}): Promise<string[]> {
  return (await libraryFactRows(db, ticker, options)).map(r => `${r.ticker} · ${r.business} · ${r.metric} · ${r.periodEnd} · ${r.value} · ${r.unit} · ${r.source}`);
}
