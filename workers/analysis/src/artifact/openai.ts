import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionContentPart, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { aiUsageFromMetrics, recordAiUsage } from "../ai-runs/usage.ts";

export type JudgeEnv = { OPENAI_API_KEY?: string; OPENAI_REVIEW_MODEL?: string; DB?: D1Database };
export type ImageInput = { mediaType: "image/jpeg" | "image/png"; base64: string };
export type JudgeCall = {
  stage: string; system: string; text: string; images?: ImageInput[];
  schema: Record<string, unknown>; effort?: "low" | "medium" | "high" | "xhigh" | "max"; maxTokens?: number;
  ledger: { kind: string; ticker?: string; runId?: string };
};

export class JudgeUnavailable extends Error {}

export const judgeConfigured = (env: JudgeEnv) => Boolean(env.OPENAI_API_KEY && env.OPENAI_REVIEW_MODEL);

export async function judge<T>(env: JudgeEnv, call: JudgeCall): Promise<T> {
  const apiKey = env.OPENAI_API_KEY, model = env.OPENAI_REVIEW_MODEL;
  if (!apiKey || !model) throw new JudgeUnavailable("OPENAI_API_KEY and OPENAI_REVIEW_MODEL are required");
  const client = new OpenAI({ apiKey, maxRetries: 2, timeout: 5 * 60_000 });
  const started = Date.now();
  const content: ChatCompletionContentPart[] = [
    ...(call.images ?? []).map((image): ChatCompletionContentPart => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } })),
    { type: "text", text: call.text },
  ];
  let usage: ChatCompletion["usage"], finish: string | null = null, error: string | undefined;
  try {
    const request: ChatCompletionCreateParamsNonStreaming = {
      model, max_completion_tokens: call.maxTokens ?? 16_000, reasoning_effort: call.effort ?? "medium",
      messages: [{ role: "system", content: call.system }, { role: "user", content }],
      response_format: { type: "json_schema", json_schema: { name: "artifact_judgement", strict: true, schema: call.schema } },
    };
    const response = await client.chat.completions.create(request);
    usage = response.usage;
    const choice = response.choices[0];
    finish = choice?.finish_reason ?? null;
    if (choice?.message.refusal) throw new JudgeUnavailable("the judge declined this request");
    if (finish !== "stop" || !choice?.message.content) throw new JudgeUnavailable(`the judgement did not complete: ${finish ?? "empty response"}`);
    return JSON.parse(choice.message.content) as T;
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, 200) : String(caught);
    throw caught instanceof JudgeUnavailable ? caught : new JudgeUnavailable(error);
  } finally {
    await recordAiUsage(env, aiUsageFromMetrics({ stage: call.stage, model, reasoning: call.effort ?? "medium", finishReason: finish, usage, ...(error ? { error } : {}) },
      { at: new Date(started).toISOString(), durationMs: Date.now() - started, provider: "openai", ...call.ledger }));
  }
}
