import type { Feature } from "../../../../shared/analysis-contract/business-features.ts";
import { defaultFeatureResolution } from "../financial-data/company-policy.ts";

/**
 * The admin's feature switches as stored (`business_feature_settings`, docs/whitelist-feature-switches-design.md). One
 * switch per company and feature: on generates the feature and shows it, off stops generating and hides what was written
 * (it stays stored). Generation is resolved into the environment by company-policy.ts; reads here are the display side.
 * A company without a row follows the deployment's default list; a table not yet migrated reads as no rows.
 */
/** The deployment lists the read path knows (the MapReads binding sees the vars, never the resolved environment). */
export type FeatureDefaultsEnv = { SEC_AI_TICKERS?: string; SEC_TRACKED_TICKERS?: string; SEC_AI_ENABLED?: string; BUSINESS_TREE_TICKERS?: string; BUSINESS_TREE_ENABLED?: string };

/** Whether readers see the company's feature: its switch, or the deployment default when the admin never set one. */
export async function featureShown(db: D1Database, env: FeatureDefaultsEnv, ticker: string, feature: Feature): Promise<boolean> {
  return (await shownFilter(db, env, feature, ticker))(ticker);
}

/** A test for every company at once, from one read: the switches stored for the feature over its default list. */
export async function shownFilter(db: D1Database, env: FeatureDefaultsEnv, feature: Feature, ticker?: string): Promise<(ticker: string) => boolean> {
  // `display` decides where set: a failed run stops generation (messages.ts) and leaves what was written shown.
  const rows = await db.prepare(`SELECT ticker, coalesce(display, generate) shown FROM business_feature_settings WHERE feature = ? AND ticker <> '*' AND coalesce(display, generate) IS NOT NULL${ticker ? " AND ticker = ?" : ""}`)
    .bind(...(ticker ? [feature, ticker] : [feature])).all<{ ticker: string; shown: number }>().catch(() => null);
  const stored = new Map((rows?.results ?? []).map(r => [r.ticker, !!r.shown]));
  const defaults = new Set(defaultFeatureResolution(env).tickers[feature]);
  return t => stored.get(t) ?? defaults.has(t);
}

/** Turns one switch on or off; both stored bits follow it, so a row never says generated-but-hidden. Only a failed run sets them apart. */
export async function writeFeatureSetting(db: D1Database, ticker: string, feature: Feature, on: boolean, now: string): Promise<void> {
  const bit = on ? 1 : 0;
  await db.prepare(`INSERT INTO business_feature_settings (ticker, feature, generate, display, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (ticker, feature) DO UPDATE SET generate = excluded.generate, display = excluded.display, updated_at = excluded.updated_at`)
    .bind(ticker, feature, bit, ticker === "*" ? null : bit, now).run();
}
