import Anthropic from "@anthropic-ai/sdk";
import { aiUsageFromMetrics, recordAiUsage } from "../ai-runs/usage.ts";

/**
 * The one call path to Anthropic's API: the artifact arbiter and the visual review run on Claude Haiku 5.5, a judgement
 * from outside the DeepSeek models that write and review the content (docs/analysis-html-artifact.md §6.3, §7.4).
 * The answer is constrained to a JSON schema; spend goes to the `ai_usage` ledger like every other model call.
 */
export const HAIKU = "claude-haiku-5-5";

export type AnthropicEnv = { ANTHROPIC_API_KEY?: string; DB?: D1Database };
export type ImageInput = { mediaType: "image/jpeg" | "image/png"; base64: string };
export type JudgeCall = {
  stage: string; system: string; text: string; images?: ImageInput[];
  schema: Record<string, unknown>; effort?: "low" | "medium" | "high" | "xhigh" | "max"; maxTokens?: number;
  ledger: { kind: string; ticker?: string; runId?: string };
};

export class AnthropicUnavailable extends Error {}

export const anthropicConfigured = (env: AnthropicEnv) => Boolean(env.ANTHROPIC_API_KEY);

export async function judge<T>(env: AnthropicEnv, call: JudgeCall): Promise<T> {
  if (!env.ANTHROPIC_API_KEY) throw new AnthropicUnavailable("ANTHROPIC_API_KEY is not configured");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 5 * 60_000 });
  const started = Date.now();
  const content: Anthropic.ContentBlockParam[] = [
    ...(call.images ?? []).map((image): Anthropic.ContentBlockParam => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } })),
    { type: "text", text: call.text },
  ];
  let usage: Record<string, unknown> = {}, finish: string | null = null, error: string | undefined;
  try {
    const response = await client.messages.create({
      model: HAIKU, max_tokens: call.maxTokens ?? 16_000, system: call.system,
      messages: [{ role: "user", content }],
      output_config: { effort: call.effort ?? "medium", format: { type: "json_schema", schema: call.schema } },
    } as Anthropic.MessageCreateParamsNonStreaming);
    usage = response.usage as unknown as Record<string, unknown>;
    finish = response.stop_reason;
    // A refusal is not a verdict: the caller treats it as a judgement that did not happen.
    if (response.stop_reason === "refusal") throw new AnthropicUnavailable("the judge declined this request");
    const text = response.content.flatMap(block => block.type === "text" ? [block.text] : []).join("");
    return JSON.parse(text) as T;
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, 200) : String(caught);
    throw caught instanceof AnthropicUnavailable ? caught : new AnthropicUnavailable(error);
  } finally {
    await recordAiUsage(env, aiUsageFromMetrics({ stage: call.stage, model: HAIKU, reasoning: call.effort ?? "medium", finishReason: finish, usage, ...(error ? { error } : {}) },
      { at: new Date(started).toISOString(), durationMs: Date.now() - started, provider: "anthropic", ...call.ledger }));
  }
}
