import { z } from "zod";
import type { CompanyEvent, InsiderLine, InsiderTransaction, InsiderTransactionCode } from "../analysis-contract/events.ts";
import type { InsiderPersonSummary, InsiderRole, InsiderTotals, InsiderTradeSide, InsiderTransactionRow, InsiderTransactionsPage, InsidersPublication } from "../analysis-contract/insiders.ts";
import { TICKER_PATTERN } from "./financial-data/policy.ts";
import { omit } from "./omit.ts";

/**
 * Insider trades grouped by person. The same rules build the ledger's person rows at ingestion, the API's answer when
 * the ledger is still empty (from the stored event rail), and the page's own fallback; the three never disagree.
 */

/** A line filed and first recorded within this many days is new to the reader. */
export const INSIDER_NEW_DAYS = 14;
export const INSIDER_HISTORY_PAGE = 20;
export const INSIDER_HISTORY_PAGE_MAX = 100;

const DAY_MS = 86_400_000;

/** The key as the history route accepts it: an owner CIK, or `name:` and the normalized name. */
export const PERSON_KEY = /^(?:\d{1,10}|name:[a-z0-9 ]{1,120})$/;

/** A person's key within the company: the SEC reporting owner CIK, else the normalized name. */
export function insiderPersonKey(insider: Pick<InsiderTransaction, "ownerCik" | "ownerName">): string {
  const cik = (insider.ownerCik ?? "").trim().replace(/^0+(?=\d)/, "");
  if (/^\d+$/.test(cik)) return cik;
  return `name:${insider.ownerName.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
}

export const insiderOwnerCik = (insider: Pick<InsiderTransaction, "ownerCik">): string | null => {
  const cik = (insider.ownerCik ?? "").trim().replace(/^0+(?=\d)/, "");
  return /^\d+$/.test(cik) ? cik : null;
};

export function tradeSide(code: InsiderTransactionCode, acquiredDisposed: "A" | "D", derivative: boolean): InsiderTradeSide {
  if (derivative) return "other";
  if (code === "S" && acquiredDisposed === "D") return "sell";
  if (code === "P" && acquiredDisposed === "A") return "buy";
  return "other";
}

export const lineValue = (line: Pick<InsiderLine, "shares" | "price">): number | null => line.price == null ? null : line.shares * line.price;

export const isoDay = (iso: string) => iso.slice(0, 10);
export const daysBefore = (iso: string, days: number) => new Date(Date.parse(iso) - days * DAY_MS).toISOString();

/** When the line became new to readers: its first record, provided the filing itself was recent then; null for history read in bulk. */
export function newAt(row: Pick<InsiderTransactionRow, "filedAt" | "firstSeenAt">, days = INSIDER_NEW_DAYS): string | null {
  return row.filedAt >= isoDay(daysBefore(row.firstSeenAt, days)) ? row.firstSeenAt : null;
}

export function isNewRow(row: Pick<InsiderTransactionRow, "filedAt" | "firstSeenAt">, now: Date, days = INSIDER_NEW_DAYS): boolean {
  const at = newAt(row, days);
  return at != null && at >= daysBefore(now.toISOString(), days);
}

/** A ledger row: the transaction with who filed it, as both the tables and the event rail hold it. */
export type InsiderLedgerRow = InsiderTransactionRow & { personKey: string; ownerCik: string | null; name: string; role: InsiderRole };

/** Newest first: transaction date, then filing date, then accession, then line. The history cursor follows the same order. */
export function compareRows(a: Pick<InsiderTransactionRow, "date" | "filedAt" | "accession" | "line">, b: Pick<InsiderTransactionRow, "date" | "filedAt" | "accession" | "line">): number {
  return b.date.localeCompare(a.date) || b.filedAt.localeCompare(a.filedAt) || b.accession.localeCompare(a.accession) || b.line - a.line;
}

const planned = (t: InsiderTransaction) => t.rule10b51 === true || t.footnotes.some(f => /\b10b5-?1\b/i.test(f));

/** The ledger rows of one filing, numbered in the order the parser lists its lines. */
export function filingRows(event: Pick<CompanyEvent, "id" | "form" | "filedAt" | "documentUrl" | "edgarUrl">, t: InsiderTransaction, firstSeenAt: string, now: Date): InsiderLedgerRow[] {
  const form: "4" | "4/A" = event.form === "4/A" ? "4/A" : "4";
  const role: InsiderRole = { title: t.title, isDirector: t.isDirector, isOfficer: t.isOfficer, isTenPercentOwner: t.isTenPercentOwner };
  const plan = planned(t);
  return t.lines.map((line, index): InsiderLedgerRow => {
    const row = {
      id: `${event.id}:${index}`, accession: event.id, line: index, form, date: line.date, filedAt: event.filedAt, code: line.code,
      side: tradeSide(line.code, line.acquiredDisposed, line.derivative), acquiredDisposed: line.acquiredDisposed, shares: line.shares, price: line.price,
      value: lineValue(line), ownedAfter: line.ownedAfter, ownership: line.ownership, derivative: line.derivative, securityTitle: t.securityTitle, planned: plan,
      filingUrl: event.documentUrl, indexUrl: event.edgarUrl, firstSeenAt, isNew: false,
      personKey: insiderPersonKey(t), ownerCik: insiderOwnerCik(t), name: t.ownerName.replace(/\s+/g, " ").trim(), role,
    };
    return { ...row, isNew: isNewRow(row, now) };
  });
}

/** Every line of the rail's Form 4s as ledger rows; a row read from the rail is history, never new. */
export function rowsFromEvents(events: readonly CompanyEvent[], now: Date): InsiderLedgerRow[] {
  return events.flatMap(e => e.insider ? filingRows(e, e.insider, e.filedAt, now) : []).sort(compareRows);
}

const totals = (rows: InsiderLedgerRow[]): InsiderTotals => {
  const pricedCount = rows.filter(r => r.value != null).length;
  const unpricedCount = rows.length - pricedCount;
  const pricedValue = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  return { shares: rows.reduce((s, r) => s + r.shares, 0), value: unpricedCount > 0 ? null : pricedValue, count: rows.length, pricedValue, pricedCount, unpricedCount };
};

/** One person's summary from their rows, in any order. */
export function summarizePerson(rows: InsiderLedgerRow[], now: Date): InsiderPersonSummary | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort(compareRows);
  // The role and name as the latest filing reports them: a director who became an officer reads as the officer.
  const latestFiling = [...sorted].sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.accession.localeCompare(a.accession))[0]!;
  const latest = sorted[0]!;
  const sold = totals(sorted.filter(r => r.side === "sell")), bought = totals(sorted.filter(r => r.side === "buy"));
  const held = sorted.find(r => !r.derivative && r.ownership === "D" && r.ownedAfter != null) ?? sorted.find(r => !r.derivative && r.ownedAfter != null);
  const newAts = sorted.map(r => newAt(r)).filter((d): d is string => d != null);
  const stamped = sorted.map(r => ({ ...r, isNew: isNewRow(r, now) }));
  return {
    key: latest.personKey, ownerCik: latest.ownerCik, name: latestFiling.name, role: latestFiling.role,
    firstTradeAt: sorted[sorted.length - 1]!.date, lastTradeAt: latest.date,
    latest: stamped[0]!, lastNewTradeAt: newAts.length ? newAts.reduce((a, b) => a > b ? a : b) : null, newCount: stamped.filter(r => r.isNew).length,
    sold, bought, net: { shares: bought.shares - sold.shares, value: bought.value == null || sold.value == null ? null : bought.value - sold.value, complete: bought.value != null && sold.value != null },
    transactions: sorted.length, filings: new Set(sorted.map(r => r.accession)).size,
    heldAfter: held?.ownedAfter ?? null, planned: sorted.some(r => r.planned),
  };
}

/** Everyone, latest trade first; a person with no lines at all (a filing with nothing parsable) is nobody. */
export function summarizePersons(rows: InsiderLedgerRow[], now: Date): InsiderPersonSummary[] {
  const byKey = new Map<string, InsiderLedgerRow[]>();
  for (const row of rows) byKey.set(row.personKey, [...(byKey.get(row.personKey) ?? []), row]);
  return [...byKey.values()].map(group => summarizePerson(group, now)!)
    .sort((a, b) => (b.lastTradeAt ?? "").localeCompare(a.lastTradeAt ?? "") || (b.latest?.filedAt ?? "").localeCompare(a.latest?.filedAt ?? "") || a.name.localeCompare(b.name));
}

/** The rail's Form 4s grouped by person: the fallback until the ledger is filled, and the page's own when the API is away. */
export const personsFromEvents = (events: readonly CompanyEvent[], now: Date) => summarizePersons(rowsFromEvents(events, now), now);

/* ---------- The history cursor ---------- */

const CURSOR = /^(\d{4}-\d{2}-\d{2})\|(\d{4}-\d{2}-\d{2})\|([^|]{1,40})\|(\d{1,4})$/;
export type HistoryCursor = { date: string; filedAt: string; accession: string; line: number };

export const encodeCursor = (row: Pick<InsiderTransactionRow, "date" | "filedAt" | "accession" | "line">) => `${row.date}|${row.filedAt}|${row.accession}|${row.line}`;
export function decodeCursor(cursor: string | null | undefined): HistoryCursor | null | undefined {
  if (cursor == null || cursor === "") return null;
  const m = CURSOR.exec(cursor);
  return m ? { date: m[1]!, filedAt: m[2]!, accession: m[3]!, line: Number(m[4]) } : undefined;
}

export const historyLimit = (raw: string | number | null | undefined) => {
  const n = Math.floor(Number(raw ?? INSIDER_HISTORY_PAGE));
  return Number.isFinite(n) && n > 0 ? Math.min(n, INSIDER_HISTORY_PAGE_MAX) : INSIDER_HISTORY_PAGE;
};

/** One page of rows after the cursor, in list order; the cursor is the last row served. */
export function pageRows<T extends InsiderTransactionRow>(rows: readonly T[], cursor: HistoryCursor | null, limit: number): { items: T[]; nextCursor: string | null } {
  const sorted = [...rows].sort(compareRows);
  const from = cursor ? sorted.filter(r => compareRows(r, cursor) > 0) : sorted;
  const items = from.slice(0, limit);
  return { items, nextCursor: from.length > limit ? encodeCursor(items[items.length - 1]!) : null };
}

/** A person's history from the rail, paged like the ledger's. */
export function historyFromEvents(events: readonly CompanyEvent[], ticker: string, personKey: string, cursor: HistoryCursor | null, limit: number, now: Date): InsiderTransactionsPage {
  const rows = rowsFromEvents(events, now).filter(r => r.personKey === personKey);
  const page = pageRows(rows, cursor, limit);
  return { schemaVersion: "insider-transactions.v1", ticker, personKey, source: "events", items: page.items.map(row => omit(row, "personKey", "ownerCik", "name", "role")), nextCursor: page.nextCursor };
}

/* ---------- Validation: the site re-reads what the analysis backend serves ---------- */

const text = (max: number) => z.string().max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const https = z.string().url().max(500).refine(u => u.startsWith("https://"), "https only");
const finite = z.number().finite();
const CODE = z.enum(["S", "P", "M", "F", "A", "G", "D", "C", "J", "X", "W", "I", "Z", "L", "U", "O", "E", "H", "K"]);

const row = z.object({
  id: text(60), accession: text(40), line: z.number().int().nonnegative(), form: z.enum(["4", "4/A"]), date, filedAt: date, code: CODE,
  side: z.enum(["buy", "sell", "other"]), acquiredDisposed: z.enum(["A", "D"]), shares: finite.nonnegative(), price: finite.nonnegative().nullable(), value: finite.nonnegative().nullable(),
  ownedAfter: finite.nullable(), ownership: z.enum(["D", "I"]), derivative: z.boolean(), securityTitle: text(120), planned: z.boolean(),
  filingUrl: https, indexUrl: https, firstSeenAt: text(40), isNew: z.boolean(),
});
const totalsSchema = z.object({
  shares: finite.nonnegative(), value: finite.nonnegative().nullable(), count: z.number().int().nonnegative(),
  pricedValue: finite.nonnegative().optional(), pricedCount: z.number().int().nonnegative().optional(), unpricedCount: z.number().int().nonnegative().optional(),
}).transform(t => ({
  ...t, pricedValue: t.pricedValue ?? t.value ?? 0,
  pricedCount: t.pricedCount ?? (t.value == null ? 0 : t.count), unpricedCount: t.unpricedCount ?? (t.value == null ? t.count : 0),
}));
const netSchema = z.object({ shares: finite, value: finite.nullable(), complete: z.boolean().optional() })
  .transform(n => ({ ...n, complete: n.complete ?? n.value != null }));
const person = z.object({
  key: z.string().regex(PERSON_KEY), ownerCik: z.string().regex(/^\d{1,10}$/).nullable(), name: text(160),
  role: z.object({ title: text(120).nullable(), isDirector: z.boolean(), isOfficer: z.boolean(), isTenPercentOwner: z.boolean() }),
  firstTradeAt: date.nullable(), lastTradeAt: date.nullable(), latest: row.nullable(), lastNewTradeAt: text(40).nullable(), newCount: z.number().int().nonnegative(),
  sold: totalsSchema, bought: totalsSchema, net: netSchema, transactions: z.number().int().nonnegative(), filings: z.number().int().nonnegative(),
  heldAfter: finite.nullable(), planned: z.boolean(),
});
export const insidersPublicationSchema = z.object({
  schemaVersion: z.literal("insiders.v1"), ticker: z.string().regex(TICKER_PATTERN), source: z.enum(["ledger", "events"]), newDays: z.number().int().positive(),
  asOf: text(40), persons: z.array(person).max(500),
});
export const insiderTransactionsPageSchema = z.object({
  schemaVersion: z.literal("insider-transactions.v1"), ticker: z.string().regex(TICKER_PATTERN), personKey: z.string().regex(PERSON_KEY), source: z.enum(["ledger", "events"]),
  items: z.array(row).max(INSIDER_HISTORY_PAGE_MAX), nextCursor: z.string().max(120).nullable(),
});

/** A served publication for one ticker, unknown fields stripped; another ticker's or an invalid one reads as none. */
export function readInsidersPublication(value: unknown, ticker: string): InsidersPublication | null {
  const parsed = insidersPublicationSchema.safeParse(value);
  return parsed.success && parsed.data.ticker === ticker ? parsed.data : null;
}

export function readInsiderTransactionsPage(value: unknown, ticker: string, personKey: string): InsiderTransactionsPage | null {
  const parsed = insiderTransactionsPageSchema.safeParse(value);
  return parsed.success && parsed.data.ticker === ticker && parsed.data.personKey === personKey ? parsed.data : null;
}
