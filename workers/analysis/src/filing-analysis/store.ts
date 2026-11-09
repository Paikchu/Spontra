import type { SectionFacts, SectionNote } from "./worklist.ts";

export type FilingStatus = "registered" | "waiting" | "running" | "published" | "recorded" | "withheld" | "failed";
export type FilingRow = { ticker: string; accession: string; unitKey: string; form: string; filedAt: string; profile: string; profileVersion: string; status: FilingStatus; reason: string | null; attempts: number; tokens: number; revision: number };
export type NewFiling = Pick<FilingRow, "ticker" | "accession" | "unitKey" | "form" | "filedAt" | "profile" | "profileVersion">;
type Row = { ticker: string; accession_number: string; unit_key: string; form: string; filed_at: string; profile: string; profile_version: string; status: FilingStatus; reason: string | null; attempts: number; tokens: number; revision: number };

/** A filing whose row in the events publication is not there yet. The publication triggers nothing here (it follows the
 * reports this path publishes, so that edge would be a loop): the task looks again shortly, for a bounded time. */
export const WAITING_FOR_EVENTS = "waiting for the events publication";
export const eventsWaitOver = async (db: D1Database, ticker: string, filedSince: string) =>
  !!await db.prepare("SELECT 1 AS ok FROM filing_analyses WHERE ticker = ? AND status = 'waiting' AND reason = ? AND filed_at >= ? LIMIT 1").bind(ticker, WAITING_FOR_EVENTS, filedSince).first();

/** A failed filing is tried again by later runs this many times, then waits for the admin. */
export const MAX_ATTEMPTS = 3;
const rowOf = (r: Row): FilingRow => ({ ticker: r.ticker, accession: r.accession_number, unitKey: r.unit_key, form: r.form, filedAt: r.filed_at, profile: r.profile, profileVersion: r.profile_version, status: r.status, reason: r.reason, attempts: r.attempts, tokens: r.tokens, revision: r.revision });

/** Registers filings not seen before; a filing already registered keeps its state, and takes a corrected unit or profile while it waits. */
export async function registerFilings(db: D1Database, filings: NewFiling[], now: string): Promise<void> {
  if (!filings.length) return;
  const statement = db.prepare(`INSERT INTO filing_analyses (ticker, accession_number, unit_key, form, filed_at, profile, profile_version, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'registered', ?)
    ON CONFLICT(ticker, accession_number) DO UPDATE SET unit_key = excluded.unit_key, profile = excluded.profile, profile_version = excluded.profile_version, updated_at = excluded.updated_at
    WHERE filing_analyses.status IN ('registered', 'waiting')`);
  await db.batch(filings.map(f => statement.bind(f.ticker, f.accession, f.unitKey, f.form, f.filedAt, f.profile, f.profileVersion, now)));
}

/** Puts one filing back at the start of the path for a manual run, whatever it came to before. */
export const resetFiling = (db: D1Database, ticker: string, accession: string, now: string) =>
  db.prepare("UPDATE filing_analyses SET status = 'registered', reason = NULL, attempts = 0, updated_at = ? WHERE ticker = ? AND accession_number = ?").bind(now, ticker, accession).run();

/** The filings a run has to look at, oldest first so the section notes roll forward in filing order. */
export async function dueFilings(db: D1Database, ticker: string, accession: string | null, staleBefore = ""): Promise<FilingRow[]> {
  const rows = accession
    ? await db.prepare("SELECT * FROM filing_analyses WHERE ticker = ? AND accession_number = ?").bind(ticker, accession).all<Row>()
    : await db.prepare("SELECT * FROM filing_analyses WHERE ticker = ? AND (status IN ('registered', 'waiting') OR (status = 'failed' AND attempts < ?) OR (status = 'running' AND updated_at < ?)) ORDER BY filed_at, accession_number").bind(ticker, MAX_ATTEMPTS, staleBefore).all<Row>();
  return rows.results.map(rowOf);
}

