import type { FilingTable, FilingFactRow } from "./filing-content.ts";

export const MATERIAL_VERSION = "filing-material.v1";
export const MATERIAL_LAYOUT_VERSION = "deterministic-l1.v1";
export const MATERIAL_BRIEF_VERSION = "material-brief.v1";
export const MATERIAL_READ_BYTES = 64_000;
export const MATERIAL_ARCHIVE_INVENTORY_VERSION = "sec-directory-union.v1";
export type MaterialRef = { ticker: string; accession: string; version: string };
export type MaterialFiling = {
  ticker: string; accession: string; cik: string; form: string; filedAt: string; reportDate: string;
  companyName: string; primaryDocument: string; documentUrl: string; indexUrl: string;
  acceptedAt?: string; items?: string;
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
  form: string; filedAt: string; reportDate: string; table: FilingTable;
};
export type MaterialDocumentCoverage = {
  documentId: string; filename: string; sourceTextChars: number; retainedTextChars: number;
  sourceTables: number; retainedTables: number; sourceImages: number; retainedImages: number;
  pages: number; retainedPages: number; issues: string[];
  reconciliation?: { method: "human-source-reconciliation.v1"; receiptKey: string; sourceSha256: string; candidateSha256: string; reviewer: string; reviewedAt: string; failedExtractionKey: string; originalIssues: string[] };
  htmlBaseline?: {
    method: "independent-raw-token-inventory.v1";
    textLeaves: number; mappedLeaves: number; textChars: number; mappedTextChars: number;
    tables: number; mappedTables: number; images: number; mappedImages: number;
  };
};
export type ParsedMaterialDocument = {
  blocks: MaterialBlock[]; tables: MaterialTable[]; facts: FilingFactRow[];
  coverage: MaterialDocumentCoverage;
};
export type MaterialBriefDisclosureMeta = {
  coveredPeriodEnd: string | null;
  fiscalPeriod: string | null;
  disclosureKind: "earnings-release" | "periodic-report" | "amendment" | "non-earnings-event";
  isEarningsRelease: boolean;
  currency: string | null;
};
export type MaterialBriefMetric = {
  name: string;
  segment: string | null;
  period: string;
  calendarPeriod: string | null;
  value: string;
  unit: string | null;
  basis: "GAAP" | "Non-GAAP" | "Operational" | "Other";
  yoy: string | null;
  qoq: string | null;
  note: string | null;
  sourceIds: string[];
};
export type MaterialBriefItem = {
  topic: string;
  summary: string;
  quantitativeTerms: string | null;
  sourceIds: string[];
};
export type MaterialBriefIndustrySignal = {
  dimension: "demand" | "pricing" | "capacity_supply" | "capex" | "competition" | "macro_policy" | "other";
  summary: string;
  stance: "positive" | "negative" | "mixed" | "neutral";
  sourceIds: string[];
};
export type MaterialBriefTableEntry = {
  tableId: string;
  description: string;
  relatedSourceIds: string[];
};
export type MaterialBrief = {
  format: typeof MATERIAL_BRIEF_VERSION;
  ref: MaterialRef;
  generatedAt: string;
  model: string;
  disclosureMeta: MaterialBriefDisclosureMeta;
  headline: string;
  keyTakeaways: Array<{ text: string; sourceIds: string[] }>;
  metrics: MaterialBriefMetric[];
  guidanceAndChanges: MaterialBriefItem[];
  risksAndFootnotes: MaterialBriefItem[];
  industrySignals: MaterialBriefIndustrySignal[];
  tableCatalog: MaterialBriefTableEntry[];
  invalidSourceIdsDropped: number;
};
export type MaterialBriefState =
  | { status: "idle" }
  | { status: "running"; runId: string; model: string; startedAt: string; version: string }
  | {
      status: "ready";
      runId: string;
      version: string;
      briefVersion: string;
      key: string;
      markdownKey: string;
      model: string;
      generatedAt: string;
      metricsCount: number;
      signalsCount: number;
      tablesDescribed: number;
      inputTokens?: number;
      outputTokens?: number;
      durationMs?: number;
    }
  | { status: "failed"; runId: string; version: string; model: string; failedAt: string; error: string };
export type MaterialBriefResponse = {
  state: MaterialBriefState;
  brief: MaterialBrief | null;
  markdown: string | null;
};
export type MaterialArchiveInventory = {
  inventoryVersion: typeof MATERIAL_ARCHIVE_INVENTORY_VERSION;
  directory: { url: string; rawKey: string; sha256: string; files: string[] };
  excluded: Array<{ filename: string; reason: "archived-as-complete-submission" | "sec-generated-filing-index" | "sec-generated-filing-header-index" }>;
};
export type MaterialCoverage = {
  expectedDocuments: number; archivedDocuments: number; documents: MaterialDocumentCoverage[];
  sourceBlocks: number; retainedBlocks: number; duplicates: Array<{ blockId: string; target: string }>;
  excluded: Array<{ blockId: string; reason: string }>; tableCells: number; checkedCells: number;
  issues: string[];
  archiveInventory?: MaterialArchiveInventory;
};
export type MaterialSnapshot = {
  format: "filing-material.index.v2";
  ref: MaterialRef; filing: MaterialFiling; createdAt: string; documents: MaterialSource[];
  blocks: MaterialIndexedBlock[]; tables: MaterialTable[]; facts: FilingFactRow[];
  markdown: MaterialMarkdown; toc: Array<{ anchor: string; title: string; chars: number; offset: number; kind?: "primary" | "exhibit" | "technical" }>;
  coverage: MaterialCoverage;
  brief?: { key: string; markdownKey: string; model: string; generatedAt: string; metricsCount: number; signalsCount: number };
};
export type MaterialExtractFile = {
  filename: string;
  type: string;
  status: "pending" | "extracting" | "done" | "failed";
  container?: string | null;
};
export type MaterialState =
  | { status: "preparing"; filing: MaterialFiling; progress: string; files?: MaterialExtractFile[]; updatedAt?: string; stalled?: boolean }
  | { status: "blocked"; filing: MaterialFiling; issues: string[]; files?: MaterialExtractFile[] }
  | { status: "ready"; ref: MaterialRef; filing: MaterialFiling; snapshotKey: string; markdownKey: string; preparedAt: string; preparationVersion: string };

export type MaterialPage = {
  ref: MaterialRef; text: string; blockIds: string[]; nextCursor: string | null;
  toc: MaterialSnapshot["toc"];
};
