import type {
  LibraryChange, LibraryDocType, LibraryDocumentSummary, LibraryPassage, LibraryPassageView, LibrarySection, LibrarySectionView, LibraryStructure,
} from "../../../../shared/analysis-contract/filing-library.ts";

/** One document's rows, written together: a reader sees the previous version or this one, never half of it. */
export type LibraryDocumentRow = Omit<LibraryDocumentSummary, "sections" | "passages" | "chars"> & { cik: string; sourceSha256: string; issues: string[] };
export type StoredSection = LibrarySection & { change: LibraryChange; previousSectionId: string | null };
export type StoredPassage = LibraryPassage & { change: LibraryChange };

/** Bound JSON per statement stays well under D1's statement limits; one row larger than this still goes alone. */
const CHUNK_BYTES = 90_000;

function chunks<T>(rows: T[], encode: (row: T) => unknown[]): string[] {
  const out: string[] = [];
  let current: string[] = [], size = 2;
  for (const row of rows) {
    const json = JSON.stringify(encode(row));
    if (current.length && size + json.length + 1 > CHUNK_BYTES) { out.push(`[${current.join(",")}]`); current = []; size = 2; }
    current.push(json); size += json.length + 1;
  }
  if (current.length) out.push(`[${current.join(",")}]`);
  return out;
}

export async function writeLibraryDocument(db: D1Database, document: LibraryDocumentRow, sections: StoredSection[], passages: StoredPassage[], events: D1PreparedStatement[] = []): Promise<void> {
  const id = document.documentId;
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM sec_passages WHERE document_id = ?").bind(id),
    db.prepare("DELETE FROM sec_sections WHERE document_id = ?").bind(id),
  ];
  const sectionSql = `INSERT INTO sec_sections (section_id, document_id, parent_id, ordinal, depth, is_leaf, canonical, item_key, title, path, xbrl_block, role, change, previous_section_id, chars, text_sha256)
    SELECT json_extract(value,'$[0]'), ?1, json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]'), json_extract(value,'$[4]'), json_extract(value,'$[5]'),
      json_extract(value,'$[6]'), json_extract(value,'$[7]'), json_extract(value,'$[8]'), json_extract(value,'$[9]'), json_extract(value,'$[10]'), json_extract(value,'$[11]'),
      json_extract(value,'$[12]'), json_extract(value,'$[13]'), json_extract(value,'$[14]') FROM json_each(?2)`;
  for (const chunk of chunks(sections, s => [s.sectionId, s.parentId, s.ordinal, s.depth, s.isLeaf ? 1 : 0, s.canonical, s.itemKey, s.title, JSON.stringify(s.path), s.xbrlBlock, s.role, s.change, s.previousSectionId, s.chars, s.textHash])) {
    statements.push(db.prepare(sectionSql).bind(id, chunk));
  }
  const passageSql = `INSERT INTO sec_passages (passage_id, document_id, section_id, ordinal, kind, text, table_json, fact_refs, chars, text_sha256, change)
    SELECT json_extract(value,'$[0]'), ?1, json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]'), json_extract(value,'$[4]'), json_extract(value,'$[5]'),
      json_extract(value,'$[6]'), json_extract(value,'$[7]'), json_extract(value,'$[8]'), json_extract(value,'$[9]') FROM json_each(?2)`;
  for (const chunk of chunks(passages, p => [p.passageId, p.sectionId, p.ordinal, p.kind, p.text, p.table ? JSON.stringify(p.table) : null, JSON.stringify(p.factRefs), p.chars, p.textHash, p.change])) {
    statements.push(db.prepare(passageSql).bind(id, chunk));
  }
  statements.push(upsertDocument(db, document, { chars: passages.reduce((n, p) => n + p.chars, 0), passages: passages.length, sections: sections.length }), ...events);
  await db.batch(statements);
}

