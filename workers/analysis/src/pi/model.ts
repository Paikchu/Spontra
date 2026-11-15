import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { fixedThinkingMap, type StoredEndpoint } from "./endpoints.ts";
import { reasoningMap } from "./reasoning.ts";
import { DEEPSEEK_BASE_URL } from "../operations.ts";
import { SEC_FALLBACK_MODEL, SEC_MODEL_OUTPUT_TOKENS } from "../retry-policy.ts";
import { AI_MODELS } from "../../../../shared/analysis-contract/ai-models-admin.ts";

/** The provider id every Pi session uses for DeepSeek's Chat Completions API. */
export const PI_PROVIDER = "spontra";
/** DeepSeek's window; Pi compacts the session before a request would outgrow it. */
const CONTEXT_WINDOW = 128_000;
/** The output limit of one turn: a whole report draft goes out as one tool call, so it is the report model's limit. */
const TURN_TOKENS = SEC_MODEL_OUTPUT_TOKENS;

type ModelEnv = { DEEPSEEK_API_KEY?: string; PI_MODEL_BASE_URL?: string; PI_ACTIVE_MODEL?: string };

/**
 * The models a session may run on, all on DeepSeek's Chat Completions API. `PI_MODEL_BASE_URL` points them elsewhere
 * for local checks only. The catalog entry already speaks that API, keeps reasoning content across tool rounds, and
 * maps a thinking level onto `thinking` and `reasoning_effort` from the Agent SDK catalog for that id. The window, output limit and ids are ours.
 */
export function piModels(env: ModelEnv, ids: readonly string[], endpoints: readonly StoredEndpoint[] = []) {
  const registry = createModels();
  installPiModels(registry, env, ids, endpoints);
  return registry;
}

/** Replaces the provider on an open registry so a model saved in the admin is usable without restarting the object. */
export function installPiModels(registry: ReturnType<typeof createModels>, env: ModelEnv, ids: readonly string[], endpoints: readonly StoredEndpoint[] = []) {
  const catalog = deepseekProvider().getModels();
  const fallback = catalog.find((model) => model.id === SEC_FALLBACK_MODEL) ?? catalog[0]!;
  const connected = new Map(endpoints.map((endpoint) => [endpoint.name, endpoint]));
  const models: Model<"openai-completions">[] = [...new Set([...ids, SEC_FALLBACK_MODEL, ...endpoints.map((endpoint) => endpoint.name)])].map((id) => {
    const endpoint = connected.get(id);
    const template = catalog.find((model) => model.id === id) ?? fallback;
    const baseUrl = endpoint?.url || env.PI_MODEL_BASE_URL || DEEPSEEK_BASE_URL;
    return {
      ...template, id, name: id, provider: PI_PROVIDER, baseUrl,
      reasoning: true, contextWindow: CONTEXT_WINDOW, maxTokens: TURN_TOKENS,
      thinkingLevelMap: endpoint ? fixedThinkingMap(endpoint.thinkingLevel) : reasoningMap(id),
      compat: { ...template.compat, supportsReasoningEffort: true },
      // Spend is recorded in the ai_usage ledger from each reply's usage, not priced by pi.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  });
  registry.setProvider(createProvider({
    id: PI_PROVIDER, name: "DeepSeek", baseUrl: env.PI_MODEL_BASE_URL || DEEPSEEK_BASE_URL,
    auth: { apiKey: { name: "DeepSeek API key", resolve: async () => {
      const active = connected.get(env.PI_ACTIVE_MODEL ?? "");
      const apiKey = active?.apiKey || env.DEEPSEEK_API_KEY;
      const baseUrl = active?.url || env.PI_MODEL_BASE_URL || DEEPSEEK_BASE_URL;
      return apiKey ? { auth: { apiKey, baseUrl } } : undefined;
    } } },
    models, api: openAICompletionsApi(),
  }));
}

export { piThinkingLevel } from "./reasoning.ts";

/** Every model the admin may pick for a tool, and the deployment's own; a session can switch to any of them. */
export function piModelIds(env: { SEC_ANALYSIS_MODEL?: string; SEC_REASONING_MODEL?: string }): string[] {
  return [...new Set([env.SEC_ANALYSIS_MODEL || SEC_FALLBACK_MODEL, ...(env.SEC_REASONING_MODEL ? [env.SEC_REASONING_MODEL] : []), ...AI_MODELS])];
}
