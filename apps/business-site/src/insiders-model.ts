import { useEffect, useMemo, useState } from "react";
import type { CompanyEvent, InsiderTransactionCode } from "@/shared/analysis-contract/events";
import type { InsiderPersonSummary, InsiderTransactionRow, InsiderTransactionsPage, InsidersPublication } from "@/shared/analysis-contract/insiders";
import { INSIDER_HISTORY_PAGE, INSIDER_NEW_DAYS, insiderPersonKey, pageRows, personsFromEvents, rowsFromEvents } from "@/shared/analysis-runtime/insiders";
import { labels, messages } from "@/packages/web/src/i18n";
import { fetchInsiderHistory, fetchInsiders } from "./company-data";

/**
 * Insider trades by person on the rail. The people and their history come from Spontra Analysis's ledger, which holds
 * every Form 4 of the company; until it answers (or when it cannot), the rail's own filings are grouped here by the
 * same rules, so the card reads the same either way, only shorter.
 */

const m = messages({
  director: "Director", officer: "Officer", tenPercent: "10% owner",
}, {
  director: "董事", officer: "高管", tenPercent: "10% 股东",
});

/** What a Form 4 transaction code means, as the history lists it. */
export const CODE_LABEL = labels<InsiderTransactionCode>({
  S: "Sale", P: "Purchase", M: "Option exercise", F: "Tax withholding", A: "Grant", G: "Gift", D: "Returned to issuer", C: "Conversion", J: "Other",
  X: "Option exercise", W: "Inheritance", I: "Discretionary", Z: "Trust", L: "Small acquisition", U: "Tender", O: "Option exercise", E: "Expiration", H: "Expiration", K: "Equity swap",
}, {
  S: "卖出", P: "买入", M: "行权", F: "税务代扣", A: "授予", G: "赠与", D: "退回公司", C: "转换", J: "其他",
  X: "行权", W: "继承", I: "自主交易", Z: "信托", L: "小额取得", U: "要约", O: "行权", E: "到期", H: "到期", K: "权益互换",
});

/** The person's role as the latest filing reports it: the officer title, then director and ten-percent owner. */
export function roleLabel(role: InsiderPersonSummary["role"]): string {
  return [role.title, role.isDirector && m.director, role.isTenPercentOwner && m.tenPercent, !role.title && !role.isDirector && !role.isTenPercentOwner && role.isOfficer && m.officer].filter(Boolean).join(" · ");
}

/** The person a rail filing belongs to, by the ledger's own rule, so a focused trade opens the right person. */
export const personKeyOf = (event: CompanyEvent): string | null => event.insider ? insiderPersonKey(event.insider) : null;

/** The rail's filings grouped as the ledger groups them, for the card before the backend answers. */
export function fallbackInsiders(ticker: string, events: readonly CompanyEvent[], now: Date): InsidersPublication {
  return { schemaVersion: "insiders.v1", ticker, source: "events", newDays: INSIDER_NEW_DAYS, asOf: now.toISOString(), persons: personsFromEvents(events, now) };
}

/** The people of the company: the backend's answer once it comes, the rail's own grouping before and without it. */
export function useInsiders(ticker: string, updates: number, fallback: () => InsidersPublication): InsidersPublication {
  const [read, setRead] = useState<{ key: string; publication: InsidersPublication | null } | null>(null);
  const key = `${ticker}:${updates}`;
  useEffect(() => {
    const controller = new AbortController();
    fetchInsiders(ticker, controller.signal)
      .then(publication => { if (!controller.signal.aborted) setRead({ key, publication }); })
      .catch(() => { if (!controller.signal.aborted) setRead({ key, publication: null }); });
    return () => controller.abort();
  }, [ticker, key]);
  return read?.key === key && read.publication ? read.publication : fallback();
}

export type InsiderHistory = { items: InsiderTransactionRow[]; nextCursor: string | null; phase: "idle" | "loading" | "ready" | "error"; more: () => void };
/** What has been read, and whether another page is wanted; a wanted page is loading until it settles. */
type HistoryState = { key: string; items: InsiderTransactionRow[]; nextCursor: string | null; phase: "idle" | "ready" | "error"; pending: boolean };

/**
 * One person's history, read a page at a time once their row is open. From the ledger when the people came from it;
 * paged from the rail's filings when they did not, so the row opens either way. `more` asks for the page after the
 * cursor, or tries again after a failure.
 */
export function useInsiderHistory(ticker: string, personKey: string, open: boolean, source: InsidersPublication["source"], events: readonly CompanyEvent[], now: Date): InsiderHistory {
  const key = `${ticker}:${personKey}:${source}`;
  const [state, setState] = useState<HistoryState>({ key, items: [], nextCursor: null, phase: "idle", pending: false });
  const current: HistoryState = state.key === key ? state : { key, items: [], nextCursor: null, phase: "idle", pending: false };
  // The first page is pending from the moment the row opens; later ones when asked for. Pending holds through the read.
  const pending = source === "ledger" && (current.pending || (open && current.phase === "idle"));
  useEffect(() => {
    if (!pending) return;
    const cursor = current.nextCursor;
    const controller = new AbortController();
    const settle = (page: InsiderTransactionsPage | null) => {
      if (controller.signal.aborted) return;
      setState(page ? { key, items: [...current.items, ...page.items], nextCursor: page.nextCursor, phase: "ready", pending: false } : { ...current, phase: "error", pending: false });
    };
    fetchInsiderHistory(ticker, personKey, cursor, controller.signal).then(settle, () => settle(null));
    return () => controller.abort();
  }, [key, pending]); // eslint-disable-line react-hooks/exhaustive-deps
  // From the rail's own filings the pages are derived, never fetched: one more page each time `more` is asked.
  const [pages, setPages] = useState(1);
  const fallback = useMemo(() => source === "ledger" || !open ? null : pageRows(rowsFromEvents(events, now).filter(r => r.personKey === personKey), null, pages * INSIDER_HISTORY_PAGE), [source, open, events, now, personKey, pages]);
  if (fallback) return { items: fallback.items, nextCursor: fallback.nextCursor, phase: "ready", more: () => setPages(n => n + 1) };
  const more = () => { if (current.phase === "error" || (current.phase === "ready" && current.nextCursor)) setState({ ...current, pending: true }); };
  return { items: current.items, nextCursor: current.nextCursor, phase: pending ? "loading" : current.phase, more };
}
