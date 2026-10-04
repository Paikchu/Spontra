import type { DisclosureFact, DisclosureSource, FilingDisclosures } from "../analysis-runtime/financial-data/disclosure-extraction.ts";

/** An inventory of encountered source facts; semantic taxonomy coverage is listed separately. */
export interface DisclosureAuditSummary {
  statements?: { version: string; status: "extracted" | "not_located"; tables: number; rows: number; cells: number };
  documentId: string;
  ticker: string;
  source: DisclosureSource;
  contentSha256: string;
  parserVersion: string;
  archivedAt: string;
  sourceBytes: number;
  factCount: number;
  periodEnds: string[];
  coverage: FilingDisclosures["coverage"];
  issueDetailsTruncated: boolean;
}
export interface DisclosureAuditPage {
  document: DisclosureAuditSummary;
  facts: DisclosureFact[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
}
