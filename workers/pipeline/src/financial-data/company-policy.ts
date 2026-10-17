import { financialPolicy } from '../../../../shared/analysis-runtime/financial-data/policy.ts';

type PolicyEnv = { DB?: D1Database; SEC_DATA_TICKERS?: string; SEC_TRACKED_TICKERS?: string; SEC_AI_TICKERS?: string };
type Row = { ticker: string; enabled: number };

/**
 * Persisted per-company choices override deployment defaults, including explicit removals: the admin whitelist
 * (`financial_company_settings`) over SEC_DATA_TICKERS, and the admin's AI switch (`financial_ai_settings`) over
 * SEC_AI_TICKERS. Applying it twice gives the same lists, so every entry point applies it once and code below reads
 * the environment as before. An AI table not yet migrated leaves the AI default in force.
 */
export async function companyPolicyEnvironment<T extends PolicyEnv>(env: T): Promise<T> {
  if (!env.DB) return env;
  const policy = financialPolicy({ ...env, SEC_AI_ENABLED: 'false' });
  const data = await env.DB.prepare('SELECT ticker,enabled FROM financial_company_settings').bind().all<Row>();
  for (const row of data.results) {
    if (row.enabled) policy.dataTickers.add(row.ticker);
    else policy.dataTickers.delete(row.ticker);
  }
  const ai = await env.DB.prepare('SELECT ticker,enabled FROM financial_ai_settings').bind().all<Row>().catch(() => null);
  for (const row of ai?.results ?? []) {
    if (row.enabled) policy.aiTickers.add(row.ticker);
    else policy.aiTickers.delete(row.ticker);
  }
  return { ...env, SEC_DATA_TICKERS: [...policy.dataTickers].join(','), SEC_AI_TICKERS: [...policy.aiTickers].join(',') };
}
