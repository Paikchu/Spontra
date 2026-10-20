import { financialPolicy, aiIsEnabled } from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import { FEATURES, type Feature } from '../../../../shared/analysis-contract/business-features.ts';
import { parseTrackedTickers } from '../sec/config.ts';
import { aiToolEnvironment } from '../ai-config.ts';

type PolicyEnv = { DB?: D1Database; SEC_DATA_TICKERS?: string; SEC_TRACKED_TICKERS?: string; SEC_AI_TICKERS?: string; SEC_AI_ENABLED?: string;
  BUSINESS_TREE_TICKERS?: string; BUSINESS_TREE_ENABLED?: string; FEATURE_RESOLVED?: string; AI_TOOL_SETTINGS?: string };
type Row = { ticker: string; enabled: number };
type FeatureRow = { ticker: string; feature: Feature; generate: number | null };

/** The resolved feature lists and global switches, carried in the environment as `FEATURE_RESOLVED` (JSON). */
export type FeatureResolution = { enabled: Record<Feature, boolean>; tickers: Record<Feature, string[]> };

export function parseFeatureResolution(value: string | undefined): FeatureResolution | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(value) as FeatureResolution;
    return FEATURES.every(f => typeof parsed.enabled?.[f] === 'boolean' && Array.isArray(parsed.tickers?.[f])) ? parsed : null;
  } catch { return null; }
}

/**
 * The deployment's defaults for each feature, before the admin's switches: SEC_AI_TICKERS (over SEC_AI_ENABLED) for the
 * reports, findings and explainer; BUSINESS_TREE_TICKERS plus the AI list (over BUSINESS_TREE_ENABLED) for the tree.
 */
export function defaultFeatureResolution(env: Omit<PolicyEnv, 'DB'>): FeatureResolution {
  const ai = parseTrackedTickers(env.SEC_AI_TICKERS ?? env.SEC_TRACKED_TICKERS);
  const aiOn = aiIsEnabled(env);
  const tree = [...new Set([...parseTrackedTickers(env.BUSINESS_TREE_TICKERS ?? ''), ...ai])];
  return {
    enabled: { reports: aiOn, findings: aiOn, explainer: aiOn, tree: env.BUSINESS_TREE_ENABLED !== 'false' },
    tickers: { reports: [...ai], findings: [...ai], explainer: [...ai], tree },
  };
}

/**
 * Persisted per-company choices override deployment defaults, including explicit removals: the admin whitelist
 * (`financial_company_settings`) over SEC_DATA_TICKERS, and the admin's feature switches (`business_feature_settings`)
 * over each feature's default list and global switch (docs/whitelist-feature-switches-design.md). The result is carried
 * as `FEATURE_RESOLVED`; `SEC_AI_TICKERS` is set to the reports list so code reading it as "the AI list" keeps working.
 * Applying it twice gives the same lists, so every entry point applies it once and code below reads the environment as
 * before. A table not yet migrated leaves its defaults in force. The admin's model settings ride along as
 * `AI_TOOL_SETTINGS` (ai-config.ts).
 */
export async function companyPolicyEnvironment<T extends PolicyEnv>(env: T): Promise<T> {
  if (!env.DB) return env;
  const policy = financialPolicy({ ...env, SEC_AI_ENABLED: 'false' });
  const data = await env.DB.prepare('SELECT ticker,enabled FROM financial_company_settings').bind().all<Row>();
  for (const row of data.results) {
    if (row.enabled) policy.dataTickers.add(row.ticker);
    else policy.dataTickers.delete(row.ticker);
  }
  // A second application starts from the resolved lists, so its explicit removals stay removed.
  const resolution = parseFeatureResolution(env.FEATURE_RESOLVED) ?? defaultFeatureResolution(env);
  const sets = Object.fromEntries(FEATURES.map(f => [f, new Set(resolution.tickers[f])])) as Record<Feature, Set<string>>;
  const enabled = { ...resolution.enabled };
  const rows = await env.DB.prepare('SELECT ticker,feature,generate FROM business_feature_settings WHERE generate IS NOT NULL').bind().all<FeatureRow>().catch(() => null);
  for (const row of rows?.results ?? []) {
    if (!(row.feature in sets)) continue;
    if (row.ticker === '*') enabled[row.feature] = !!row.generate;
    else if (row.generate) sets[row.feature].add(row.ticker);
    else sets[row.feature].delete(row.ticker);
  }
  const resolved: FeatureResolution = { enabled, tickers: Object.fromEntries(FEATURES.map(f => [f, [...sets[f]].sort()])) as Record<Feature, string[]> };
  return aiToolEnvironment({
    ...env,
    SEC_DATA_TICKERS: [...policy.dataTickers].join(','),
    SEC_AI_TICKERS: resolved.tickers.reports.join(','),
    SEC_AI_ENABLED: resolved.enabled.reports ? 'true' : 'false',
    BUSINESS_TREE_ENABLED: resolved.enabled.tree ? 'true' : 'false',
    FEATURE_RESOLVED: JSON.stringify(resolved),
  });
}

/**
 * The companies a feature runs for, after the admin's switches; empty while the feature is globally off. Before
 * `companyPolicyEnvironment` ran, the deployment defaults.
 */
export function featureTickersFor(env: Omit<PolicyEnv, 'DB'>, feature: Feature): string[] {
  const resolution = parseFeatureResolution(env.FEATURE_RESOLVED) ?? defaultFeatureResolution(env);
  return resolution.enabled[feature] ? [...resolution.tickers[feature]].sort() : [];
}

/** The companies a feature is switched on for, whatever its global switch says: what the admin's per-company switch shows. */
export function featureCompaniesFor(env: Omit<PolicyEnv, 'DB'>, feature: Feature): string[] {
  return [...(parseFeatureResolution(env.FEATURE_RESOLVED) ?? defaultFeatureResolution(env)).tickers[feature]].sort();
}

/** Whether the feature is generated at all (the admin's global switch over the deployment flag). */
export function featureEnabled(env: Omit<PolicyEnv, 'DB'>, feature: Feature): boolean {
  return (parseFeatureResolution(env.FEATURE_RESOLVED) ?? defaultFeatureResolution(env)).enabled[feature];
}
