import type { CompanyEvent, InsiderTransaction, InsiderTransactionCode } from "../../../../shared/analysis-contract/events.ts";
import type { InsiderPersonSummary, InsiderTotals, InsiderTransactionRow, InsiderTransactionsPage, InsiderTransactionsResponse, InsidersPublication, InsidersResponse } from "../../../../shared/analysis-contract/insiders.ts";
import { compareRows, decodeCursor, encodeCursor, filingRows, historyFromEvents, historyLimit, INSIDER_NEW_DAYS, isNewRow, PERSON_KEY, personsFromEvents, summarizePerson, type InsiderLedgerRow } from "../../../../shared/analysis-runtime/insiders.ts";
import { TICKER_PATTERN } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import { omit } from "../../../../shared/analysis-runtime/omit.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { normalizeCik } from "./form4.ts";
import { readEventsResponse } from "./read.ts";

/**
 * The insider ledger: `insider_transactions` holds one row per Form 4 line, keyed by filing and line, so recording a
 * filing twice rewrites the same rows and keeps their first-seen time; `insider_persons` holds each reporting owner's
 * aggregates, recomputed from the rows whenever one of theirs is written. Only the company's own filings enter (B1):
 * a filing whose issuer is another company is skipped, and one read before the issuer was parsed is kept, as the rail keeps it.
 */

export type InsiderFilingInput = {
  ticker: string;
  /** The company's CIK, padded or not. */
  companyCik: string | number;
  event: Pick<CompanyEvent, "id" | "form" | "filedAt" | "documentUrl" | "edgarUrl">;
  transaction: InsiderTransaction;
  /** When the ledger first saw the filing: now for one just read, its filing date for history filled in bulk. */
  seenAt: string;
};

export type TransactionRow = {
  ticker: string; issuer_cik: string; accession: string; line_no: number; form: string; owner_key: string; owner_cik: string | null; owner_name: string;
  transaction_date: string; filed_at: string; code: string; acquired_disposed: string; side: string; shares: number; price: number | null; value: number | null;
  owned_after: number | null; ownership: string; derivative: number; security_title: string; planned: number; title: string | null;
  is_director: number; is_officer: number; is_ten_percent_owner: number; filing_url: string; index_url: string; first_seen_at: string; ingested_at: string;
};
type StoredRow = Omit<TransactionRow, "ticker" | "issuer_cik" | "ingested_at">;

export type PersonRow = {
  ticker: string; owner_key: string; issuer_cik: string; owner_cik: string | null; name: string; title: string | null; is_director: number; is_officer: number; is_ten_percent_owner: number;
  first_trade_at: string | null; last_trade_at: string | null; last_new_trade_at: string | null; latest_json: string | null;
  sold_shares: number; sold_value: number; sell_count: number; bought_shares: number; bought_value: number; buy_count: number; net_shares: number; net_value: number;
  transaction_count: number; filing_count: number; held_after: number | null; planned: number; updated_at: string;
};

export const TRANSACTION_COLUMNS = ["ticker", "issuer_cik", "accession", "line_no", "form", "owner_key", "owner_cik", "owner_name", "transaction_date", "filed_at", "code", "acquired_disposed", "side",
  "shares", "price", "value", "owned_after", "ownership", "derivative", "security_title", "planned", "title", "is_director", "is_officer", "is_ten_percent_owner", "filing_url", "index_url", "first_seen_at", "ingested_at"] as const;
/** Everything but the key and the first-seen time is rewritten on a re-read. */
export const TRANSACTION_UPSERT = `INSERT INTO insider_transactions (${TRANSACTION_COLUMNS.join(", ")}) VALUES (${TRANSACTION_COLUMNS.map(() => "?").join(", ")})
  ON CONFLICT(ticker, accession, line_no) DO UPDATE SET ${TRANSACTION_COLUMNS.filter(c => !["ticker", "accession", "line_no", "first_seen_at"].includes(c)).map(c => `${c} = excluded.${c}`).join(", ")}`;

