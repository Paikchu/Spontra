import { createModels, createProvider, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { DEEPSEEK_BASE_URL } from "../operations.ts";
import { SEC_FALLBACK_MODEL, SEC_MODEL_OUTPUT_TOKENS } from "../retry-policy.ts";
import { AI_MODELS } from "../../../../shared/analysis-contract/ai-models-admin.ts";

/** The provider id every Pi session uses for DeepSeek's Chat Completions API. */
export const PI_PROVIDER = "spontra";
/** DeepSeek's window; Pi compacts the session before a request would outgrow it. */
const CONTEXT_WINDOW = 128_000;
/** The output limit of one turn: a whole report draft goes out as one tool call, so it is the report model's limit. */
const TURN_TOKENS = SEC_MODEL_OUTPUT_TOKENS;

type ModelEnv = { DEEPSEEK_API_KEY?: string; PI_MODEL_BASE_URL?: string };

/**
 * The models a session may run on, all on DeepSeek. `PI_MODEL_BASE_URL` points them elsewhere for local checks only.
 * The DeepSeek template preserves reasoning content across tool rounds; the window, output limit and ids are ours.
 */
export function piModels(env: ModelEnv, ids: readonly string[]) {
  const template = deepseekProvider().getModels()[0]!;
  const baseUrl = env.PI_MODEL_BASE_URL || DEEPSEEK_BASE_URL;
  const models: Model<"openai-completions">[] = [...new Set([...ids, SEC_FALLBACK_MODEL])].map((id) => ({
    ...template, id, name: id, provider: PI_PROVIDER, baseUrl,
    reasoning: true, contextWindow: CONTEXT_WINDOW, maxTokens: TURN_TOKENS,
    // Spend is recorded in the ai_usage ledger from each reply's usage, not priced by pi.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  const registry = createModels();
  registry.setProvider(createProvider({
    id: PI_PROVIDER, name: "DeepSeek", baseUrl,
    auth: { apiKey: { name: "DeepSeek API key", resolve: async () => env.DEEPSEEK_API_KEY ? { auth: { apiKey: env.DEEPSEEK_API_KEY, baseUrl } } : undefined } },
    models, api: openAICompletionsApi(),
  }));
  return registry;
}

/** DeepSeek caches the conversation automatically. Pi builds the messages and tool calls. */
export function shapePayload(payload: unknown, effort: string): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const body = { ...(payload as Record<string, unknown>) };
  body.thinking = { type: "enabled" };
  body.reasoning_effort = effort;
  delete body.output_config;
  delete body.cache_control;
  delete body.temperature;
  delete body.top_p;
  delete body.top_k;
  return body;
}

/** Preserve existing DeepSeek thinking when Pi changes only the transport API of a stored conversation. */
export function migrateMessages(messages: readonly Message[]): readonly Message[] {
  return messages.map((message) => message.role === "assistant" && message.provider === PI_PROVIDER && message.api === "anthropic-messages"
    ? {
      ...message,
      api: "openai-completions",
      content: message.content.flatMap<AssistantMessage["content"][number]>((block) => block.type === "thinking"
        ? block.redacted ? [] : [{ ...block, thinkingSignature: "reasoning_content" }]
        : [block]),
    }
    : message);
}

/** Every model the admin may pick for a tool, and the deployment's own; a session can switch to any of them. */
export function piModelIds(env: { SEC_ANALYSIS_MODEL?: string; SEC_REASONING_MODEL?: string }): string[] {
  return [...new Set([env.SEC_ANALYSIS_MODEL || SEC_FALLBACK_MODEL, ...(env.SEC_REASONING_MODEL ? [env.SEC_REASONING_MODEL] : []), ...AI_MODELS])];
}
