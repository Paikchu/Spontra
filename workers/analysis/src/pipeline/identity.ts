/**
 * The company's SEC CIK as this pipeline already knows it, without a request: from the discovery state, the latest
 * collection job, the SEC filing list or the admin's issuer record. Null for a company never seen before.
 */
export async function knownCik(db: D1Database, ticker: string): Promise<string | null> {
  const row = await db.prepare(`SELECT COALESCE(
    (SELECT json_extract(payload, '$.cik') FROM sec_cache WHERE cache_key = 'sec:discovery:v1:' || ?),
    (SELECT cik FROM financial_collection_jobs WHERE ticker = ? ORDER BY generation DESC LIMIT 1),
    (SELECT json_extract(payload, '$.company.cik') FROM sec_cache WHERE cache_key = 'sec:filings:' || ?),
    (SELECT json_extract(payload, '$.cik') FROM sec_cache WHERE cache_key = 'admin:financial-issuer:' || ?)
  ) AS cik`).bind(ticker, ticker, ticker, ticker).first<{ cik: string | number | null }>();
  const cik = row?.cik == null ? null : String(row.cik).padStart(10, "0");
  return cik && /^\d{10}$/.test(cik) && Number(cik) > 0 ? cik : null;
}