export const PERSON_COLUMNS = ["ticker", "owner_key", "issuer_cik", "owner_cik", "name", "title", "is_director", "is_officer", "is_ten_percent_owner", "first_trade_at", "last_trade_at", "last_new_trade_at", "latest_json",
  "sold_shares", "sold_value", "sell_count", "bought_shares", "bought_value", "buy_count", "net_shares", "net_value", "transaction_count", "filing_count", "held_after", "planned", "updated_at"] as const;
export const PERSON_UPSERT = `INSERT INTO insider_persons (${PERSON_COLUMNS.join(", ")}) VALUES (${PERSON_COLUMNS.map(() => "?").join(", ")})
  ON CONFLICT(ticker, owner_key) DO UPDATE SET ${PERSON_COLUMNS.filter(c => c !== "ticker" && c !== "owner_key").map(c => `${c} = excluded.${c}`).join(", ")}`;

const ROW_SELECT = `SELECT accession, line_no, form, owner_key, owner_cik, owner_name, transaction_date, filed_at, code, acquired_disposed, side, shares, price, value, owned_after, ownership, derivative,
  security_title, planned, title, is_director, is_officer, is_ten_percent_owner, filing_url, index_url, first_seen_at FROM insider_transactions`;

/** D1 takes a batch of any length, but one of hundreds of 29-parameter statements is slow to fail; the ledger writes in slices. */
const BATCH = 50;

/** The B1 rule, as the rail applies it: the company's own filings and those read before the issuer was parsed. */
const ownFiling = (t: InsiderTransaction, companyCik: string) => !t.issuerCik || normalizeCik(t.issuerCik) === companyCik;

/** A filing's rows as the table holds them; empty for another issuer's filing or one with nothing parsable. */
export function transactionRows(filing: InsiderFilingInput, stamp: string, now: Date): TransactionRow[] {
  const issuer = normalizeCik(filing.companyCik);
  if (!issuer || !ownFiling(filing.transaction, issuer)) return [];
  return filingRows(filing.event, filing.transaction, filing.seenAt, now).map(row => ({
    ticker: filing.ticker, issuer_cik: issuer, accession: row.accession, line_no: row.line, form: row.form, owner_key: row.personKey, owner_cik: row.ownerCik, owner_name: row.name,
    transaction_date: row.date, filed_at: row.filedAt, code: row.code, acquired_disposed: row.acquiredDisposed, side: row.side, shares: row.shares, price: row.price, value: row.value,
    owned_after: row.ownedAfter, ownership: row.ownership, derivative: row.derivative ? 1 : 0, security_title: row.securityTitle, planned: row.planned ? 1 : 0, title: row.role.title,
    is_director: row.role.isDirector ? 1 : 0, is_officer: row.role.isOfficer ? 1 : 0, is_ten_percent_owner: row.role.isTenPercentOwner ? 1 : 0, filing_url: row.filingUrl, index_url: row.indexUrl,
    first_seen_at: row.firstSeenAt, ingested_at: stamp,
  }));
}

/** A person's row from every line of theirs the ledger holds. */
export function personRow(ticker: string, issuer: string, key: string, summary: InsiderPersonSummary, stamp: string): PersonRow {
  return {
    ticker, owner_key: key, issuer_cik: issuer, owner_cik: summary.ownerCik, name: summary.name, title: summary.role.title, is_director: summary.role.isDirector ? 1 : 0, is_officer: summary.role.isOfficer ? 1 : 0,
    is_ten_percent_owner: summary.role.isTenPercentOwner ? 1 : 0, first_trade_at: summary.firstTradeAt, last_trade_at: summary.lastTradeAt, last_new_trade_at: summary.lastNewTradeAt,
    // These existing NOT NULL columns store priced subtotals; public values get coverage from the transaction rows on read.
    latest_json: summary.latest ? JSON.stringify(summary.latest) : null, sold_shares: summary.sold.shares, sold_value: summary.sold.pricedValue, sell_count: summary.sold.count,
    bought_shares: summary.bought.shares, bought_value: summary.bought.pricedValue, buy_count: summary.bought.count, net_shares: summary.net.shares, net_value: summary.bought.pricedValue - summary.sold.pricedValue,
    transaction_count: summary.transactions, filing_count: summary.filings, held_after: summary.heldAfter, planned: summary.planned ? 1 : 0, updated_at: stamp,
  };
}

