import type { LibraryDocType } from "../../../../shared/analysis-contract/filing-library.ts";
import type { AnalysisEnv } from "../operations.ts";

/** `EX-99.1` from `orcl-ex99_1.htm`. A file that does not name an exhibit keeps its document type. */
function exhibitLabel(url: string, docType: string): string {
  const file = fileOf(url);
  const match = /ex(?:hibit)?[-_]?(\d{1,2})(?:[-_.]?(\d))?(?=\D|$)/i.exec(file);
  if (!match) return docType;
  return match[2] ? `EX-${match[1]}.${match[2]}` : `EX-${match[1]}`;
}

/** Bump when the README's contents change, so the library task rebuilds the ones already written. */
export const FILING_README_VERSION = "filing-readme.v1";
/** One page of a README, under the smallest tool-result cap that still shows the continuation line. */
export const README_PAGE = 80_000;
const README_PREFIX = "filing-readmes/v1";

export type ReadmeFact = { passageId: string; factId: string; label: string; periodEnd: string | null; periodMonths: number | null; shown: string; unit: string };
export type ReadmePassage = { passageId: string; kind: "paragraph" | "table"; text: string };
export type ReadmeSection = { title: string; path: string[]; role: string; change: string; passages: ReadmePassage[] };
export type ReadmeDocument = { documentId: string; form: string; docType: LibraryDocType; reportDate: string; filedAt: string; url: string; sections: ReadmeSection[] };

const rank = (docType: string) => docType === "primary" ? 0 : docType === "press_release" ? 1 : 2;
const fileOf = (url: string) => { try { return decodeURIComponent(url.slice(url.lastIndexOf("/") + 1)); } catch { return url.slice(url.lastIndexOf("/") + 1); } };
const periodBit = (months: number | null) => months === 0 ? "时点" : months ? `${months}个月` : "";

/** The period line under a passage: every figure when there are few, otherwise the distinct periods. */
function factNote(facts: ReadmeFact[], kind: ReadmePassage["kind"]): string {
  if (!facts.length) return "";
  const when = (f: ReadmeFact) => [f.periodEnd ?? "期间未标明", periodBit(f.periodMonths)].filter(Boolean).join(" · ");
  if (kind === "paragraph" && facts.length <= 6) return facts.map(f => `档期 ${f.label} · ${when(f)} · ${f.shown} ${f.unit} · ${f.factId}`).join("\n");
  const periods = [...new Set(facts.map(when))];
  return `档期 ${periods.join("；")}${facts.length > periods.length ? ` · ${facts.length} 个数字` : ""}`;
}

/**
 * One filing as a single document: the primary text with boilerplate left out (a boilerplate section whose wording
 * changed against the previous filing stays), then each exhibit of the same filing. Passage ids stay in the text.
 */
export function renderFilingReadme(input: { ticker: string; accession: string; documents: ReadmeDocument[]; facts: ReadmeFact[] }): string {
  const documents = [...input.documents].sort((a, b) => rank(a.docType) - rank(b.docType) || a.documentId.localeCompare(b.documentId));
  const primary = documents.find(d => d.docType === "primary") ?? documents[0];
  const byPassage = new Map<string, ReadmeFact[]>();
  for (const fact of input.facts) byPassage.set(fact.passageId, [...byPassage.get(fact.passageId) ?? [], fact]);
  const lines = [
    `# ${input.ticker} ${primary?.form ?? ""} · 报告期 ${primary?.reportDate || "未标明"} · 提交 ${(primary?.filedAt ?? "").slice(0, 10)}`,
    "",
    `accession ${input.accession}`,
    primary ? `正文 ${primary.url}` : "",
    "",
    "这是同一份申报合成的阅读稿。封面、签名、前瞻性声明和固定套话已去掉；相对上一份同类型文件有改动的套话仍保留。附件是这份申报自己附上的文件。方括号里的编号是原文段落。数字后面的“档期”来自该段落的事实行。",
    "",
  ];
  let passages = 0;
  for (const document of documents) {
    const heading = document.docType === "primary" ? `正文 · ${document.form}` : `附件 · ${exhibitLabel(document.url, document.docType)}`;
    lines.push(`## ${heading}`, "", document.url, "");
    for (const section of document.sections) {
      const marks = [section.change !== "unchanged" ? section.change : "", section.role === "boilerplate" ? "套话有改动" : ""].filter(Boolean);
      lines.push(`### ${section.path.join(" › ") || section.title}${marks.length ? `（${marks.join("，")}）` : ""}`);
      for (const passage of section.passages) {
        passages++;
        lines.push(`[${passage.passageId}] ${passage.text}`);
        const note = factNote(byPassage.get(passage.passageId) ?? [], passage.kind);
        if (note) lines.push(note);
        lines.push("");
      }
    }
  }
  if (!passages) lines.push("这份申报去掉套话后没有可引用的正文。", "");
  return lines.filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n");
}

