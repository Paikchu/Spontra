import type { BusinessFlowQuarter } from '../../../../shared/analysis-contract/business-flow.ts';
import type { RevenueHistoryQuarter } from '../../../../shared/analysis-contract/revenue-history.ts';
import type { CollectableFiling } from '../pipeline/discovery.ts';
import { historyForIssuer, historyKey } from './history.ts';
import { readFilingDocuments, type SecReader } from './provider.ts';
import { documentText, filingTables, noteLabels, READ_NOTE_VERSION, readWithNote, type NoteModel, type NoteOutcome, type ReadNote } from './read-note.ts';

/** A filing collection has not read yet, from discovery's listing and the filing index. */
export type NewFiling = { accession: string; form: string; filedAt: string; reportDate: string | null; url: string };
const DAY = 86_400_000;
const periodic = (form: string) => /^(?:10-[QK]|20-F|40-F)(?:\/A)?$/.test(form);
const release = (q: BusinessFlowQuarter) => /^Earnings release/i.test(q.sources[0]?.title ?? '');

/**
 * The filings that may report a quarter after the newest published one, oldest first, or null before discovery has listed them. A filing counts once: one with a
 * read note under this version is passed over. Before the newest quarter has ended 70 days, only a quarterly report
 * replacing an earnings release can add to it; nothing filed before the newest quarter's own source is new.
 */
export async function newFilings(db: D1Database, ticker: string, cik: string, newest: BusinessFlowQuarter): Promise<NewFiling[] | null> {
  // Discovery's own listing, not the reports index (sec_filings): a data-only issuer has no reports index, and the
  // index is written after collection starts. Null while discovery has not recorded the listing's details.
  const listed = await db.prepare("SELECT json_extract(payload, '$.collected') collected FROM sec_cache WHERE cache_key = ?").bind(`sec:discovery:v1:${ticker}`).first<{ collected: string | null }>();
  if (!listed?.collected) return null;
  let filings: CollectableFiling[] = [];
  try { filings = JSON.parse(listed.collected); } catch { return null; }
  if (!filings.length) return [];
  const read = new Set((await db.prepare(`SELECT accession FROM filing_read_notes WHERE cik = ? AND version = ? AND accession IN (${filings.map(() => '?').join(',')})`)
    .bind(cik, READ_NOTE_VERSION, ...filings.map(f => f.accession)).all<{ accession: string }>()).results.map(r => r.accession));
  const sourceFiled = newest.sources[0]?.publishedAt ?? newest.reportedAt ?? newest.periodEnd;
  const quarterOver = new Date(Date.parse(newest.periodEnd) + 70 * DAY).toISOString().slice(0, 10);
  return [...new Map(filings.filter(f => !read.has(f.accession)).map(f => [f.accession, f])).values()]
    .filter(f => f.filedAt > sourceFiled && (f.filedAt >= quarterOver || (release(newest) && periodic(f.form))))
    .sort((a, b) => a.filedAt.localeCompare(b.filedAt) || a.accession.localeCompare(b.accession))
    .map(f => ({ accession: f.accession, form: f.form, filedAt: f.filedAt, reportDate: periodic(f.form) ? f.reportDate : null, url: f.url }));
}

export async function issuerHistory(db: D1Database, cik: string, ticker: string): Promise<RevenueHistoryQuarter[]> {
  const row = await db.prepare('SELECT payload FROM sec_cache WHERE cache_key = ?').bind(historyKey(cik)).first<{ payload: string }>();
  try { return row ? historyForIssuer(JSON.parse(row.payload), cik, ticker)?.quarters ?? [] : []; } catch { return []; }
}

/**
 * Reads one new filing with its read note and keeps the note, so the filing is never read again under this version, with
 * the problems of every note turned down on the way. A note the model could not make reconcile is kept as unresolved; a spent daily budget keeps
 * nothing, so the filing is read when budget is back. The previous note of the same kind of filing (an earnings release
 * or a periodic report) is offered for reuse.
 */
export async function readNewFiling(db: D1Database, reader: SecReader, model: NoteModel, filing: NewFiling,
  issuer: { cik: string; ticker: string; published: BusinessFlowQuarter[]; history: RevenueHistoryQuarter[] }, reserve: () => Promise<boolean>): Promise<NoteOutcome> {
  const documents = await readFilingDocuments(filing.url, reader, filing.accession, filing.form);
  const context = { tables: filingTables(documents), text: documentText(documents), published: issuer.published, history: issuer.history,
    source: { accession: filing.accession, url: filing.url, filedAt: filing.filedAt, form: filing.form } };
  const kind = periodic(filing.form) ? "form NOT LIKE '8-K%' AND form NOT LIKE '6-K%'" : "(form LIKE '8-K%' OR form LIKE '6-K%')";
  const last = await db.prepare(`SELECT note_json, labels_json FROM filing_read_notes WHERE cik = ? AND status = 'read' AND ${kind} ORDER BY updated_at DESC LIMIT 1`)
    .bind(issuer.cik).first<{ note_json: string; labels_json: string }>();
  let previous: { note: ReadNote; labels: Record<string, string> } | null = null;
  try { previous = last ? { note: JSON.parse(last.note_json), labels: JSON.parse(last.labels_json) } : null; } catch { previous = null; }
  const outcome = await readWithNote(context, model, { ticker: issuer.ticker, previous, reportDate: filing.reportDate, reserve });
  if (outcome.budget) return outcome;
  // A filing that prints no published amount anywhere (a 6-K notice) or whose note dates no newer quarter reports none.
  const status = outcome.quarter ? 'read' : outcome.nothing || (outcome.note && !outcome.note.period) ? 'no-quarter' : 'unresolved';
  const issues = outcome.nothing ? ['no table of the filing prints an already published amount'] : outcome.issues;
  await db.prepare(`INSERT INTO filing_read_notes (accession,cik,ticker,form,version,status,period_end,route,attempts,note_json,labels_json,quarter_json,issues_json,rejected_json,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(accession) DO UPDATE SET version=excluded.version,status=excluded.status,period_end=excluded.period_end,route=excluded.route,
    attempts=excluded.attempts,note_json=excluded.note_json,labels_json=excluded.labels_json,quarter_json=excluded.quarter_json,issues_json=excluded.issues_json,rejected_json=excluded.rejected_json,updated_at=excluded.updated_at`)
    .bind(filing.accession, issuer.cik, issuer.ticker, filing.form, READ_NOTE_VERSION, status, outcome.quarter?.periodEnd ?? null, outcome.route, outcome.attempts,
      outcome.note ? JSON.stringify(outcome.note) : null, outcome.note && outcome.quarter ? JSON.stringify(noteLabels(outcome.note, context.tables)) : null,
      outcome.quarter ? JSON.stringify(outcome.quarter) : null, JSON.stringify(issues.slice(0, 20)),
      JSON.stringify(outcome.rejected.map(r => ({ route: r.route, problems: r.problems.slice(0, 20) }))), new Date().toISOString()).run();
  return outcome;
}
