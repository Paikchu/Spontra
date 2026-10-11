/**
 * The filing library: every archived SEC document split once, by its own items and headings, into
 * sections and verbatim passages. Agents read it through one tool instead of fetching filings. Section
 * and passage ids derive from content, so a parser upgrade keeps the id of anything whose text did not
 * change. Numbers are not stored here: a passage only points at the XBRL facts it shows.
 */
export const LIBRARY_ROLES = ["core", "signal", "boilerplate"] as const;
export type LibraryRole = typeof LIBRARY_ROLES[number];
export type LibraryChange = "new" | "changed" | "unchanged";
/** How the document was split: by its items, by headings only, or into a flat run of paragraphs. */
export type LibraryStructure = "items" | "outline" | "flat";
export type LibraryDocType = "primary" | "press_release" | "exhibit";
/** The same part of a filing under one name across 10-K, 10-Q and 20-F. */
export const LIBRARY_CANONICALS = [
  "front", "business", "risk_factors", "unresolved_comments", "cybersecurity", "properties", "legal", "mine_safety", "market",
  "reserved", "mdna", "market_risk", "financial_statements", "accountant_changes", "controls", "other_information",
  "foreign_inspection", "governance", "compensation", "ownership", "relationships", "accountant_fees", "exhibits", "summary",
  "event", "press_release", "note", "back", "other",
] as const;
export type LibraryCanonical = typeof LIBRARY_CANONICALS[number];

/**
 * A fact a passage shows: in a paragraph by character range, in a table by cell. `at` is the fact element's
 * offset in the archived HTML; the archive inventory's id for it is `${accession}:${encodeURIComponent(url)}:${at}`.
 */
export type LibraryFactRef = { at: number; concept: string; start?: number; end?: number; row?: number; col?: number };
export type LibraryTableCell = { text: string; value: number | null };
export type LibraryTableRow = { label: string; path: string[]; cells: LibraryTableCell[] };
export type LibraryTable = { unit: string | null; columns: string[]; rows: LibraryTableRow[]; notes: string[]; xbrlBlock: string | null };

export type LibrarySection = {
  sectionId: string; parentId: string | null; ordinal: number; depth: number; isLeaf: boolean;
  canonical: LibraryCanonical; itemKey: string | null; title: string; path: string[]; xbrlBlock: string | null;
  role: LibraryRole; chars: number; textHash: string;
};
export type LibraryPassage = {
  passageId: string; sectionId: string; ordinal: number; kind: "paragraph" | "table";
  /** Paragraphs verbatim; tables as Markdown with their unit and notes. */
  text: string; table: LibraryTable | null; factRefs: LibraryFactRef[]; chars: number; textHash: string;
};
export type ParsedLibraryDocument = {
  structure: LibraryStructure; sections: LibrarySection[]; passages: LibraryPassage[]; issues: string[];
};

/** What the tool and the admin page read. */
export type LibraryDocumentSummary = {
  documentId: string; ticker: string; accessionNumber: string; form: string; docType: LibraryDocType;
  reportDate: string; filedAt: string; documentUrl: string; parserVersion: string; structure: LibraryStructure;
  structureCheck: { status: "ok" | "segments_missing" | "not_applicable"; missing: string[] };
  status: "ready" | "unreadable"; failureReason: string | null; previousDocumentId: string | null;
  chars: number; passages: number; sections: number; preparedAt: string;
};
export type LibrarySectionView = Omit<LibrarySection, "textHash"> & { change: LibraryChange };
export type LibraryPassageView = Omit<LibraryPassage, "textHash"> & { change: LibraryChange };

/** The admin page: how far the library is, and the documents that need a look. */
export type LibraryOverview = {
  enabled: boolean; parserVersion: string; pending: number;
  totals: { documents: number; ready: number; unreadable: number; sections: number; passages: number; cards: number };
  structures: Array<{ structure: LibraryStructure; docType: LibraryDocType; documents: number }>;
  companies: Array<{ ticker: string; documents: number; unreadable: number; segmentsMissing: number; latestFiledAt: string }>;
  problems: Array<Pick<LibraryDocumentSummary, "documentId" | "ticker" | "form" | "docType" | "filedAt" | "status" | "failureReason" | "structure" | "structureCheck">>;
};
export type LibraryCard = {
  sectionId: string; gist: string | null; entities: string[]; topic: string | null; answers: string[]; metrics: string[];
  notes: string[]; model: string; reasoning: string; status: "ready" | "partial" | "failed"; createdAt: string;
};
export type LibraryDocumentDetail = { document: LibraryDocumentSummary; outline: LibrarySectionView[]; cards: LibraryCard[] };
export type LibrarySectionDetail = { section: LibrarySectionView; passages: LibraryPassageView[]; card: LibraryCard | null };