/** A document that could not be split keeps a row, so the sweep does not retry it until the parser or the source changes. */
export async function markLibraryDocumentUnreadable(db: D1Database, document: LibraryDocumentRow): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sec_passages WHERE document_id = ?").bind(document.documentId),
    db.prepare("DELETE FROM sec_sections WHERE document_id = ?").bind(document.documentId),
    upsertDocument(db, { ...document, status: "unreadable" }, { chars: 0, passages: 0, sections: 0 }),
  ]);
}

function upsertDocument(db: D1Database, d: LibraryDocumentRow, size: { chars: number; passages: number; sections: number }): D1PreparedStatement {
  return db.prepare(`INSERT INTO sec_documents (document_id, ticker, cik, accession_number, form, doc_type, report_date, filed_at, document_url, source_sha256, parser_version,
      structure, structure_check, status, failure_reason, issues, previous_document_id, chars, passages, sections, prepared_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
    ON CONFLICT(document_id) DO UPDATE SET ticker = excluded.ticker, cik = excluded.cik, accession_number = excluded.accession_number, form = excluded.form,
      doc_type = excluded.doc_type, report_date = excluded.report_date, filed_at = excluded.filed_at, document_url = excluded.document_url,
      source_sha256 = excluded.source_sha256, parser_version = excluded.parser_version, structure = excluded.structure, structure_check = excluded.structure_check,
      status = excluded.status, failure_reason = excluded.failure_reason, issues = excluded.issues, previous_document_id = excluded.previous_document_id,
      chars = excluded.chars, passages = excluded.passages, sections = excluded.sections, prepared_at = excluded.prepared_at`)
    .bind(d.documentId, d.ticker, d.cik, d.accessionNumber, d.form, d.docType, d.reportDate, d.filedAt, d.documentUrl, d.sourceSha256, d.parserVersion,
      d.structure, JSON.stringify(d.structureCheck), d.status, d.failureReason, JSON.stringify(d.issues), d.previousDocumentId, size.chars, size.passages, size.sections, d.preparedAt);
}

const ARCHIVE_POINTERS = "sec:disclosure-audit:v1:";
/** The key range of one company's archive pointers (or of all of them), so the lookup walks the primary key instead of scanning `sec_cache`. */
const pointerRange = (ticker?: string) => { const prefix = ticker ? `${ARCHIVE_POINTERS}${ticker}:` : ARCHIVE_POINTERS; return [prefix, `${prefix.slice(0, -1)};`] as const; };

/** Archived documents with no library rows for this parser version and source, oldest first so each is compared with a prepared predecessor. */
export async function pendingLibraryDocuments(db: D1Database, parserVersion: string, limit: number, ticker?: string): Promise<Array<{ documentId: string; ticker: string; sha: string; bytes: number }>> {
  const [from, to] = pointerRange(ticker);
  const rows = await db.prepare(`SELECT json_extract(c.payload,'$.documentId') document_id, json_extract(c.payload,'$.ticker') ticker, json_extract(c.payload,'$.contentSha256') sha,
      json_extract(c.payload,'$.sourceBytes') bytes
    FROM sec_cache c LEFT JOIN sec_documents d ON d.document_id = json_extract(c.payload,'$.documentId')
    WHERE c.cache_key >= ?1 AND c.cache_key < ?2 AND (d.document_id IS NULL OR d.parser_version != ?3 OR d.source_sha256 != json_extract(c.payload,'$.contentSha256'))
    ORDER BY json_extract(c.payload,'$.source.filedAt'), document_id LIMIT ?4`).bind(from, to, parserVersion, limit).all<{ document_id: string; ticker: string; sha: string; bytes: number | null }>();
  return rows.results.filter(r => r.document_id && r.ticker && r.sha).map(r => ({ documentId: r.document_id, ticker: r.ticker, sha: r.sha, bytes: r.bytes ?? 0 }));
}

