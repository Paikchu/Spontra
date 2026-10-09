/**
 * What a company filed between its reports: 8-K/6-K current reports and Form 4 insider
 * transactions, as EDGAR lists them. An event is a deterministic record — its class comes from the
 * 8-K item codes or the form, its figures from the Form 4 XML — and the only model-written part is
 * the summary already produced for the filing. Every event keeps its EDGAR links.
 */

/** What kind of event the filing discloses, decided by item codes (8-K) or the form (Form 4), never by a model. */
export type EventClass =
  | "earnings" | "guidance" | "executive" | "insider" | "deal" | "financing" | "capital_return" | "vote" | "legal" | "other";

export type EventForm = "8-K" | "8-K/A" | "6-K" | "6-K/A" | "4" | "4/A";

/** Form 4 transaction codes the ladder draws. Everything else (grants, gifts, withholding) is kept but not a signal. */
export type InsiderTransactionCode = "S" | "P" | "M" | "F" | "A" | "G" | "D" | "C" | "J" | "X" | "W" | "I" | "Z" | "L" | "U" | "O" | "E" | "H" | "K";

export type InsiderLine = {
  date: string;
  code: InsiderTransactionCode;
  /** Shares acquired (A) or disposed (D). */
  acquiredDisposed: "A" | "D";
  shares: number;
  /** Per-share price as reported; null for grants, gifts and option exercises reported at zero. */
  price: number | null;
  /** Shares of this class the owner held after the line, as reported on the line. */
  ownedAfter: number | null;
  /** Direct (D) or indirect (I) ownership. */
  ownership: "D" | "I";
  /** Rows from the derivative table (options, RSUs): kept for context, never counted as open-market trades. */
  derivative: boolean;
};

export type InsiderTransaction = {
  /** The reporting owner's CIK, stable across filings. */
  ownerCik: string;
  ownerName: string;
  /** Officer title as reported, or null for a director or ten-percent owner. */
  title: string | null;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
  /** The Form 4 "Rule 10b5-1 trading plan" box, present on filings since 2023. Null when the form predates the box. */
  rule10b51: boolean | null;
  /** When the plan was adopted, if the filing says so. */
  planAdoptedOn: string | null;
  securityTitle: string;
  lines: InsiderLine[];
  /** Open-market sales (code S) in this filing: shares, proceeds and weighted price; null when there were none. */
  sold: { shares: number; proceeds: number; averagePrice: number } | null;
  /** Open-market purchases (code P) in this filing. */
  bought: { shares: number; cost: number; averagePrice: number } | null;
  /** Shares exercised or converted (code M) in this filing. */
  exercised: number;
  /** Shares held directly after the last non-derivative line; null when the filing reports none. */
  heldAfter: number | null;
  /** Footnotes as filed, trimmed. */
  footnotes: string[];
};

export type EventExhibit = { type: string; title: string; url: string };

export type EventSummary = {
  headline: string;
  bullets: Array<{ label: string; detail: string; importance: "high" | "medium" | "low" }>;
  analystView: string;
  /** The model's reading of the event, secondary to `class`. */
  eventCategory: "earnings_update" | "guidance" | "m&a" | "executive" | "legal" | "other" | null;
  generatedAt: string;
};

export type CompanyEvent = {
  /** The accession number. */
  id: string;
  ticker: string;
  form: EventForm;
  filedAt: string;
  /** The event date EDGAR lists (period of report), or the filing date when none is listed. */
  eventDate: string;
  /** 8-K item codes as EDGAR lists them, e.g. ["2.02", "9.01"]; empty for Form 4. */
  items: string[];
  class: EventClass;
  /** What the filing is about, as the primary document describes it; empty when EDGAR gives none. */
  description: string;
  edgarUrl: string;
  documentUrl: string;
  exhibits: EventExhibit[];
  /** The event summary the pipeline already wrote for this filing, if it has one. */
  summary: EventSummary | null;
  /** Form 4 only. */
  insider: InsiderTransaction | null;
};

export type EventsPublication = {
  schemaVersion: "events.v1";
  ticker: string;
  /** When EDGAR's submission list was last read. */
  checkedAt: string;
  /** Newest first. */
  events: CompanyEvent[];
  /** Form 4 accessions listed by EDGAR whose XML has not been read yet; the page says so instead of showing a gap. */
  pendingInsider: number;
};

export type EventsResponse = {
  schemaVersion: "events-response.v1";
  status: "ready" | "preparing";
  events: EventsPublication | null;
};
