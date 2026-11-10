/**
 * What a periodic-report session reads beyond its own filing (docs/filing-analysis-optimization.md §4.10): a search of
 * the filing and of the company's earlier filings, a section as it stood in earlier filings, the reports written on
 * earlier filings, and the earnings calls. Every read is a D1 lookup over what the library and the transcripts already hold.
 */
export type FoundPassage = { documentId: string; sectionId: string; passageId: string; ordinal: number; form: string; reportDate: string; filedAt: string; path: string; snippet: string };

const snippetAround = (text: string, term: string, radius = 220) => {
  const at = text.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return text.slice(0, radius * 2);
  const from = Math.max(0, at - radius), to = Math.min(text.length, at + term.length + radius);
  return `${from ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ")}${to < text.length ? "…" : ""}`;
};

/** Passages holding every one of the terms, newest filing first; `documents` narrows to some documents, else the company's primary documents of `forms`. */
export async function grepPassages(db: D1Database, ticker: string, terms: string[], scope: { documents?: string[]; forms?: string[]; limit?: number }): Promise<FoundPassage[]> {
  const words = terms.map(t => t.trim()).filter(t => t.length >= 2).slice(0, 4);
  if (!words.length) return [];
  const binds: unknown[] = [ticker];
  const where = ["d.ticker = ?1", "d.status = 'ready'"];
  if (scope.documents?.length) { binds.push(JSON.stringify(scope.documents)); where.push(`d.document_id IN (SELECT value FROM json_each(?${binds.length}))`); }
  else {
    binds.push(JSON.stringify(scope.forms?.length ? scope.forms : ["10-Q", "10-K", "20-F", "40-F"])); where.push(`d.form IN (SELECT value FROM json_each(?${binds.length}))`);
    where.push("d.doc_type = 'primary'");
  }
  for (const word of words) { binds.push(word.toLowerCase()); where.push(`instr(lower(p.text), ?${binds.length}) > 0`); }
  const rows = await db.prepare(`SELECT p.document_id, p.section_id, p.passage_id, p.ordinal, p.text, d.form, d.report_date, d.filed_at, s.path
    FROM sec_passages p JOIN sec_documents d ON d.document_id = p.document_id JOIN sec_sections s ON s.section_id = p.section_id
    WHERE ${where.join(" AND ")} ORDER BY d.filed_at DESC, p.ordinal LIMIT ${Math.min(40, Math.max(1, scope.limit ?? 20))}`).bind(...binds)
    .all<{ document_id: string; section_id: string; passage_id: string; ordinal: number; text: string; form: string; report_date: string; filed_at: string; path: string }>();
  return rows.results.map(r => ({ documentId: r.document_id, sectionId: r.section_id, passageId: r.passage_id, ordinal: r.ordinal, form: r.form, reportDate: r.report_date, filedAt: r.filed_at,
    path: (JSON.parse(r.path) as string[]).join(" › "), snippet: snippetAround(r.text, words[0]!) }));
}

export type SectionVersion = { sectionId: string; documentId: string; form: string; reportDate: string; filedAt: string; chars: number; change: string };
/** A section and the same section in the filings before it, newest first. */
export async function sectionVersions(db: D1Database, sectionId: string, count: number): Promise<SectionVersion[]> {
  const out: SectionVersion[] = [];
  let id: string | null = sectionId;
  while (id && out.length < count) {
    const row: { section_id: string; document_id: string; previous_section_id: string | null; chars: number; change: string; form: string; report_date: string; filed_at: string } | null = await db.prepare(
      `SELECT s.section_id, s.document_id, s.previous_section_id, s.chars, s.change, d.form, d.report_date, d.filed_at FROM sec_sections s JOIN sec_documents d ON d.document_id = s.document_id WHERE s.section_id = ?`).bind(id).first();
    if (!row) break;
    out.push({ sectionId: row.section_id, documentId: row.document_id, form: row.form, reportDate: row.report_date, filedAt: row.filed_at, chars: row.chars, change: row.change });
    id = row.previous_section_id;
  }
  return out;
}

type PassageText = { passage_id: string; ordinal: number; kind: string; text: string; text_sha256: string };
const passagesOf = async (db: D1Database, sectionId: string) =>
  (await db.prepare("SELECT passage_id, ordinal, kind, text, text_sha256 FROM sec_passages WHERE section_id = ? ORDER BY ordinal").bind(sectionId).all<PassageText>()).results;

const wordsOf = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3));
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.max(1, Math.min(a.size, b.size)); };

export type PassageChange = { kind: "added" | "removed" | "rewritten"; ordinal: number; text: string; before?: string };
/**
 * How a section's wording differs from an earlier version of it: paragraphs only one of them has, with a rewritten
 * paragraph paired to the one it most resembles. Tables are left to the figures; a table whose numbers moved is not a
 * change of wording.
 */
