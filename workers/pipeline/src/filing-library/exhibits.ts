import { classifyExhibit, exhibitTitle, type FoundMaterial } from "../guidance/sources.ts";

/**
 * An earnings filing's press releases as the filing library holds them, every passage in document order. Null when
 * the library has none for this accession yet, so the caller reads the submission from EDGAR instead.
 */
export async function libraryExhibits(db: D1Database, ticker: string, accession: string, filingDate: string): Promise<FoundMaterial[] | null> {
  const documents = (await db.prepare("SELECT document_id, document_url FROM sec_documents WHERE ticker = ? AND accession_number = ? AND doc_type = 'press_release' AND status = 'ready' ORDER BY document_url")
    .bind(ticker, accession).all<{ document_id: string; document_url: string }>()).results;
  if (!documents.length) return null;
  const materials: FoundMaterial[] = [];
  for (const d of documents) {
    const passages = (await db.prepare("SELECT text FROM sec_passages WHERE document_id = ? ORDER BY ordinal").bind(d.document_id).all<{ text: string }>()).results;
    const text = passages.map(p => p.text).join("\n\n");
    if (text.length < 400) continue;
    const file = d.document_url.slice(d.document_url.lastIndexOf("/") + 1);
    materials.push({ sourceKind: "sec", url: d.document_url, publishedAt: filingDate, kind: classifyExhibit(text), title: exhibitTitle(text, `EX-99 ${file}`), text });
  }
  return materials.length ? materials : null;
}
