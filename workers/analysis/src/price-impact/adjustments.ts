import { featureShown } from "../admin/feature-settings.ts";
import { TICKER_PATTERN } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import type { ValuationAdjustment, ValuationAdjustmentInput, ValuationAdjustmentRead } from "../../../../shared/analysis-contract/valuation-adjustment.ts";
import { calculateValuationAdjustment, valuationAdjustmentInput } from "../../../../shared/analysis-runtime/valuation/adjustment.ts";
import { ValuationStore } from "../valuation/store.ts";
import { sha256 } from "../sha256.ts";
import { companyResearchDependencyStatus } from "../public-research/context.ts";
import type { PublicResearchEnv } from "../public-research/store.ts";

export async function valuationAdjustmentAvailable(env: PublicResearchEnv, ticker: string): Promise<boolean> { return !!env.DB && TICKER_PATTERN.test(ticker) && await featureShown(env.DB, ticker, "valuation"); }

export const valuationDependencyId = (ticker: string, version: string) => `valuation:${ticker}:${version}`;
export async function createValuationAdjustment(env: PublicResearchEnv, reader: string, raw: ValuationAdjustmentInput): Promise<ValuationAdjustmentRead> {
  const input = valuationAdjustmentInput.parse(raw);
  if (!env.DB || !await valuationAdjustmentAvailable(env, input.ticker)) throw new Error("Valuation unavailable");
  const report = await new ValuationStore(env.DB).version(input.ticker, input.baseVersionId);
  if (!report) throw new Error("Saved valuation unavailable");
  const deps = await companyResearchDependencyStatus(env, valuationDependencyId(input.ticker, input.baseVersionId));
  if (deps.status !== "valid") return { status: "review_required", result: null, reason: "A background claim needs review; quantified sensitivity is suspended" };
  const result = calculateValuationAdjustment(report, input);
  const id = (await sha256(`${reader}\n${JSON.stringify(result)}`)).slice(0, 32);
  const complete: ValuationAdjustment = { ...result, id, createdAt: new Date().toISOString() };
  await env.DB.prepare("INSERT INTO user_valuation_adjustments(id,user_id,ticker,base_version_id,created_at,body_json) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING").bind(id, reader, input.ticker, input.baseVersionId, complete.createdAt, JSON.stringify(complete)).run();
  return readValuationAdjustment(env, reader, id);
}
export async function readValuationAdjustment(env: PublicResearchEnv, reader: string, id: string): Promise<ValuationAdjustmentRead> {
  if (!env.DB) throw new Error("Storage unavailable");
  const row = await env.DB.prepare("SELECT ticker,base_version_id,body_json FROM user_valuation_adjustments WHERE id=? AND user_id=?").bind(id, reader).first<{ ticker: string; base_version_id: string; body_json: string }>();
  if (!row || !await valuationAdjustmentAvailable(env, row.ticker)) throw new Error("Saved sensitivity unavailable for this reader");
  const deps = await companyResearchDependencyStatus(env, valuationDependencyId(row.ticker, row.base_version_id));
  if (deps.status !== "valid") return { status: "review_required", result: null, reason: "A background claim needs review; quantified sensitivity is suspended" };
  return { status: "available", result: JSON.parse(row.body_json) as ValuationAdjustment };
}