export async function sectionChanges(db: D1Database, sectionId: string, earlierId: string): Promise<PassageChange[]> {
  const [now, before] = await Promise.all([passagesOf(db, sectionId), passagesOf(db, earlierId)]);
  const earlierHashes = new Set(before.map(p => p.text_sha256)), currentHashes = new Set(now.map(p => p.text_sha256));
  const added = now.filter(p => p.kind === "paragraph" && !earlierHashes.has(p.text_sha256));
  const removed = before.filter(p => p.kind === "paragraph" && !currentHashes.has(p.text_sha256)).map(p => ({ ...p, words: wordsOf(p.text), used: false }));
  const out: PassageChange[] = [];
  for (const p of added) {
    const words = wordsOf(p.text);
    const match = removed.filter(r => !r.used).map(r => ({ r, score: overlap(words, r.words) })).sort((a, b) => b.score - a.score)[0];
    if (match && match.score >= 0.6) { match.r.used = true; out.push({ kind: "rewritten", ordinal: p.ordinal, text: p.text, before: match.r.text }); }
    else out.push({ kind: "added", ordinal: p.ordinal, text: p.text });
  }
  for (const r of removed) if (!r.used) out.push({ kind: "removed", ordinal: r.ordinal, text: r.text });
  return out;
}

/** The words of a rewritten paragraph that are new, and those that went: what a reader comparing the two would mark. */
export function wordingDelta(before: string, after: string): { gone: string; came: string } {
  const sentences = (text: string) => text.split(/(?<=[.;!?])\s+/).map(s => s.trim()).filter(Boolean);
  const a = sentences(before), b = sentences(after);
  const inA = new Set(a), inB = new Set(b);
  return { gone: a.filter(s => !inB.has(s)).join(" ").slice(0, 700), came: b.filter(s => !inA.has(s)).join(" ").slice(0, 700) };
}

export type EarlierReport = { accession: string; form: string; filingDate: string; reportDate: string; headline: string; text: string };
/** The reports published on the company's filings, newest first, the given filing left out. */
export async function earlierReports(db: D1Database, ticker: string, exceptAccession: string, limit = 8): Promise<EarlierReport[]> {
  const rows = await db.prepare("SELECT accession_number, payload FROM sec_filing_summaries WHERE ticker = ? AND accession_number <> ? ORDER BY generated_at DESC LIMIT 60").bind(ticker, exceptAccession).all<{ accession_number: string; payload: string }>();
  return rows.results.flatMap((r): EarlierReport[] => {
    try {
      const p = JSON.parse(r.payload) as { form?: string; filingDate?: string; headline?: string; report?: string; analystView?: string; bullets?: string[] };
      const text = p.report || [p.analystView, ...(p.bullets ?? [])].filter(Boolean).join("\n");
      return text ? [{ accession: r.accession_number, form: p.form ?? "", filingDate: p.filingDate ?? "", reportDate: "", headline: p.headline ?? "", text }] : [];
    } catch { return []; }
  }).sort((a, b) => b.filingDate.localeCompare(a.filingDate)).slice(0, limit);
}

/** The part of a report that says what to watch next, when it has one. */
export function watchItems(text: string): string {
  const at = text.search(/^##\s+.*\b(?:watch|next|look for)\b.*$/im);
  if (at < 0) return "";
  const rest = text.slice(at);
  const end = rest.slice(3).search(/^##\s+/m);
  return (end < 0 ? rest : rest.slice(0, end + 3)).trim().slice(0, 3000);
}

export type Transcript = { id: string; periodEnd: string; title: string; filedAt: string; content: string };
export async function transcripts(db: D1Database, ticker: string, limit = 6): Promise<Transcript[]> {
  const rows = await db.prepare("SELECT id, period_end, title, filed_at, content FROM company_transcripts WHERE ticker = ? AND status = 'ready' AND content IS NOT NULL ORDER BY period_end DESC LIMIT ?").bind(ticker, limit)
    .all<{ id: string; period_end: string; title: string | null; filed_at: string; content: string }>();
  return rows.results.map(r => ({ id: r.id, periodEnd: r.period_end, title: r.title ?? `${ticker} earnings call`, filedAt: r.filed_at, content: r.content }));
}

/** The parts of a long text around the given terms, in the order they appear. */
export function excerpts(text: string, terms: string[], budget = 9000): string {
  const lower = text.toLowerCase();
  const spots = [...new Set(terms.flatMap(t => { const found: number[] = []; let at = lower.indexOf(t.toLowerCase()); while (at >= 0 && found.length < 3) { found.push(at); at = lower.indexOf(t.toLowerCase(), at + 1500); } return found; }))].sort((a, b) => a - b);
  if (!spots.length) return text.slice(0, Math.min(budget, 3000));
  const share = Math.max(900, Math.floor(budget / spots.length));
  const pieces: string[] = [];
  let last = -1;
  for (const at of spots) {
    const from = Math.max(last + 1, at - Math.floor(share * 0.3)), to = Math.min(text.length, from + share);
    if (from >= to) continue;
    pieces.push(text.slice(from, to).trim());
    last = to;
  }
  return pieces.join("\n…\n").slice(0, budget);
}