/** A stored line as the runtime groups it, its newness read against the clock. */
export function toLedgerRow(r: StoredRow, now: Date): InsiderLedgerRow {
  const row = {
    id: `${r.accession}:${r.line_no}`, accession: r.accession, line: r.line_no, form: r.form === "4/A" ? "4/A" as const : "4" as const, date: r.transaction_date, filedAt: r.filed_at,
    code: r.code as InsiderTransactionCode, side: r.side as InsiderTransactionRow["side"], acquiredDisposed: r.acquired_disposed as "A" | "D", shares: r.shares, price: r.price, value: r.value,
    ownedAfter: r.owned_after, ownership: r.ownership as "D" | "I", derivative: r.derivative === 1, securityTitle: r.security_title, planned: r.planned === 1,
    filingUrl: r.filing_url, indexUrl: r.index_url, firstSeenAt: r.first_seen_at, isNew: false,
    personKey: r.owner_key, ownerCik: r.owner_cik, name: r.owner_name, role: { title: r.title, isDirector: r.is_director === 1, isOfficer: r.is_officer === 1, isTenPercentOwner: r.is_ten_percent_owner === 1 },
  };
  return { ...row, isNew: isNewRow(row, now) };
}

const stripPerson = (row: InsiderLedgerRow): InsiderTransactionRow => omit(row, "personKey", "ownerCik", "name", "role");

/** The accessions the ledger already holds for the company, so a refresh records only what is missing. */
export async function recordedAccessions(db: D1Database, ticker: string): Promise<Set<string>> {
  const rows = await db.prepare("SELECT DISTINCT accession FROM insider_transactions WHERE ticker = ?").bind(ticker).all<{ accession: string }>();
  return new Set(rows.results.map(r => r.accession));
}

async function batched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH) await db.batch(statements.slice(i, i + BATCH));
}

/**
 * Records filings and recomputes the persons they touch. A filing about another issuer is skipped and counted; a
 * filing with no parsable line writes nothing. Idempotent: the same filing again rewrites the same rows.
 */
export async function recordInsiderFilings(db: D1Database, filings: readonly InsiderFilingInput[], now: Date): Promise<{ recorded: number; skipped: number; persons: number }> {
  const stamp = now.toISOString();
  const statements: D1PreparedStatement[] = [];
  const touched = new Map<string, Map<string, string>>();
  let recorded = 0, skipped = 0;
  for (const filing of filings) {
    const issuer = normalizeCik(filing.companyCik);
    if (!issuer || !ownFiling(filing.transaction, issuer)) { skipped++; continue; }
    const rows = transactionRows(filing, stamp, now);
    if (!rows.length) continue;
    recorded++;
    for (const row of rows) {
      statements.push(db.prepare(TRANSACTION_UPSERT).bind(...TRANSACTION_COLUMNS.map(c => row[c])));
      touched.set(row.ticker, (touched.get(row.ticker) ?? new Map()).set(row.owner_key, row.issuer_cik));
    }
  }
  await batched(db, statements);
  let persons = 0;
  for (const [ticker, keys] of touched) {
    const updates: D1PreparedStatement[] = [];
    for (const [key, issuer] of keys) {
      const rows = await db.prepare(`${ROW_SELECT} WHERE ticker = ? AND owner_key = ?`).bind(ticker, key).all<StoredRow>();
      const summary = summarizePerson(rows.results.map(r => toLedgerRow(r, now)), now);
      if (!summary) continue;
      const values = personRow(ticker, issuer, key, summary, stamp);
      updates.push(db.prepare(PERSON_UPSERT).bind(...PERSON_COLUMNS.map(c => values[c])));
      persons++;
    }
    await batched(db, updates);
  }
  return { recorded, skipped, persons };
}

