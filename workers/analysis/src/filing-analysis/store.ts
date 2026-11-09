export type SectionFacts = { documentId: string; sectionId: string; path: string[]; change: string; chars: number };
export type FilingStatus = "registered" | "waiting" | "running" | "published" | "failed";
export type FilingRow = { ticker: string; accession: string; form: string; filedAt: string; profile: string; status: FilingStatus };
type Row = { ticker: string; accession_number: string; form: string; filed_at: string; profile: string; status: FilingStatus };

/** Registers filings not seen before; one already registered keeps its state. */
export async function registerFilings(db: D1Database, filings: Array<Omit<FilingRow, "status">>, now: string): Promise<void> {
  if (!filings.length) return;
  const statement = db.prepare("INSERT INTO filing_analyses (ticker, accession_number, form, filed_at, profile, status, updated_at) VALUES (?, ?, ?, ?, ?, 'registered', ?) ON CONFLICT(ticker, accession_number) DO NOTHING");
  await db.batch(filings.map(f => statement.bind(f.ticker, f.accession, f.form, f.filedAt, f.profile, now)));
}

/** The filings a run should start, oldest first, or the one a manual run names, whatever it came to before. */
export async function dueFilings(db: D1Database, ticker: string, accession: string | null): Promise<FilingRow[]> {
  const rows = accession
    ? await db.prepare("SELECT * FROM filing_analyses WHERE ticker = ? AND accession_number = ?").bind(ticker, accession).all<Row>()
    : await db.prepare("SELECT * FROM filing_analyses WHERE ticker = ? AND status IN ('registered', 'waiting') ORDER BY filed_at, accession_number").bind(ticker).all<Row>();
  return rows.results.map(r => ({ ticker: r.ticker, accession: r.accession_number, form: r.form, filedAt: r.filed_at, profile: r.profile, status: r.status }));
}

export type FilingUpdate = { status: FilingStatus; reason?: string | null; runId?: string; tokens?: number; publishedAt?: string };
export const updateFiling = (db: D1Database, ticker: string, accession: string, update: FilingUpdate, now: string) =>
  db.prepare("UPDATE filing_analyses SET status = ?, reason = ?, run_id = COALESCE(?, run_id), tokens = COALESCE(?, tokens), published_at = COALESCE(?, published_at), updated_at = ? WHERE ticker = ? AND accession_number = ?")
    .bind(update.status, update.reason?.slice(0, 900) ?? null, update.runId ?? null, update.tokens ?? null, update.publishedAt ?? null, now, ticker, accession).run();

type SectionRow = { document_id: string; section_id: string; path: string; change: string; chars: number };
/** Every leaf section of these documents, in document order. */
export async function leafSections(db: D1Database, documentIds: string[]): Promise<SectionFacts[]> {
  if (!documentIds.length) return [];
  const rows = await db.prepare("SELECT document_id, section_id, path, change, chars FROM sec_sections WHERE is_leaf = 1 AND document_id IN (SELECT value FROM json_each(?)) ORDER BY document_id, ordinal").bind(JSON.stringify(documentIds)).all<SectionRow>();
  return rows.results.map(r => ({ documentId: r.document_id, sectionId: r.section_id, path: JSON.parse(r.path) as string[], change: r.change, chars: r.chars }));
}

export async function previousSectionOf(db: D1Database, sectionId: string): Promise<{ sectionId: string; documentId: string } | null> {
  const row = await db.prepare("SELECT p.section_id, p.document_id FROM sec_sections s JOIN sec_sections p ON p.section_id = s.previous_section_id WHERE s.section_id = ?").bind(sectionId).first<{ section_id: string; document_id: string }>();
  return row ? { sectionId: row.section_id, documentId: row.document_id } : null;
}

/** Which document each section belongs to, in the order asked. */
export async function sectionDocuments(db: D1Database, sectionIds: string[]): Promise<Array<[string, string]>> {
  if (!sectionIds.length) return [];
  const rows = await db.prepare("SELECT section_id, document_id FROM sec_sections WHERE section_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(sectionIds)).all<{ section_id: string; document_id: string }>();
  const found = new Map(rows.results.map(r => [r.section_id, r.document_id]));
  return sectionIds.flatMap(id => found.has(id) ? [[id, found.get(id)!] as [string, string]] : []);
}
