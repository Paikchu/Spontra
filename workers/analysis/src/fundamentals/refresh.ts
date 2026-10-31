import { fundamentalsBehind } from "../../../../shared/analysis-runtime/fundamentals-freshness.ts";
import type { PublicBusinessFlow } from "../../../../shared/analysis-contract/business-flow.ts";
import { outboxStatement } from "../pipeline/outbox.ts";
import type { SecHistorySnapshot } from "../sec/analysis.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { normalizeCompanyFacts } from "../sec/history.ts";
import { secFundamentalsKey } from "./sec-fundamentals.ts";

/**
 * Brings the SEC fundamentals up to the statements just published (B9). The statements come from the filing itself the
 * moment it is collected; the fundamentals from Company Facts, which SEC fills hours or a day later. The SEC report run
 * reads Company Facts once on discovery, often too early, and nothing read it again, so a company's fundamentals could
 * stay a quarter behind its page (Alphabet's stopped at 2026-06-30 with 2026-09-30 on the page).
 *
 * Each publication re-reads Company Facts. A snapshot that reaches a later quarter (or a newer series registry) replaces
 * the stored one and announces `fundamentals.updated`; one that does not is left alone so downstream runs are not
 * repeated for nothing. While Company Facts is still behind the published quarter the run asks to be retried, for up to
 * `CATCH_UP_DAYS` after the quarter was filed; an issuer whose Company Facts carries no quarterly statement values at all
 * (a 20-F filer) is not waited for. No model is involved.
 */

const HOUR = 3_600_000, DAY = 24 * HOUR;
export const CATCH_UP_DAYS = 14;
const RETRY_MS = 6 * HOUR;
/** Series whose quarterly values say which quarter Company Facts has reached: the statements' flows, not balances. */
const FLOW_SERIES = new Set(["revenue", "gross_profit", "operating_income", "net_income", "operating_cash_flow"]);

type Env = { DB: D1Database; SEC_USER_AGENT: string };
export type FundamentalsRefresh = {
  status: "updated" | "unchanged" | "behind" | "no-publication" | "no-facts";
  /** The latest quarter of the published statements. */
  published: string | null;
  /** The latest quarter Company Facts reports a statement value for, before and after this run. */
  stored: string | null;
  facts: string | null;
  /** When behind: retry after this many milliseconds, or null when the wait is over (or pointless). */
  retryAfterMs?: number | null;
};

/** The latest quarter a snapshot's statement flows reach. */
export function snapshotQuarter(history: SecHistorySnapshot | null): string | null {
  let latest: string | null = null;
  for (const series of history?.series ?? []) if (FLOW_SERIES.has(series.seriesId)) for (const q of series.quarters) if (q.startDate && (!latest || q.endDate > latest)) latest = q.endDate;
  return latest;
}

async function publishedQuarter(db: D1Database, ticker: string): Promise<{ cik: string; periodEnd: string; filedAt: string | null } | null> {
  const row = await db.prepare(`SELECT v.cik cik, v.payload_json payload FROM financial_complete_current c JOIN financial_complete_versions v ON v.version_id = c.version_id WHERE v.ticker = ?`)
    .bind(ticker).first<{ cik: string; payload: string }>();
  if (!row) return null;
  let flow: PublicBusinessFlow;
  try { flow = JSON.parse(row.payload) as PublicBusinessFlow; } catch { return null; }
  const latest = [...flow.quarters ?? []].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  return latest ? { cik: row.cik, periodEnd: latest.periodEnd, filedAt: latest.reportedAt?.slice(0, 10) ?? null } : null;
}

export async function refreshSecFundamentals(env: Env, ticker: string, fetcher: typeof fetch, now: Date, causeId: string | null = null): Promise<FundamentalsRefresh> {
  const db = env.DB, repository = new D1SecRepository(db);
  const published = await publishedQuarter(db, ticker);
  if (!published) return { status: "no-publication", published: null, stored: null, facts: null };
  const stored = (await repository.getCache<SecHistorySnapshot>(secFundamentalsKey(ticker)))?.payload ?? null;
  const response = await fetcher(`https://data.sec.gov/api/xbrl/companyfacts/CIK${published.cik.replace(/\D/g, "").padStart(10, "0")}.json`, {
    cache: "no-store", headers: { accept: "application/json", "user-agent": env.SEC_USER_AGENT }, signal: AbortSignal.timeout(30_000),
  });
  const base = { published: published.periodEnd, stored: snapshotQuarter(stored) };
  if (!response.ok) return { ...base, status: "no-facts", facts: null };
  const history = normalizeCompanyFacts(ticker, await response.json());
  const facts = snapshotQuarter(history);
  // Newer when it reaches a later quarter, or is read by a newer registry; never replaced by an older read.
  const newer = !!facts && (!base.stored || facts > base.stored || (facts === base.stored && stored?.registryVersion !== history.registryVersion));
  if (newer) {
    const at = now.toISOString();
    await db.batch([
      db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
        .bind(secFundamentalsKey(ticker), JSON.stringify(history), at),
      outboxStatement(db, { type: "fundamentals.updated", ticker, cik: published.cik, causeId }, at),
    ]);
  }
  if (!fundamentalsBehind(facts, published.periodEnd)) return { ...base, status: newer ? "updated" : "unchanged", facts };
  // Company Facts has not caught up with the filing yet: try again, within reason.
  const quarterly = facts != null;
  const filed = published.filedAt ? Date.parse(published.filedAt) : now.getTime();
  const waiting = quarterly && now.getTime() - filed < CATCH_UP_DAYS * DAY;
  return { ...base, status: "behind", facts, retryAfterMs: waiting ? RETRY_MS : null };
}
