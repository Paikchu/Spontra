import { aiIsEnabled, dataTickers } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import { FEATURES, type Feature } from '../../../../shared/analysis-contract/business-features.ts';

import { aiToolEnvironment } from '../ai-config.ts';

type PolicyEnv = { DB?: D1Database; SEC_DATA_TICKERS?: string; SEC_AI_TICKERS?: string; SEC_AI_ENABLED?: string;
  BUSINESS_TREE_ENABLED?: string; VALUATION_ENABLED?: string; FEATURE_RESOLVED?: string; AI_TOOL_SETTINGS?: string };
type Row = { ticker: string; enabled: number };
type FeatureRow = { ticker: string; feature: Feature; generate: number | null };

/** The resolved feature lists and global switches, carried in the environment as `FEATURE_RESOLVED` (JSON). */
type FeatureResolution = { enabled: Record<Feature, boolean>; tickers: Record<Feature, string[]> };

export function parseFeatureResolution(value: string | undefined): FeatureResolution | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(value) as FeatureResolution;
    return FEATURES.every(f => typeof parsed.enabled?.[f] === 'boolean' && Array.isArray(parsed.tickers?.[f])) ? parsed : null;
  } catch { return null; }
}

/**
 * Before the admin's switches: the deployment's global flags (SEC_AI_ENABLED for the reports, findings and explainer,
 * BUSINESS_TREE_ENABLED, VALUATION_ENABLED) and no company. The deployment never lists companies; every company is
 * switched on one by one in the admin (`business_feature_settings`).
 */
function defaultFeatureResolution(env: Omit<PolicyEnv, 'DB'>): FeatureResolution {
  const aiOn = aiIsEnabled(env);
  return {
    enabled: { reports: aiOn, findings: aiOn, explainer: aiOn, tree: env.BUSINESS_TREE_ENABLED !== 'false', valuation: env.VALUATION_ENABLED !== 'false' },
    tickers: Object.fromEntries(FEATURES.map(f => [f, []])) as unknown as Record<Feature, string[]>,
  };
}

/**
 * The admin's choices are the company lists: the whitelist (`financial_company_settings`) is the collection list, and
 * the feature switches (`business_feature_settings`) are each feature's list, over its global switch
 * (docs/whitelist-feature-switches-design.md). A list in the deployment's variables is ignored. The result is carried as
 * `SEC_DATA_TICKERS` and `FEATURE_RESOLVED`; `SEC_AI_TICKERS` is set to the reports list so code reading it as "the AI
 * list" keeps working.
 * Applying it twice gives the same lists, so every entry point applies it once and code below reads the environment as
 * before. A settings read failure aborts resolution; defaults apply only when no row exists. The admin's model settings ride along as
 * `AI_TOOL_SETTINGS` (ai-config.ts).
 */
export async function companyPolicyEnvironment<T extends PolicyEnv>(env: T): Promise<T> {
  if (!env.DB) return env;
  // A second application starts from the resolved list; a first one from nothing, never from a deployment list.
  const enabledData = env.FEATURE_RESOLVED !== undefined ? dataTickers(env) : new Set<string>();
  const data = await env.DB.prepare('SELECT ticker,enabled FROM financial_company_settings').bind().all<Row>();
  for (const row of data.results) {
    if (row.enabled) enabledData.add(row.ticker);
    else enabledData.delete(row.ticker);
  }
  // A second application starts from the resolved lists, so its explicit removals stay removed.
  const resolution = parseFeatureResolution(env.FEATURE_RESOLVED) ?? defaultFeatureResolution(env);
  const sets = Object.fromEntries(FEATURES.map(f => [f, new Set(resolution.tickers[f])])) as Record<Feature, Set<string>>;
  const enabled = { ...resolution.enabled };
  const rows = await env.DB.prepare('SELECT ticker,feature,generate FROM business_feature_settings WHERE generate IS NOT NULL').bind().all<FeatureRow>();
  for (const row of rows.results) {
    if (!(row.feature in sets)) continue;
    if (row.ticker === '*') enabled[row.feature] = !!row.generate;
    else if (row.generate) sets[row.feature].add(row.ticker);
    else sets[row.feature].delete(row.ticker);
  }
  const resolved: FeatureResolution = { enabled, tickers: Object.fromEntries(FEATURES.map(f => [f, [...sets[f]].sort()])) as Record<Feature, string[]> };
  return aiToolEnvironment({
    ...env,
    SEC_DATA_TICKERS: [...enabledData].join(','),
    SEC_AI_TICKERS: resolved.tickers.reports.join(','),
    SEC_AI_ENABLED: resolved.enabled.reports ? 'true' : 'false',
    BUSINESS_TREE_ENABLED: resolved.enabled.tree ? 'true' : 'false',
    VALUATION_ENABLED: resolved.enabled.valuation ? 'true' : 'false',
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