export function readmePage(markdown: string, offset: number): { text: string; start: number; end: number; total: number } {
  const total = markdown.length;
  const start = Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : 0, total));
  const end = Math.min(total, start + README_PAGE);
  const note = end < total ? `README 未完，${start}–${end} / ${total} 字。下一段用 offset ${end}。` : `README 完，共 ${total} 字。`;
  return { text: `${note}\n\n${markdown.slice(start, end)}`, start, end, total };
}

export function readmePassage(passageId: string): { ticker: string; accession: string } | null {
  const match = /^readme:([^:]+):(\d{10}-\d{2}-\d{6})$/.exec(passageId);
  return match ? { ticker: match[1]!, accession: match[2]! } : null;
}

const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, "0")).join("");
const readmeKey = (ticker: string, accession: string) => `${README_PREFIX}/${ticker}/${accession}.md`;

type DocRow = { document_id: string; form: string; doc_type: LibraryDocType; report_date: string; filed_at: string; document_url: string; parser_version: string; source_sha256: string };
type PassageRow = DocRow & { section_id: string; section_ordinal: number; path: string; role: string; section_change: string; title: string; passage_id: string; passage_ordinal: number; kind: "paragraph" | "table"; text: string };
type FactRow = { passage_id: string; fact_id: string; label: string; period_end: string | null; period_months: number | null; shown: string; unit: string };

async function readyDocuments(db: D1Database, ticker: string, accession: string): Promise<DocRow[]> {
  const rows = await db.prepare(`SELECT document_id, form, doc_type, report_date, filed_at, document_url, parser_version, source_sha256
    FROM sec_documents WHERE ticker = ? AND accession_number = ? AND status = 'ready' ORDER BY document_id`)
    .bind(ticker, accession).all<DocRow>();
  return rows.results;
}

