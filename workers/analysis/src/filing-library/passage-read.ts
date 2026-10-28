import type { LibraryTable, PublicPassage, PublicPassageResponse } from "../../../../shared/analysis-contract/filing-library.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { TICKER_PATTERN } from "../../../../shared/analysis-runtime/financial-data/policy.ts";

/**
 * The public passage read: one library passage by id, with its filing and the two passages on either side in the
 * same section, so a quote on the finding page can link to the filing's own words in context. A D1 lookup only;
 * nothing here parses. A passage of another company, or of a document that is not ready, reads as unavailable
 * rather than as an error, so a stale quote (a parser upgrade changes passage ids) degrades quietly.
 */

/** Passage ids are `p` and the 14 lowercase hex digits of `libraryHash` (parse.ts); anything else never names a passage. */
const PASSAGE_ID = /^p[0-9a-f]{14,32}$/;
/** How much of a neighbouring passage comes along: enough to place the quote, not a second copy of the section. */
const NEIGHBOUR_CHARS = 600;
const NEIGHBOURS = 2;

type PassageRow = {
  passage_id: string; section_id: string; ordinal: number; text: string; table_json: string | null;
  document_id: string; form: string; doc_type: string; filed_at: string; report_date: string; document_url: string;
};
type NeighbourRow = { passage_id: string; text: string };

const shorten = (text: string) => text.length > NEIGHBOUR_CHARS ? `${text.slice(0, NEIGHBOUR_CHARS - 1)}…` : text;

export async function readPublicPassage(db: D1Database, rawTicker: string, rawPassageId: string): Promise<PublicPassageResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!TICKER_PATTERN.test(ticker)) throw new AnalysisRequestError("INVALID_TICKER", "Invalid company ticker.");
  const passageId = rawPassageId.trim();
  if (!PASSAGE_ID.test(passageId)) throw new AnalysisRequestError("INVALID_PASSAGE", "Invalid passage id.");

  const row = await db.prepare(`SELECT p.passage_id, p.section_id, p.ordinal, p.text, p.table_json,
      d.document_id, d.form, d.doc_type, d.filed_at, d.report_date, d.document_url
    FROM sec_passages p JOIN sec_documents d ON d.document_id = p.document_id
    WHERE p.passage_id = ?1 AND d.ticker = ?2 AND d.status = 'ready'`).bind(passageId, ticker).first<PassageRow>();
  if (!row) return { schemaVersion: "passage-response.v1", status: "unavailable", passage: null };

  const [section, before, after] = await db.batch([
    db.prepare("SELECT path FROM sec_sections WHERE section_id = ?").bind(row.section_id),
    db.prepare("SELECT passage_id, text FROM sec_passages WHERE section_id = ?1 AND ordinal < ?2 ORDER BY ordinal DESC LIMIT ?3").bind(row.section_id, row.ordinal, NEIGHBOURS),
    db.prepare("SELECT passage_id, text FROM sec_passages WHERE section_id = ?1 AND ordinal > ?2 ORDER BY ordinal ASC LIMIT ?3").bind(row.section_id, row.ordinal, NEIGHBOURS),
  ]);
  const pathJson = (section?.results as Array<{ path: string }> | undefined)?.[0]?.path;
  const neighbours = (result: D1Result<unknown> | undefined) => ((result?.results ?? []) as NeighbourRow[]).map(n => ({ passageId: n.passage_id, text: shorten(n.text) }));

  const passage: PublicPassage = {
    passageId: row.passage_id, ticker,
    document: { documentId: row.document_id, form: row.form, docType: row.doc_type, filedAt: row.filed_at, reportDate: row.report_date, url: row.document_url },
    path: pathJson ? JSON.parse(pathJson) as string[] : [],
    text: row.text,
    table: row.table_json ? JSON.parse(row.table_json) as LibraryTable : null,
    // Both lists read in document order: the passage before the quote comes last in `before`.
    before: neighbours(before).reverse(),
    after: neighbours(after),
  };
  return { schemaVersion: "passage-response.v1", status: "ready", passage };
}
