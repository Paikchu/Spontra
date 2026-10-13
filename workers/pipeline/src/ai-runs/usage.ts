import { boundedModelIO } from "../model-io.ts";

/**
 * The cost ledger for model calls (docs/analyst-agent-design.md, 前置数据工作 4; migration 0023): one row per
 * provider request, successful or not, carrying the usage the provider reported. The row is written beside the
 * call, best-effort: a missing database, a missing table or a slow write never fails the call.
 */
export type AiUsageOutcome = "ok" | "error" | "timeout";
export type AiUsageRow = {
  at: string;
  ticker: string | null;
  kind: string;
  runId: string | null;
  stage: string;
  provider: string;
  model: string;
  reasoning: string | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  durationMs: number;
  outcome: AiUsageOutcome;
  searchCalls: number;
};

/** What a call knows about itself beyond the request metrics. */
export type AiUsageCall = { at: string; durationMs: number; provider: string; ticker?: string; runId?: string; kind?: string; searchCalls?: number };

/** Stage names start with the feature that made the call; the two business agents share a `business-` prefix. */
export function aiUsageKind(stage: string): string {
  const business = /^business-(tree|explainer)(?:[-:]|$)/.exec(stage);
  if (business) return business[1]!;
  return stage.split(/[-:]/, 1)[0] || stage;
}

/** OpenAI-style usage as DeepSeek streams it in the final chunk; cache fields differ by provider, so both spellings are read. */
type ProviderUsage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_cache_hit_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
  completion_tokens_details?: { reasoning_tokens?: unknown } | null;
};
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

/** Shapes the ledger row from the metrics `requestWorkerSecModelContent` collects: stage, model, reasoning, usage, error. */
export function aiUsageFromMetrics(metrics: Readonly<Record<string, unknown>>, call: AiUsageCall): AiUsageRow {
  const stage = typeof metrics.stage === "string" ? metrics.stage : "unknown";
  const usage = (metrics.usage && typeof metrics.usage === "object" ? metrics.usage : {}) as ProviderUsage;
  const error = typeof metrics.error === "string" ? metrics.error : null;
  return {
    at: call.at,
    ticker: call.ticker ?? null,
    kind: call.kind ?? aiUsageKind(stage),
    runId: call.runId ?? null,
    stage,
    provider: call.provider,
    model: typeof metrics.model === "string" ? metrics.model : "unknown",
    reasoning: typeof metrics.reasoning === "string" ? metrics.reasoning : null,
    inputTokens: count(usage.prompt_tokens) ?? 0,
    cachedTokens: count(usage.prompt_tokens_details?.cached_tokens) ?? count(usage.prompt_cache_hit_tokens) ?? 0,
    outputTokens: count(usage.completion_tokens) ?? 0,
    reasoningTokens: count(usage.completion_tokens_details?.reasoning_tokens),
    durationMs: Math.max(0, Math.round(call.durationMs)),
    outcome: error === null ? "ok" : error.startsWith("model-timeout:") ? "timeout" : "error",
    searchCalls: call.searchCalls ?? 0,
  };
}

const INSERT = `INSERT INTO ai_usage (at, ticker, kind, run_id, stage, provider, model, reasoning, input_tokens, cached_tokens, output_tokens, reasoning_tokens, duration_ms, outcome, search_calls)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Writes one ledger row. Never throws; without a database it does nothing. */
export async function recordAiUsage(env: { DB?: D1Database }, row: AiUsageRow): Promise<void> {
  if (!env.DB) return;
  try {
    await boundedModelIO(env.DB.prepare(INSERT).bind(
      row.at, row.ticker, row.kind, row.runId, row.stage, row.provider, row.model, row.reasoning,
      row.inputTokens, row.cachedTokens, row.outputTokens, row.reasoningTokens, row.durationMs, row.outcome, row.searchCalls,
    ).run(), "ai-usage", 5000);
  } catch (error) {
    console.warn(JSON.stringify({ event: "ai-usage", outcome: "unavailable", kind: row.kind, stage: row.stage, error: error instanceof Error ? error.message : String(error) }));
  }
}
