import { TICKER_PATTERN } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import type { AnalysisEnv } from "../operations.ts";

/** Ask is available on demand for whitelisted companies, unless its global or company switch is off. */
export async function stageAvailable(env: Pick<AnalysisEnv, "DB">, ticker: string): Promise<boolean> {
  if (!env.DB || !TICKER_PATTERN.test(ticker)) return false;
  const row = await env.DB.prepare(`SELECT
    (SELECT enabled FROM financial_company_settings WHERE ticker = ?) tracked,
    (SELECT enabled FROM stage_settings WHERE ticker = '*') globalEnabled,
    (SELECT enabled FROM stage_settings WHERE ticker = ?) companyEnabled`)
    .bind(ticker, ticker).first<{ tracked: number | null; globalEnabled: number | null; companyEnabled: number | null }>();
  return row?.tracked === 1 && row.globalEnabled !== 0 && row.companyEnabled !== 0;
}
