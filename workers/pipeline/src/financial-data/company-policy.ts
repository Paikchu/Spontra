import { financialPolicy } from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import { trackedTickersFor } from '../core.ts';
import { parseTrackedTickers } from '../sec/config.ts';

type PolicyEnv = { DB?: D1Database; SEC_DATA_TICKERS?: string; SEC_TRACKED_TICKERS?: string; SEC_AI_TICKERS?: string; SEC_AI_ENABLED?: string;
  BUSINESS_TREE_TICKERS?: string; BUSINESS_TREE_ENABLED?: string; BUSINESS_TREE_RESOLVED?: string };
type Row = { ticker: string; enabled: number };
type TreeRow = { ticker: string; generate: number | null };

/**
 * Persisted per-company choices override deployment defaults, including explicit removals: the admin whitelist
 * (`financial_company_settings`) over SEC_DATA_TICKERS, and the admin's AI switch (`financial_ai_settings`) over
 * SEC_AI_TICKERS, and the mind map switches (`business_tree_settings`): ticker '*' over BUSINESS_TREE_ENABLED, a company
 * row over the mind-map list (BUSINESS_TREE_TICKERS plus the AI list), resolved into BUSINESS_TREE_RESOLVED. Applying
 * it twice gives the same lists, so every entry point applies it once and code below reads the environment as before.
 * A table not yet migrated leaves its defaults in force.
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
  const resolved = { ...env, SEC_DATA_TICKERS: [...policy.dataTickers].join(','), SEC_AI_TICKERS: [...policy.aiTickers].join(',') };
  // A second application starts from the resolved list, so its explicit removals stay removed.
  const tree = new Set(env.BUSINESS_TREE_RESOLVED !== undefined ? parseTrackedTickers(env.BUSINESS_TREE_RESOLVED)
    : [...parseTrackedTickers(env.BUSINESS_TREE_TICKERS ?? ''), ...trackedTickersFor(resolved)]);
  let enabled = env.BUSINESS_TREE_ENABLED;
  const rows = await env.DB.prepare('SELECT ticker,generate FROM business_tree_settings WHERE generate IS NOT NULL').bind().all<TreeRow>().catch(() => null);
  for (const row of rows?.results ?? []) {
    if (row.ticker === '*') enabled = row.generate ? 'true' : 'false';
    else if (row.generate) tree.add(row.ticker);
    else tree.delete(row.ticker);
  }
  return { ...resolved, BUSINESS_TREE_ENABLED: enabled, BUSINESS_TREE_RESOLVED: [...tree].sort().join(',') };
}
