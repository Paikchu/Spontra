import type { AnalysisEnv } from "../operations.ts";
import { scheduledAnalysisPauses } from "../pipeline/scheduled-analysis.ts";

export async function translationScheduled(env: Pick<AnalysisEnv, "DB">, ticker: string): Promise<boolean> {
  return (await scheduledAnalysisPauses(env.DB!)).at(ticker) === null;
}

export class TranslationPaused extends Error {}

export async function requireTranslationScheduled(env: Pick<AnalysisEnv, "DB">, ticker: string): Promise<void> {
  if (!await translationScheduled(env, ticker)) throw new TranslationPaused("scheduled analysis is paused");
}