export type FilingUpdate = { status: FilingStatus; reason?: string | null; runId?: string; tokens?: number; failed?: boolean; revision?: number; artifactKey?: string; publishedAt?: string };
export const updateFiling = (db: D1Database, ticker: string, accession: string, update: FilingUpdate, now: string) =>
  db.prepare(`UPDATE filing_analyses SET status = ?, reason = ?, run_id = COALESCE(?, run_id), tokens = COALESCE(?, tokens), attempts = attempts + ?, revision = COALESCE(?, revision), artifact_key = COALESCE(?, artifact_key), published_at = COALESCE(?, published_at), updated_at = ? WHERE ticker = ? AND accession_number = ?`)
    .bind(update.status, update.reason?.slice(0, 900) ?? null, update.runId ?? null, update.tokens ?? null, update.failed ? 1 : 0, update.revision ?? null, update.artifactKey ?? null, update.publishedAt ?? null, now, ticker, accession).run();

/** The filings a finished run failed on, as a retry of the run reads them. */
export async function failedFilings(db: D1Database, runId: string): Promise<{ failure: string; fingerprint: string } | null> {
  const rows = (await db.prepare("SELECT accession_number, reason FROM filing_analyses WHERE run_id = ? AND status = 'failed' AND attempts < ? ORDER BY accession_number").bind(runId, MAX_ATTEMPTS).all<{ accession_number: string; reason: string | null }>()).results;
  if (!rows.length) return null;
  return { failure: rows.map(r => `${r.accession_number}:${r.reason ?? "failed"}`).join(", ").slice(0, 900), fingerprint: rows.map(r => r.accession_number).join(",") };
}

type SectionRow = { document_id: string; section_id: string; path: string; canonical: string; change: SectionFacts["change"]; previous_section_id: string | null; chars: number };
/** Every leaf section of these documents, in document order. */
export async function leafSections(db: D1Database, documentIds: string[]): Promise<SectionFacts[]> {
  if (!documentIds.length) return [];
  const rows = await db.prepare("SELECT document_id, section_id, path, canonical, change, previous_section_id, chars FROM sec_sections WHERE is_leaf = 1 AND document_id IN (SELECT value FROM json_each(?)) ORDER BY document_id, ordinal").bind(JSON.stringify(documentIds)).all<SectionRow>();
  return rows.results.map(r => ({ documentId: r.document_id, sectionId: r.section_id, path: JSON.parse(r.path) as string[], canonical: r.canonical, change: r.change, previousSectionId: r.previous_section_id, chars: r.chars }));
}

export async function previousSectionOf(db: D1Database, sectionId: string): Promise<{ sectionId: string; documentId: string } | null> {
  const row = await db.prepare("SELECT p.section_id, p.document_id FROM sec_sections s JOIN sec_sections p ON p.section_id = s.previous_section_id WHERE s.section_id = ?").bind(sectionId).first<{ section_id: string; document_id: string }>();
  return row ? { sectionId: row.section_id, documentId: row.document_id } : null;
}

export async function readSectionNotes(db: D1Database, sectionIds: string[]): Promise<Map<string, SectionNote>> {
  const notes = new Map<string, SectionNote>();
  if (!sectionIds.length) return notes;
  const rows = await db.prepare("SELECT section_id, note_json FROM filing_section_notes WHERE section_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(sectionIds)).all<{ section_id: string; note_json: string }>();
  for (const r of rows.results) notes.set(r.section_id, JSON.parse(r.note_json) as SectionNote);
  return notes;
}

export type NoteWrite = { section: SectionFacts; ticker: string; status: "written" | "carried"; carriedFrom: string | null; prior: "note" | "text" | "none"; note: SectionNote; profileVersion: string };
export async function writeSectionNotes(db: D1Database, notes: NoteWrite[], now: string): Promise<void> {
  if (!notes.length) return;
  const statement = db.prepare(`INSERT INTO filing_section_notes (section_id, document_id, ticker, canonical, status, carried_from, prior, note_json, profile_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(section_id) DO UPDATE SET status = excluded.status, carried_from = excluded.carried_from, prior = excluded.prior, note_json = excluded.note_json, profile_version = excluded.profile_version, created_at = excluded.created_at`);
  // D1 takes a limited number of statements per batch.
  for (let i = 0; i < notes.length; i += 50) await db.batch(notes.slice(i, i + 50).map(n => statement.bind(n.section.sectionId, n.section.documentId, n.ticker, n.section.canonical, n.status, n.carriedFrom, n.prior, JSON.stringify(n.note), n.profileVersion, now)));
}
