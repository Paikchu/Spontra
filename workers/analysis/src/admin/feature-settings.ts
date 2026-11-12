import { FEATURES, LAYER_REQUIRES, type Feature, type Layer } from "../../../../shared/analysis-contract/business-features.ts";

/**
 * The admin's feature switches as stored (`business_feature_settings`). One
 * switch per company and feature: on generates the feature and shows it, off stops generating and hides what was written
 * (it stays stored). Generation is resolved into the environment by company-policy.ts; reads here are the display side.
 * A company without a row is off. Query failures propagate so stored choices cannot be replaced by defaults.
 */
/** The deployment flags the read path knows (the MapReads binding sees the vars, never the resolved environment). */
export type FeatureDefaultsEnv = { SEC_AI_ENABLED?: string; BUSINESS_TREE_ENABLED?: string; VALUATION_ENABLED?: string };

/** Whether readers see the company's feature: its switch; off when the admin never set one. */
export async function featureShown(db: D1Database, ticker: string, feature: Feature): Promise<boolean> {
  return (await shownLayers(db, ticker))[feature];
}

function resolveLayers(map: boolean, choices: ReadonlyMap<Feature, boolean>): Record<Layer, boolean> {
  const layers = { map } as Record<Layer, boolean>;
  for (const feature of FEATURES) layers[feature] = layers[LAYER_REQUIRES[feature]!] && (choices.get(feature) ?? false);
  return layers;
}

/** Display follows the ladder while a failed generation can leave the last publication visible. */
export async function shownLayers(db: D1Database, ticker: string): Promise<Record<Layer, boolean>> {
  const [company, features] = await Promise.all([
    db.prepare("SELECT enabled FROM financial_company_settings WHERE ticker = ?").bind(ticker).first<{ enabled: number }>(),
    db.prepare("SELECT feature, coalesce(display, generate) shown FROM business_feature_settings WHERE ticker = ?")
      .bind(ticker).all<{ feature: Feature; shown: number | null }>(),
  ]);
  return resolveLayers(company?.enabled === 1, new Map(features.results.filter(row => row.shown !== null).map(row => [row.feature, !!row.shown])));
}

/** A test for every company at once, from one read: the switches stored for the feature over its default list. */
export async function shownFilter(db: D1Database, feature: Feature, ticker?: string): Promise<(ticker: string) => boolean> {
  // `display` decides where set: a failed run stops generation (messages.ts) and leaves what was written shown.
  const [rows, companies] = await Promise.all([
    db.prepare(`SELECT ticker, feature, coalesce(display, generate) shown FROM business_feature_settings WHERE ticker <> '*' AND coalesce(display, generate) IS NOT NULL${ticker ? " AND ticker = ?" : ""}`)
      .bind(...(ticker ? [ticker] : [])).all<{ ticker: string; feature: Feature; shown: number }>(),
    db.prepare(`SELECT ticker FROM financial_company_settings WHERE enabled = 1${ticker ? " AND ticker = ?" : ""}`)
      .bind(...(ticker ? [ticker] : [])).all<{ ticker: string }>(),
  ]);
  const maps = new Set(companies.results.map(row => row.ticker));
  const choices = new Map<string, Map<Feature, boolean>>();
  for (const row of rows.results) {
    const company = choices.get(row.ticker) ?? new Map<Feature, boolean>();
    company.set(row.feature, !!row.shown);
    choices.set(row.ticker, company);
  }
  return t => resolveLayers(maps.has(t), choices.get(t) ?? new Map())[feature];
}

/** Turns one switch on or off; both stored bits follow it, so a row never says generated-but-hidden. Only a failed run sets them apart. */
export async function writeFeatureSetting(db: D1Database, ticker: string, feature: Feature, on: boolean, now: string): Promise<void> {
  const bit = on ? 1 : 0;
  await db.prepare(`INSERT INTO business_feature_settings (ticker, feature, generate, display, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (ticker, feature) DO UPDATE SET generate = excluded.generate, display = excluded.display, updated_at = excluded.updated_at`)
    .bind(ticker, feature, bit, ticker === "*" ? null : bit, now).run();
}
