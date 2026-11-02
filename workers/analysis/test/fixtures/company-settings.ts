import type { Feature } from "../../../../shared/analysis-contract/business-features.ts";

/** Clears the company rows migration 0043 carries over from the former deployment lists, so a test starts with no company on. */
export const UNSEEDED = "DELETE FROM financial_company_settings; DELETE FROM business_feature_settings; DELETE FROM valuation_company_inputs;";

/** The admin's rows a test's companies need: whitelist entries, and each feature switched on for the given companies. */
export async function switchOn(db: D1Database, data: string[], features: Partial<Record<Feature, string[]>> = {}): Promise<void> {
  for (const ticker of data) await db.prepare("INSERT OR REPLACE INTO financial_company_settings (ticker, enabled, updated_at) VALUES (?, 1, '2026-01-01T00:00:00.000Z')").bind(ticker).run();
  for (const [feature, tickers] of Object.entries(features)) for (const ticker of tickers ?? []) {
    await db.prepare("INSERT OR REPLACE INTO business_feature_settings (ticker, feature, generate, display, updated_at) VALUES (?, ?, 1, 1, '2026-01-01T00:00:00.000Z')").bind(ticker, feature).run();
  }
}

/**
 * The environment fields an entry point leaves after `companyPolicyEnvironment`, for a test that hands a task the
 * resolved environment directly: these companies collected and every model feature on for them.
 */
export function resolvedFor(tickers: string[]): { SEC_DATA_TICKERS: string; SEC_AI_TICKERS: string; SEC_AI_ENABLED: string; FEATURE_RESOLVED: string } {
  const list = [...tickers].sort();
  return {
    SEC_DATA_TICKERS: list.join(","), SEC_AI_TICKERS: list.join(","), SEC_AI_ENABLED: "true",
    FEATURE_RESOLVED: JSON.stringify({ enabled: { reports: true, findings: true, explainer: true, tree: true, valuation: true }, tickers: { reports: list, findings: list, explainer: list, tree: list, valuation: list } }),
  };
}