export async function countPendingLibraryDocuments(db: D1Database, parserVersion: string): Promise<number> {
  const [from, to] = pointerRange();
  const row = await db.prepare(`SELECT COUNT(*) n FROM sec_cache c LEFT JOIN sec_documents d ON d.document_id = json_extract(c.payload,'$.documentId')
    WHERE c.cache_key >= ? AND c.cache_key < ? AND (d.document_id IS NULL OR d.parser_version != ? OR d.source_sha256 != json_extract(c.payload,'$.contentSha256'))`).bind(from, to, parserVersion).first<{ n: number }>();
  return row?.n ?? 0;
}

/** The prepared predecessor a document is compared with: the same company's previous document of the same kind. */
export async function previousLibraryDocument(db: D1Database, d: { ticker: string; form: string; docType: LibraryDocType; filedAt: string; documentId: string }): Promise<string | null> {
  const family = d.form.replace(/\/A$/, "");
  const row = await db.prepare(`SELECT document_id FROM sec_documents WHERE ticker = ? AND doc_type = ? AND (form = ? OR form = ?) AND status = 'ready'
    AND document_id != ? AND (filed_at < ? OR (filed_at = ? AND document_id < ?)) ORDER BY filed_at DESC LIMIT 1`)
    .bind(d.ticker, d.docType, family, `${family}/A`, d.documentId, d.filedAt, d.filedAt, d.documentId).first<{ document_id: string }>();
  return row?.document_id ?? null;
}

export async function librarySectionHashes(db: D1Database, documentId: string): Promise<Array<{ sectionId: string; canonical: string; path: string; textHash: string }>> {
  const rows = await db.prepare("SELECT section_id, canonical, path, text_sha256 FROM sec_sections WHERE document_id = ?").bind(documentId).all<{ section_id: string; canonical: string; path: string; text_sha256: string }>();
  return rows.results.map(r => ({ sectionId: r.section_id, canonical: r.canonical, path: r.path, textHash: r.text_sha256 }));
}

export async function libraryPassageHashes(db: D1Database, documentId: string): Promise<Set<string>> {
  const rows = await db.prepare("SELECT text_sha256 FROM sec_passages WHERE document_id = ?").bind(documentId).all<{ text_sha256: string }>();
  return new Set(rows.results.map(r => r.text_sha256));
}

type DocumentRecord = {
  document_id: string; ticker: string; accession_number: string; form: string; doc_type: LibraryDocType; report_date: string; filed_at: string;
  document_url: string; parser_version: string; structure: LibraryStructure; structure_check: string; status: "ready" | "unreadable";
  failure_reason: string | null; previous_document_id: string | null; chars: number; passages: number; sections: number; prepared_at: string;
};
const summaryOf = (r: DocumentRecord): LibraryDocumentSummary => ({
  documentId: r.document_id, ticker: r.ticker, accessionNumber: r.accession_number, form: r.form, docType: r.doc_type, reportDate: r.report_date,
  filedAt: r.filed_at, documentUrl: r.document_url, parserVersion: r.parser_version, structure: r.structure,
  structureCheck: JSON.parse(r.structure_check), status: r.status, failureReason: r.failure_reason, previousDocumentId: r.previous_document_id,
  chars: r.chars, passages: r.passages, sections: r.sections, preparedAt: r.prepared_at,
});

export async function listLibraryDocuments(db: D1Database, filter: { ticker?: string; forms?: string[]; accessions?: string[]; limit?: number } = {}): Promise<LibraryDocumentSummary[]> {
  const where: string[] = [], binds: unknown[] = [];
  if (filter.ticker) { where.push("ticker = ?"); binds.push(filter.ticker); }
  if (filter.accessions) { where.push("accession_number IN (SELECT value FROM json_each(?))"); binds.push(JSON.stringify(filter.accessions)); }
  if (filter.forms?.length) { where.push("form IN (SELECT value FROM json_each(?))"); binds.push(JSON.stringify(filter.forms)); }
  const rows = await db.prepare(`SELECT * FROM sec_documents ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY filed_at DESC, document_id LIMIT ?`)
    .bind(...binds, Math.min(500, filter.limit ?? 100)).all<DocumentRecord>();
  return rows.results.map(summaryOf);
}