/** Writes the filing's README from the library rows already stored. A filing with nothing ready drops its README. */
export async function writeFilingReadme(env: Pick<AnalysisEnv, "DB" | "SEC_FILINGS">, ticker: string, accession: string): Promise<{ chars: number; passages: number } | null> {
  const db = env.DB!;
  const docs = await readyDocuments(db, ticker, accession);
  if (!docs.length) {
    await db.prepare("DELETE FROM sec_filing_readmes WHERE ticker = ? AND accession_number = ?").bind(ticker, accession).run();
    return null;
  }
  const fingerprint = await digest([FILING_README_VERSION, ...docs.map(d => `${d.document_id}|${d.parser_version}|${d.source_sha256}`)].sort().join("\n"));
  const current = await db.prepare("SELECT fingerprint FROM sec_filing_readmes WHERE ticker = ? AND accession_number = ?").bind(ticker, accession).first<{ fingerprint: string }>();
  if (current?.fingerprint === fingerprint) return null;
  const ids = JSON.stringify(docs.map(d => d.document_id));
  const [passages, facts] = await Promise.all([
    db.prepare(`SELECT d.document_id, d.form, d.doc_type, d.report_date, d.filed_at, d.document_url, d.parser_version, d.source_sha256,
        s.section_id, s.ordinal section_ordinal, s.path, s.role, s.change section_change, s.title,
        p.passage_id, p.ordinal passage_ordinal, p.kind, p.text
      FROM sec_documents d JOIN sec_sections s ON s.document_id = d.document_id
      JOIN sec_passages p ON p.section_id = s.section_id AND p.document_id = d.document_id
      WHERE d.ticker = ? AND d.accession_number = ? AND d.status = 'ready' AND (s.role != 'boilerplate' OR s.change != 'unchanged')
      ORDER BY d.document_id, s.ordinal, p.ordinal`).bind(ticker, accession).all<PassageRow>(),
    db.prepare(`SELECT passage_id, fact_id, label, period_end, period_months, shown, unit FROM sec_fact_rows
      WHERE document_id IN (SELECT value FROM json_each(?))`).bind(ids).all<FactRow>(),
  ]);
  const grouped = new Map<string, ReadmeDocument>();
  for (const doc of docs) grouped.set(doc.document_id, { documentId: doc.document_id, form: doc.form, docType: doc.doc_type, reportDate: doc.report_date, filedAt: doc.filed_at, url: doc.document_url, sections: [] });
  const sectionOf = new Map<string, ReadmeSection>();
  for (const row of passages.results) {
    const document = grouped.get(row.document_id);
    if (!document) continue;
    let section = sectionOf.get(row.section_id);
    if (!section) {
      section = { title: row.title, path: JSON.parse(row.path) as string[], role: row.role, change: row.section_change, passages: [] };
      sectionOf.set(row.section_id, section);
      document.sections.push(section);
    }
    section.passages.push({ passageId: row.passage_id, kind: row.kind, text: row.text });
  }
  const markdown = renderFilingReadme({
    ticker, accession, documents: [...grouped.values()],
    facts: facts.results.map(f => ({ passageId: f.passage_id, factId: f.fact_id, label: f.label, periodEnd: f.period_end, periodMonths: f.period_months, shown: f.shown, unit: f.unit })),
  });
  const primary = docs.find(d => d.doc_type === "primary") ?? docs[0]!;
  const key = readmeKey(ticker, accession);
  await env.SEC_FILINGS.put(key, markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  const passageCount = [...grouped.values()].reduce((n, d) => n + d.sections.reduce((m, s) => m + s.passages.length, 0), 0);
  await db.prepare(`INSERT INTO sec_filing_readmes (ticker, accession_number, form, report_date, filed_at, r2_key, chars, passages, fingerprint, prepared_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    ON CONFLICT(ticker, accession_number) DO UPDATE SET form = excluded.form, report_date = excluded.report_date, filed_at = excluded.filed_at,
      r2_key = excluded.r2_key, chars = excluded.chars, passages = excluded.passages, fingerprint = excluded.fingerprint, prepared_at = excluded.prepared_at`)
    .bind(ticker, accession, primary.form, primary.report_date, primary.filed_at, key, markdown.length, passageCount, fingerprint, new Date().toISOString()).run();
  return { chars: markdown.length, passages: passageCount };
}

export type FilingReadme = { ticker: string; accession: string; form: string; reportDate: string; filedAt: string; url: string; chars: number; passages: number; markdown: string };
type ReadmeReader = { DB?: D1Database; SEC_FILINGS: { get(key: string): Promise<{ text(): Promise<string> } | null> } };

export async function readFilingReadme(env: ReadmeReader, ticker: string, accession: string): Promise<FilingReadme | null> {
  const db = env.DB!;
  const row = await db.prepare("SELECT form, report_date, filed_at, r2_key, chars, passages FROM sec_filing_readmes WHERE ticker = ? AND accession_number = ?")
    .bind(ticker, accession).first<{ form: string; report_date: string; filed_at: string; r2_key: string; chars: number; passages: number }>();
  if (!row) return null;
  const [object, source] = await Promise.all([
    env.SEC_FILINGS.get(row.r2_key),
    db.prepare(`SELECT document_url FROM sec_documents WHERE ticker = ? AND accession_number = ? AND status = 'ready'
      ORDER BY CASE doc_type WHEN 'primary' THEN 0 WHEN 'press_release' THEN 1 ELSE 2 END, chars DESC LIMIT 1`).bind(ticker, accession).first<{ document_url: string }>(),
  ]);
  if (!object) return null;
  return { ticker, accession, form: row.form, reportDate: row.report_date, filedAt: row.filed_at, url: source?.document_url ?? "", chars: row.chars, passages: row.passages, markdown: await object.text() };
}

export async function listFilingReadmes(db: D1Database, ticker: string, options: { forms?: string[]; limit?: number } = {}): Promise<Array<{ accession: string; form: string; reportDate: string; filedAt: string; chars: number; passages: number }>> {
  const forms = options.forms?.length ? options.forms : null;
  const rows = await db.prepare(`SELECT accession_number, form, report_date, filed_at, chars, passages FROM sec_filing_readmes
    WHERE ticker = ?1 AND (?2 IS NULL OR form IN (SELECT value FROM json_each(?2))) ORDER BY filed_at DESC LIMIT ?3`)
    .bind(ticker, forms ? JSON.stringify(forms) : null, Math.min(40, options.limit ?? 12))
    .all<{ accession_number: string; form: string; report_date: string; filed_at: string; chars: number; passages: number }>();
  return rows.results.map(r => ({ accession: r.accession_number, form: r.form, reportDate: r.report_date, filedAt: r.filed_at, chars: r.chars, passages: r.passages }));
}

/** The accession a document belongs to, or the previous primary filing's accession when `previous` is set. */
export async function resolveReadmeAccession(db: D1Database, ticker: string, args: { accession?: string; documentId?: string; previous?: boolean }): Promise<string | null> {
  let accession = args.accession ?? null;
  if (!accession && args.documentId) {
    const row = await db.prepare("SELECT accession_number FROM sec_documents WHERE document_id = ? AND ticker = ?").bind(args.documentId, ticker).first<{ accession_number: string }>();
    accession = row?.accession_number ?? null;
  }
  if (!accession || !args.previous) return accession;
  const primary = await db.prepare(`SELECT previous_document_id FROM sec_documents WHERE ticker = ? AND accession_number = ? AND doc_type = 'primary' AND status = 'ready'
    ORDER BY chars DESC LIMIT 1`).bind(ticker, accession).first<{ previous_document_id: string | null }>();
  if (!primary?.previous_document_id) return null;
  const earlier = await db.prepare("SELECT accession_number FROM sec_documents WHERE document_id = ? AND ticker = ?").bind(primary.previous_document_id, ticker).first<{ accession_number: string }>();
  return earlier?.accession_number ?? null;
}

/** Rewrites READMEs whose source documents moved. Returns how many filings remain after this batch. */
export async function refreshFilingReadmes(env: Pick<AnalysisEnv, "DB" | "SEC_FILINGS">, ticker: string, limit: number): Promise<{ written: number; remaining: number }> {
  const db = env.DB!;
  const [docs, stored] = await Promise.all([
    db.prepare("SELECT accession_number, document_id, parser_version, source_sha256 FROM sec_documents WHERE ticker = ? AND status = 'ready'").bind(ticker).all<{ accession_number: string; document_id: string; parser_version: string; source_sha256: string }>(),
    db.prepare("SELECT accession_number, fingerprint FROM sec_filing_readmes WHERE ticker = ?").bind(ticker).all<{ accession_number: string; fingerprint: string }>(),
  ]);
  const parts = new Map<string, string[]>();
  for (const row of docs.results) parts.set(row.accession_number, [...parts.get(row.accession_number) ?? [], `${row.document_id}|${row.parser_version}|${row.source_sha256}`]);
  const have = new Map(stored.results.map(r => [r.accession_number, r.fingerprint]));
  const stale: string[] = [];
  for (const [accession, rows] of parts) {
    const fingerprint = await digest([FILING_README_VERSION, ...rows].sort().join("\n"));
    if (have.get(accession) !== fingerprint) stale.push(accession);
  }
  let written = 0;
  for (const accession of stale.slice(0, limit)) {
    await writeFilingReadme(env, ticker, accession);
    written++;
  }
  return { written, remaining: Math.max(0, stale.length - written) };
}
