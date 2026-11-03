import type { ReferenceQuote } from "../../../../shared/analysis-contract/valuation.ts";
import { referenceQuoteSchema } from "../../../../shared/analysis-runtime/valuation/price-guide.ts";
import type { AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { fetchReferenceQuote } from "./market.ts";

const PREFIX = "valuation:quote:";
const REFRESH_MS = 6 * 60 * 60_000;

export async function latestValuationQuote(db: D1Database, ticker: string, frozen: ReferenceQuote | null): Promise<ReferenceQuote | null> {
  const cached = await new D1SecRepository(db).getCache<unknown>(PREFIX + ticker);
  const parsed = referenceQuoteSchema.safeParse(cached?.payload);
  const latest = parsed.success ? parsed.data : null;
  return latest && (!frozen || latest.priceDate > frozen.priceDate) ? latest : frozen;
}

/** Price refresh never alters the research version or starts a model call. Only published, visible ranges are eligible. */
export async function refreshValuationQuotes(env: AnalysisEnv, now = new Date(), fetcher: typeof fetch = fetch): Promise<{ refreshed: number; failed: string[] }> {
  if (!env.DB) return { refreshed: 0, failed: [] };
  const db = env.DB;
  const due = await db.prepare(`SELECT c.ticker, json_extract(v.payload_json, '$.currency') currency
    FROM valuation_current c JOIN valuation_versions v ON v.version_id = c.version_id
    JOIN business_feature_settings s ON s.ticker = c.ticker AND s.feature = 'valuation'
    LEFT JOIN sec_cache q ON q.cache_key = ? || c.ticker
    WHERE coalesce(s.display, s.generate) = 1 AND v.report_status = 'ready'
      AND json_extract(v.payload_json, '$.model.fairValueRange.status') = 'available'
      AND (q.fetched_at IS NULL OR q.fetched_at < ?)
    ORDER BY COALESCE(q.fetched_at, '') LIMIT 8`).bind(PREFIX, new Date(now.getTime() - REFRESH_MS).toISOString()).all<{ ticker: string; currency: string }>();
  const store = new D1SecRepository(db);
  const persist = (ticker: string, quote: unknown) => db.batch([
    db.prepare(`INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`)
      .bind(PREFIX + ticker, JSON.stringify(quote), now.toISOString()),
    db.prepare(`INSERT INTO publication_revisions (ticker, resource, revision) VALUES (?, 'valuation', ?)
      ON CONFLICT(ticker, resource) DO UPDATE SET revision = max(revision, excluded.revision)`).bind(ticker, now.toISOString()),
  ]);
  const failed: string[] = [];
  let refreshed = 0;
  for (const company of due.results) {
    const quote = await fetchReferenceQuote(company.ticker, company.currency, fetcher, now);
    if (!quote?.usable) {
      const previous = await store.getCache<unknown>(PREFIX + company.ticker);
      await persist(company.ticker, previous?.payload ?? null);
      failed.push(company.ticker);
      continue;
    }
    await persist(company.ticker, quote);
    refreshed++;
  }
  return { refreshed, failed };
}
