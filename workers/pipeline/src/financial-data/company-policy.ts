import { financialPolicy } from '../../../../shared/analysis-runtime/financial-data/policy.ts';

type PolicyEnv = { DB?: D1Database; SEC_DATA_TICKERS?: string; SEC_TRACKED_TICKERS?: string };
/** Persisted per-company choices override deployment defaults, including explicit removals. */
export async function companyPolicyEnvironment<T extends PolicyEnv>(env: T): Promise<T> {
  if (!env.DB) return env;
  const policy = financialPolicy({ ...env, SEC_AI_ENABLED: 'false' });
  const rows = await env.DB.prepare('SELECT ticker,enabled FROM financial_company_settings').bind().all<{ticker:string;enabled:number}>();
  for (const row of rows.results) {
    if (row.enabled) policy.dataTickers.add(row.ticker);
    else policy.dataTickers.delete(row.ticker);
  }
  return { ...env, SEC_DATA_TICKERS: [...policy.dataTickers].join(',') };
}
