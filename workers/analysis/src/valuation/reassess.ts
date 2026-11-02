import { CALCULATOR_VERSION } from "../../../../shared/analysis-runtime/valuation/calculator.ts";
import type { ValuationPublication } from "../../../../shared/analysis-contract/valuation.ts";

/**
 * Whether a method change alone may reassess a company (docs/valuation-v2-SPEC.md §6). A new prompt, calculator or
 * input version changes every switched-on company's fingerprint at once; without a limit each would spend a full run on
 * unchanged material the moment the code deploys. The admin marks the companies that may (`valuation_company_inputs.reassess`,
 * 估值输入); everyone else keeps the report written under the old method until new material arrives (a later financial
 * period) or an admin starts a run by hand.
 */
export type HoldBack = { reason: string; publishedMethod: string; publishedCalculator: string; financialPeriodEnd: string };

/**
 * Whether the pending run would only migrate an existing report to the new method, and the company is not marked: then
 * the run is held and the reason returned; null when the run may go ahead (no report, same method, new period, or the
 * company is marked).
 */
export function methodChangeHeldBack(reassess: boolean, published: Pick<ValuationPublication, "methodVersion" | "calculatorVersion" | "financialPeriodEnd"> | null, current: { methodVersion: string; calculatorVersion?: string; financialPeriodEnd: string }, ticker: string): HoldBack | null {
  if (!published) return null;
  const calculator = current.calculatorVersion ?? CALCULATOR_VERSION;
  if (published.methodVersion === current.methodVersion && published.calculatorVersion === calculator) return null;
  if (published.financialPeriodEnd !== current.financialPeriodEnd) return null;
  if (reassess) return null;
  return { reason: `method moved ${published.methodVersion}/${published.calculatorVersion} → ${current.methodVersion}/${calculator} on unchanged material (period ${current.financialPeriodEnd}); ${ticker} is not marked to reassess on a method change, so the published report stands until the next period or a manual run`, publishedMethod: published.methodVersion, publishedCalculator: published.calculatorVersion, financialPeriodEnd: published.financialPeriodEnd };
}