/**
 * The event refresh's call: every Form 4 of the rail the ledger does not hold yet. A filing read in this refresh is new
 * to the ledger now; one the rail already listed is history, first seen when it was filed, so the first fill marks
 * nothing old as new.
 */
export async function recordRailInsiders(db: D1Database, ticker: string, companyCik: string | number, events: readonly CompanyEvent[], previouslyListed: ReadonlySet<string>, now: Date): Promise<void> {
  if (!events.some(event => event.insider)) return;
  const held = await recordedAccessions(db, ticker);
  const filings = events.flatMap((event): InsiderFilingInput[] => event.insider && !held.has(event.id)
    ? [{ ticker, companyCik, event, transaction: event.insider, seenAt: previouslyListed.has(event.id) ? `${event.filedAt}T00:00:00.000Z` : now.toISOString() }] : []);
  if (filings.length) await recordInsiderFilings(db, filings, now);
}

const checkTicker = (raw: string) => {
  const ticker = raw.trim().toUpperCase();
  if (!TICKER_PATTERN.test(ticker)) throw new AnalysisRequestError("INVALID_TICKER", "Invalid company ticker.");
  return ticker;
};

type PriceCoverage = Pick<InsiderTotals, "pricedValue" | "pricedCount" | "unpricedCount">;
type CoverageRow = PriceCoverage & { owner_key: string; side: "sell" | "buy" };

function personFromRow(r: PersonRow, newCount: number, now: Date, coverage: ReadonlyMap<string, PriceCoverage>): InsiderPersonSummary {
  let latest: InsiderTransactionRow | null = null;
  try { latest = r.latest_json ? JSON.parse(r.latest_json) as InsiderTransactionRow : null; } catch { latest = null; }
  if (latest) latest = { ...latest, isNew: isNewRow(latest, now) };
  const totals = (side: "sell" | "buy", shares: number, count: number): InsiderTotals => {
    const c = coverage.get(`${r.owner_key}:${side}`) ?? { pricedValue: 0, pricedCount: 0, unpricedCount: count };
    return { shares, count, value: c.unpricedCount > 0 ? null : c.pricedValue, pricedValue: c.pricedValue, pricedCount: c.pricedCount, unpricedCount: c.unpricedCount };
  };
  const sold = totals("sell", r.sold_shares, r.sell_count), bought = totals("buy", r.bought_shares, r.buy_count);
  return {
    key: r.owner_key, ownerCik: r.owner_cik, name: r.name, role: { title: r.title, isDirector: r.is_director === 1, isOfficer: r.is_officer === 1, isTenPercentOwner: r.is_ten_percent_owner === 1 },
    firstTradeAt: r.first_trade_at, lastTradeAt: r.last_trade_at, latest, lastNewTradeAt: r.last_new_trade_at, newCount,
    sold, bought, net: { shares: r.net_shares, value: bought.value == null || sold.value == null ? null : bought.value - sold.value, complete: bought.value != null && sold.value != null },
    transactions: r.transaction_count, filings: r.filing_count, heldAfter: r.held_after, planned: r.planned === 1,
  };
}

