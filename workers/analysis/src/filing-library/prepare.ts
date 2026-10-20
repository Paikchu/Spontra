import type { LibraryDocType } from "../../../../shared/analysis-contract/filing-library.ts";
import { LIBRARY_PARSER_VERSION, parseFilingDocument } from "../../../../shared/analysis-runtime/filing-library/parse.ts";
import { businessHint, compactName } from "../../../../shared/analysis-runtime/business-tree.ts";
import { treeBusinesses } from "../business-tree/workflow.ts";
import { disclosureAuditPrefix, type StoredAudit } from "../financial-data/disclosure-audit.ts";
import { readCompletePublicationForTicker } from "../financial-data/publication.ts";
import type { AnalysisEnv } from "../operations.ts";
import { outboxStatement } from "../pipeline/outbox.ts";
import { D1SecRepository } from "../sec/d1.ts";
import {
  libraryPassageHashes, librarySectionHashes, markLibraryDocumentUnreadable, previousLibraryDocument, writeLibraryDocument,
  type LibraryDocumentRow, type StoredPassage, type StoredSection,
} from "./store.ts";

export type FilingLibraryParams = { documentId: string; ticker: string; sha: string };

const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, "0")).join("");

async function readPointer(env: AnalysisEnv, p: FilingLibraryParams): Promise<StoredAudit | null> {
  const stored = await new D1SecRepository(env.DB!).getCache<StoredAudit>(disclosureAuditPrefix(p.ticker) + p.documentId);
  return stored?.payload ?? null;
}

function documentRow(p: FilingLibraryParams, record: StoredAudit, extra: Partial<LibraryDocumentRow> & { docType: LibraryDocType }): LibraryDocumentRow {
  return {
    documentId: p.documentId, ticker: p.ticker, cik: record.source.documentUrl.match(/\/Archives\/edgar\/data\/(\d+)\//)?.[1] ?? "",
    accessionNumber: record.source.accessionNumber, form: record.source.form, reportDate: record.source.reportDate ?? "", filedAt: record.source.filedAt ?? "",
    documentUrl: record.source.documentUrl, sourceSha256: record.contentSha256, parserVersion: LIBRARY_PARSER_VERSION, structure: "flat",
    structureCheck: { status: "not_applicable", missing: [] }, status: "ready", failureReason: null, issues: [], previousDocumentId: null,
    preparedAt: new Date().toISOString(), ...extra,
  };
}

export async function recordUnreadable(env: AnalysisEnv, p: FilingLibraryParams, reason: string): Promise<void> {
  const record = await readPointer(env, p);
  if (!record) return;
  await markLibraryDocumentUnreadable(env.DB!, documentRow(p, record, { docType: "primary", status: "unreadable", failureReason: reason.slice(0, 200) }));
}

/** The disclosed businesses whose names should head a part of the business section, from the same flow the map draws. */
async function segmentNames(env: AnalysisEnv, ticker: string): Promise<string[]> {
  const publication = await readCompletePublicationForTicker(env.DB!, ticker).catch(() => null);
  const found = publication?.status === "ready" ? treeBusinesses(publication.flow) : null;
  return found?.businesses.map(b => businessHint(b.flowNodeId, b.name)) ?? [];
}

/** Reads the archived HTML, splits it, compares it with the company's previous document of the same kind, and writes all rows at once. */
export async function prepareLibraryDocument(env: AnalysisEnv, p: FilingLibraryParams, causeId: string | null = null): Promise<Record<string, unknown>> {
  const db = env.DB!;
  const record = await readPointer(env, p);
  // A newer archive of the document replaced this one; the next sweep starts a split for it.
  if (!record || record.contentSha256 !== p.sha || !record.rawKey?.startsWith("financial-disclosures/")) return { status: "superseded" };
  const object = await env.SEC_FILINGS.get(record.rawKey);
  if (!object) throw new Error("ARCHIVE_SOURCE_MISSING");
  const html = await object.text();
  if (await digest(html) !== record.contentSha256) {
    await recordUnreadable(env, p, "ARCHIVE_MISMATCH");
    return { status: "unreadable", reason: "ARCHIVE_MISMATCH" };
  }
  let parsed: ReturnType<typeof parseFilingDocument>;
  try { parsed = parseFilingDocument(html, { documentId: p.documentId, accessionNumber: record.source.accessionNumber, documentUrl: record.source.documentUrl, form: record.source.form }); }
  catch (error) {
    // A document the parser cannot read is recorded and skipped; it is tried again when the parser version changes.
    await recordUnreadable(env, p, `PARSE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return { status: "unreadable", reason: "PARSE_FAILED" };
  }
  if (!parsed.passages.length) {
    await markLibraryDocumentUnreadable(db, documentRow(p, record, { docType: parsed.docType, structure: parsed.structure, status: "unreadable", failureReason: "NO_READABLE_TEXT", issues: parsed.issues }));
    return { status: "unreadable", reason: "NO_READABLE_TEXT" };
  }
  const base = documentRow(p, record, { docType: parsed.docType, structure: parsed.structure, issues: parsed.issues });
  const previousDocumentId = await previousLibraryDocument(db, base);
  const previousSections = previousDocumentId ? await librarySectionHashes(db, previousDocumentId) : [];
  const previousPassages = previousDocumentId ? await libraryPassageHashes(db, previousDocumentId) : new Set<string>();
  const byPath = new Map(previousSections.map(s => [`${s.canonical}|${s.path.toLowerCase()}`, s]));
  const sections: StoredSection[] = parsed.sections.map(s => {
    const before = byPath.get(`${s.canonical}|${JSON.stringify(s.path).toLowerCase()}`);
    return { ...s, previousSectionId: before?.sectionId ?? null, change: !previousDocumentId || !before ? "new" : before.textHash === s.textHash ? "unchanged" : "changed" };
  });
  const passages: StoredPassage[] = parsed.passages.map(x => ({ ...x, change: previousPassages.has(x.textHash) ? "unchanged" : previousDocumentId ? "changed" : "new" }));
  // Each disclosed business should name a part of an annual report's business section; a missing one points at a heading the parser misread.
  let structureCheck = base.structureCheck;
  if (parsed.docType === "primary" && /^(?:10-K|20-F)$/.test(record.source.form)) {
    const titles = sections.filter(s => s.canonical === "business").map(s => compactName(s.title)).join("|");
    const names = await segmentNames(env, p.ticker);
    if (names.length) {
      const missing = names.filter(name => !titles.includes(compactName(name)));
      structureCheck = { status: missing.length ? "segments_missing" : "ok", missing };
    }
  }
  // The rows and the event that announces them commit together.
  const cik = base.cik ? base.cik.padStart(10, "0") : null;
  await writeLibraryDocument(db, { ...base, previousDocumentId, structureCheck }, sections, passages,
    [outboxStatement(db, { type: "library.prepared", ticker: p.ticker, cik, detail: { form: record.source.form, accession: record.source.accessionNumber }, causeId })]);
  return {
    status: "ready", structure: parsed.structure, docType: parsed.docType, sections: sections.length, passages: passages.length,
    changed: sections.filter(s => s.change !== "unchanged").length, structureCheck: structureCheck.status,
  };
}
