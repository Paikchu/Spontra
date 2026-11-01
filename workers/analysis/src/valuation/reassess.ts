import { tickerList } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import { CALCULATOR_VERSION } from "../../../../shared/analysis-runtime/valuation/calculator.ts";
import type { ValuationPublication } from "../../../../shared/analysis-contract/valuation.ts";

/**
 * Which companies a method change may reassess on its own (docs/valuation-v2-SPEC.md §6). A new prompt, calculator or
 * input version changes every switched-on company's fingerprint at once; without a limit each would spend a full run
 * on unchanged material the moment the code deploys. `VALUATION_REASSESS_TICKERS` names the companies that may be
 * reassessed on a method change alone (`*` for all; unset or empty for none). Everyone else keeps the report written
 * under the old method until new material arrives (a later financial period) or an admin starts a run by hand.
 */
export type ReassessEnv = { VALUATION_REASSESS_TICKERS?: string };

export function reassessTickers(env: ReassessEnv): string[] | "*" {
  const raw = (env.VALUATION_REASSESS_TICKERS ?? "").trim();
  if (raw === "*") return "*";
  try { return tickerList(raw); } catch { return []; }
}

export type HoldBack = { reason: string; publishedMethod: string; publishedCalculator: string; financialPeriodEnd: string };

/**
 * Whether the pending run would only migrate an existing report to the new method, and the company is not on the list:
 * then the run is held and the reason returned; null when the run may go ahead (no report, same method, new period,
 * or the company is listed).
 */
export function methodChangeHeldBack(env: ReassessEnv, published: Pick<ValuationPublication, "methodVersion" | "calculatorVersion" | "financialPeriodEnd"> | null, current: { methodVersion: string; calculatorVersion?: string; financialPeriodEnd: string }, ticker: string): HoldBack | null {
  if (!published) return null;
  const calculator = current.calculatorVersion ?? CALCULATOR_VERSION;
  if (published.methodVersion === current.methodVersion && published.calculatorVersion === calculator) return null;
  if (published.financialPeriodEnd !== current.financialPeriodEnd) return null;
  const allowed = reassessTickers(env);
  if (allowed === "*" || allowed.includes(ticker)) return null;
  return { reason: `method moved ${published.methodVersion}/${published.calculatorVersion} → ${current.methodVersion}/${calculator} on unchanged material (period ${current.financialPeriodEnd}); ${ticker} is not in VALUATION_REASSESS_TICKERS, so the published report stands until the next period or a manual run`, publishedMethod: published.methodVersion, publishedCalculator: published.calculatorVersion, financialPeriodEnd: published.financialPeriodEnd };
}