/** Everyone who filed for the company, latest trade first; grouped from the stored rail while the ledger has nothing for it. */
export async function readInsidersResponse(db: D1Database, rawTicker: string, now = new Date()): Promise<InsidersResponse> {
  const ticker = checkTicker(rawTicker);
  const rows = await db.prepare("SELECT * FROM insider_persons WHERE ticker = ? ORDER BY last_trade_at DESC, name ASC").bind(ticker).all<PersonRow>();
  let publication: InsidersPublication | null = null;
  if (rows.results.length) {
    // The new window moves with the clock, so the counts are read live: one indexed read over the lines seen lately.
    const cutoff = new Date(now.getTime() - INSIDER_NEW_DAYS * 86_400_000).toISOString();
    const [recent, coverage] = await Promise.all([
      db.prepare("SELECT owner_key, filed_at, first_seen_at FROM insider_transactions WHERE ticker = ? AND first_seen_at >= ?").bind(ticker, cutoff).all<{ owner_key: string; filed_at: string; first_seen_at: string }>(),
      db.prepare(`SELECT owner_key, side, COALESCE(SUM(value), 0) AS pricedValue, COUNT(value) AS pricedCount, COUNT(*) - COUNT(value) AS unpricedCount
        FROM insider_transactions WHERE ticker = ? AND side IN ('sell', 'buy') GROUP BY owner_key, side`).bind(ticker).all<CoverageRow>(),
    ]);
    const bySide = new Map(coverage.results.map(c => [`${c.owner_key}:${c.side}`, c]));
    const counts = new Map<string, number>();
    for (const r of recent.results) if (isNewRow({ filedAt: r.filed_at, firstSeenAt: r.first_seen_at }, now)) counts.set(r.owner_key, (counts.get(r.owner_key) ?? 0) + 1);
    const persons = rows.results.map(r => personFromRow(r, counts.get(r.owner_key) ?? 0, now, bySide));
    publication = { schemaVersion: "insiders.v1", ticker, source: "ledger", newDays: INSIDER_NEW_DAYS, asOf: now.toISOString(), persons };
  } else {
    const events = (await readEventsResponse(db, ticker)).events;
    if (events) publication = { schemaVersion: "insiders.v1", ticker, source: "events", newDays: INSIDER_NEW_DAYS, asOf: events.checkedAt, persons: personsFromEvents(events.events, now) };
  }
  return { schemaVersion: "insiders-response.v1", status: publication ? "ready" : "preparing", insiders: publication };
}

/** One page of a person's lines, newest first, after the cursor; from the rail while the ledger has nothing for the company. */
export async function readInsiderTransactionsResponse(db: D1Database, rawTicker: string, personKey: string, rawCursor: string | null, rawLimit: string | null, now = new Date()): Promise<InsiderTransactionsResponse> {
  const ticker = checkTicker(rawTicker);
  if (!PERSON_KEY.test(personKey)) throw new AnalysisRequestError("ROUTE_NOT_FOUND", "No such insider.");
  const cursor = decodeCursor(rawCursor);
  if (cursor === undefined) throw new AnalysisRequestError("INVALID_CURSOR", "Invalid cursor.");
  const limit = historyLimit(rawLimit);
  const any = await db.prepare("SELECT 1 AS one FROM insider_transactions WHERE ticker = ? LIMIT 1").bind(ticker).first<{ one: number }>();
  let page: InsiderTransactionsPage | null = null;
  if (any) {
    const after = cursor ? " AND (transaction_date < ?3 OR (transaction_date = ?3 AND (filed_at < ?4 OR (filed_at = ?4 AND (accession < ?5 OR (accession = ?5 AND line_no < ?6))))))" : "";
    const binds = cursor ? [ticker, personKey, cursor.date, cursor.filedAt, cursor.accession, cursor.line] : [ticker, personKey];
    const rows = await db.prepare(`${ROW_SELECT} WHERE ticker = ?1 AND owner_key = ?2${after} ORDER BY transaction_date DESC, filed_at DESC, accession DESC, line_no DESC LIMIT ${limit + 1}`)
      .bind(...binds).all<StoredRow>();
    const items = rows.results.map(r => toLedgerRow(r, now)).sort(compareRows);
    const served = items.slice(0, limit).map(stripPerson);
    page = { schemaVersion: "insider-transactions.v1", ticker, personKey, source: "ledger", items: served, nextCursor: items.length > limit ? encodeCursor(served[served.length - 1]!) : null };
  } else {
    const events = (await readEventsResponse(db, ticker)).events;
    if (events) page = historyFromEvents(events.events, ticker, personKey, cursor, limit, now);
  }
  return { schemaVersion: "insider-transactions-response.v1", status: page ? "ready" : "preparing", transactions: page };
}
