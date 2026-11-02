/**
 * Insider trading by person: every Form 4 transaction line the company's issuer filings report, kept per reporting
 * owner. A person is the SEC reporting owner CIK, keyed within the company; a filing that names no owner CIK is keyed
 * by its normalized name. Figures are the filings' own; nothing here is written by a model.
 */
import type { InsiderTransactionCode } from "./events.ts";

/** What a line did in the market: an open-market sale (code S, disposed), an open-market purchase (code P, acquired), or anything else. */
export type InsiderTradeSide = "buy" | "sell" | "other";

export type InsiderRole = {
  /** Officer title as reported on the latest filing, or null. */
  title: string | null;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
};

/** One transaction line of one filing, as the person's history lists it. */
export type InsiderTransactionRow = {
  /** `<accession>:<line>`; the line index within the filing, stable per parse. */
  id: string;
  accession: string;
  line: number;
  form: "4" | "4/A";
  /** The transaction date the line reports. */
  date: string;
  filedAt: string;
  code: InsiderTransactionCode;
  side: InsiderTradeSide;
  acquiredDisposed: "A" | "D";
  shares: number;
  price: number | null;
  /** Shares × price when a price was reported; null otherwise (grants, gifts, exercises at zero). */
  value: number | null;
  ownedAfter: number | null;
  ownership: "D" | "I";
  derivative: boolean;
  securityTitle: string;
  /** The filing marks the trade as made under a 10b5-1 plan. */
  planned: boolean;
  /** The filing's primary document and its EDGAR index. */
  filingUrl: string;
  indexUrl: string;
  /** When the ledger first recorded the line. */
  firstSeenAt: string;
  /** Filed and first recorded within the last `newDays`: the reader has not seen it before. */
  isNew: boolean;
};

export type InsiderTotals = { shares: number; value: number; count: number };

export type InsiderPersonSummary = {
  /** The owner CIK, or `name:<normalized name>` when the filing gives none. */
  key: string;
  ownerCik: string | null;
  name: string;
  role: InsiderRole;
  firstTradeAt: string | null;
  lastTradeAt: string | null;
  /** The person's most recent line: the row the list shows. */
  latest: InsiderTransactionRow | null;
  /** When a line of this person was last recorded as new; null when none ever was. */
  lastNewTradeAt: string | null;
  /** Lines still new on the read. */
  newCount: number;
  /** Open-market sales and purchases, summed over every filing of this issuer. */
  sold: InsiderTotals;
  bought: InsiderTotals;
  /** bought − sold: negative is net sold. */
  net: { shares: number; value: number };
  transactions: number;
  filings: number;
  /** Shares held directly after the latest non-derivative line that reports it. */
  heldAfter: number | null;
  /** Any filing of this person marked a 10b5-1 plan. */
  planned: boolean;
};

export type InsidersPublication = {
  schemaVersion: "insiders.v1";
  ticker: string;
  /** `ledger`: the per-line tables; `events`: grouped on the read from the stored event rail until the ledger is filled. */
  source: "ledger" | "events";
  /** The window a line counts as new in, in days. */
  newDays: number;
  asOf: string;
  /** Latest trade first. */
  persons: InsiderPersonSummary[];
};

export type InsidersResponse = {
  schemaVersion: "insiders-response.v1";
  status: "ready" | "preparing";
  insiders: InsidersPublication | null;
};

/** One page of a person's history, newest first; `nextCursor` reads the next page. */
export type InsiderTransactionsPage = {
  schemaVersion: "insider-transactions.v1";
  ticker: string;
  personKey: string;
  source: "ledger" | "events";
  items: InsiderTransactionRow[];
  nextCursor: string | null;
};

export type InsiderTransactionsResponse = {
  schemaVersion: "insider-transactions-response.v1";
  status: "ready" | "preparing";
  transactions: InsiderTransactionsPage | null;
};
