import { FEATURES, type Feature, type FeatureSwitches } from "../../../../shared/analysis-contract/business-features.ts";

/**
 * The admin's feature switches as stored (`business_feature_settings`, docs/whitelist-feature-switches-design.md).
 * Reads here are the display side: whether the map shows a company's published content. Generation is resolved into
 * the environment by company-policy.ts. A table not yet migrated reads as everything shown.
 */
type Row = { ticker: string; feature: Feature; generate: number | null; display: number | null };

/** Whether the public read of a feature shows the company's content: shown unless the admin switched its display off. */
export async function featureDisplayed(db: D1Database, ticker: string, feature: Feature): Promise<boolean> {
  const row = await db.prepare("SELECT display FROM business_feature_settings WHERE ticker = ? AND feature = ?").bind(ticker, feature).first<{ display: number | null }>().catch(() => null);
  return row?.display !== 0;
}

/** Every company whose display of the feature is switched off. */
export async function hiddenTickers(db: D1Database, feature: Feature): Promise<Set<string>> {
  const rows = await db.prepare("SELECT ticker FROM business_feature_settings WHERE feature = ? AND display = 0").bind(feature).all<{ ticker: string }>().catch(() => null);
  return new Set((rows?.results ?? []).map(r => r.ticker));
}

/** Every stored switch, by company and feature; the '*' rows carry the global generation switches. */
export async function readFeatureSettings(db: D1Database): Promise<Map<string, Partial<Record<Feature, { generate: boolean | null; display: boolean }>>>> {
  const rows = await db.prepare("SELECT ticker, feature, generate, display FROM business_feature_settings").bind().all<Row>().catch(() => null);
  const map = new Map<string, Partial<Record<Feature, { generate: boolean | null; display: boolean }>>>();
  for (const row of rows?.results ?? []) {
    if (!(FEATURES as readonly string[]).includes(row.feature)) continue;
    const entry = map.get(row.ticker) ?? {};
    entry[row.feature] = { generate: row.generate === null ? null : !!row.generate, display: row.display !== 0 };
    map.set(row.ticker, entry);
  }
  return map;
}

/** Writes the given bits of one switch; a bit left out keeps its stored value. */
export async function writeFeatureSetting(db: D1Database, ticker: string, feature: Feature, change: Partial<FeatureSwitches>, now: string): Promise<void> {
  const generate = typeof change.generate === "boolean" ? (change.generate ? 1 : 0) : null;
  const display = typeof change.display === "boolean" ? (change.display ? 1 : 0) : null;
  await db.prepare(`INSERT INTO business_feature_settings (ticker, feature, generate, display, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (ticker, feature) DO UPDATE SET generate = COALESCE(excluded.generate, business_feature_settings.generate),
      display = COALESCE(excluded.display, business_feature_settings.display), updated_at = excluded.updated_at`)
    .bind(ticker, feature, generate, display, now).run();
}