export async function readLibraryDocument(db: D1Database, documentId: string): Promise<LibraryDocumentSummary | null> {
  const row = await db.prepare("SELECT * FROM sec_documents WHERE document_id = ?").bind(documentId).first<DocumentRecord>();
  return row ? summaryOf(row) : null;
}

type SectionRecord = { section_id: string; parent_id: string | null; ordinal: number; depth: number; is_leaf: number; canonical: string; item_key: string | null; title: string; path: string; xbrl_block: string | null; role: string; change: string; chars: number };
const sectionOf = (r: SectionRecord): LibrarySectionView => ({
  sectionId: r.section_id, parentId: r.parent_id, ordinal: r.ordinal, depth: r.depth, isLeaf: !!r.is_leaf, canonical: r.canonical as LibrarySectionView["canonical"],
  itemKey: r.item_key, title: r.title, path: JSON.parse(r.path), xbrlBlock: r.xbrl_block, role: r.role as LibrarySectionView["role"], change: r.change as LibraryChange, chars: r.chars,
});

export async function libraryOutline(db: D1Database, documentId: string): Promise<LibrarySectionView[]> {
  const rows = await db.prepare("SELECT section_id, parent_id, ordinal, depth, is_leaf, canonical, item_key, title, path, xbrl_block, role, change, chars FROM sec_sections WHERE document_id = ? ORDER BY ordinal")
    .bind(documentId).all<SectionRecord>();
  return rows.results.map(sectionOf);
}

export async function librarySections(db: D1Database, sectionIds: string[]): Promise<Array<LibrarySectionView & { documentId: string }>> {
  if (!sectionIds.length) return [];
  const rows = await db.prepare(`SELECT document_id, section_id, parent_id, ordinal, depth, is_leaf, canonical, item_key, title, path, xbrl_block, role, change, chars FROM sec_sections
    WHERE section_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(sectionIds)).all<SectionRecord & { document_id: string }>();
  return rows.results.map(r => ({ ...sectionOf(r), documentId: r.document_id }));
}

type PassageRecord = { passage_id: string; section_id: string; ordinal: number; kind: "paragraph" | "table"; text: string; table_json: string | null; fact_refs: string; chars: number; change: string };
const passageOf = (r: PassageRecord): LibraryPassageView => ({
  passageId: r.passage_id, sectionId: r.section_id, ordinal: r.ordinal, kind: r.kind, text: r.text, table: r.table_json ? JSON.parse(r.table_json) : null,
  factRefs: JSON.parse(r.fact_refs), chars: r.chars, change: r.change as LibraryChange,
});

/** The passages under a section, its descendants included, in document order. */
export async function librarySectionPassages(db: D1Database, documentId: string, sectionIds: string[]): Promise<LibraryPassageView[]> {
  if (!sectionIds.length) return [];
  const rows = await db.prepare(`SELECT passage_id, section_id, ordinal, kind, text, table_json, fact_refs, chars, change FROM sec_passages
    WHERE document_id = ? AND section_id IN (SELECT value FROM json_each(?)) ORDER BY ordinal`).bind(documentId, JSON.stringify(sectionIds)).all<PassageRecord>();
  return rows.results.map(passageOf);
}

export async function libraryPassages(db: D1Database, passageIds: string[]): Promise<Array<LibraryPassageView & { documentId: string }>> {
  if (!passageIds.length) return [];
  const rows = await db.prepare(`SELECT document_id, passage_id, section_id, ordinal, kind, text, table_json, fact_refs, chars, change FROM sec_passages
    WHERE passage_id IN (SELECT value FROM json_each(?)) ORDER BY document_id, ordinal`).bind(JSON.stringify(passageIds)).all<PassageRecord & { document_id: string }>();
  return rows.results.map(r => ({ ...passageOf(r), documentId: r.document_id }));
}
