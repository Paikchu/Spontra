import type { LibraryTable } from "./filing-library.ts";
import type { FilingFactRow } from "../analysis-runtime/filing-library/facts.ts";

export const MATERIAL_VERSION = "filing-material.v1";
export const MATERIAL_ORGANIZER_VERSION = "source-organizer.v2";
export type MaterialRef = { ticker: string; accession: string; version: string };
export type MaterialFiling = {
  ticker: string; accession: string; cik: string; form: string; filedAt: string; reportDate: string;
  companyName: string; primaryDocument: string; documentUrl: string; indexUrl: string;
};
export type MaterialSource = {
  id: string; filename: string; type: string; url: string; contentType: string;
  rawKey: string; sha256: string; bytes: number; container: string | null;
};
export type MaterialBlock = {
  id: string; documentId: string; filename: string; sourceUrl: string; title: string; path: string[];
  kind: "paragraph" | "table" | "image" | "code"; text: string; tableId: string | null;
  locator: { start: number | null; end: number | null; page: number | null };
};
export type MaterialTextRange = { anchorOffset: number; offset: number; length: number; chars: number; sha256: string };
export type MaterialIndexedBlock = Omit<MaterialBlock, "text"> & { range: MaterialTextRange | null } & (
  | { storage: "inline"; text: string }
  | { storage: "markdown"; text: null }
);
export type MaterialMarkdown = { key: string; bytes: number; chars: number };
export type MaterialTable = {
  tableId: string; documentId: string; title: string; description: string; filename: string;
  csvKey: string; csv: string; sha256: string; sourceUrl: string; anchor: string;
  form: string; filedAt: string; reportDate: string; table: LibraryTable;
};
export type MaterialDocumentCoverage = {
  documentId: string; filename: string; sourceTextChars: number; retainedTextChars: number;
  sourceTables: number; retainedTables: number; sourceImages: number; retainedImages: number;
  pages: number; retainedPages: number; issues: string[];
};
export type ParsedMaterialDocument = {
  blocks: MaterialBlock[]; tables: MaterialTable[]; facts: FilingFactRow[];
  coverage: MaterialDocumentCoverage;
};
export type MaterialDecision =
  | { blockId: string; action: "keep"; section: string }
  | { blockId: string; action: "duplicate"; target: string }
  | { blockId: string; action: "boilerplate"; reason: string };
export type MaterialCoverage = {
  expectedDocuments: number; archivedDocuments: number; documents: MaterialDocumentCoverage[];
  sourceBlocks: number; retainedBlocks: number; duplicates: Array<{ blockId: string; target: string }>;
  excluded: Array<{ blockId: string; reason: string }>; tableCells: number; checkedCells: number;
  issues: string[];
};
export type MaterialSnapshot = {
  format: "filing-material.index.v2";
  ref: MaterialRef; filing: MaterialFiling; createdAt: string; documents: MaterialSource[];
  blocks: MaterialIndexedBlock[]; tables: MaterialTable[]; facts: FilingFactRow[];
  markdown: MaterialMarkdown; toc: Array<{ anchor: string; title: string; chars: number; offset: number }>;
  coverage: MaterialCoverage;
};
export type MaterialState =
  | { status: "preparing"; filing: MaterialFiling; progress: string }
  | { status: "blocked"; filing: MaterialFiling; issues: string[] }
  | { status: "ready"; ref: MaterialRef; filing: MaterialFiling; snapshotKey: string; markdownKey: string; preparedAt: string; preparationVersion: string };

export type MaterialPage = {
  ref: MaterialRef; text: string; blockIds: string[]; nextCursor: string | null;
  toc: MaterialSnapshot["toc"];
};
