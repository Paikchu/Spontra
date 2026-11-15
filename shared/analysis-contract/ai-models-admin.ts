/**
 * The admin's model settings: which DeepSeek model and effort each AI tool of Spontra Analysis uses. A tool without a stored
 * choice follows the deployment default (`SEC_ANALYSIS_MODEL` / `SEC_REASONING_MODEL` and the tool's built-in effort).
 */
export const AI_MODELS = ["deepseek-flash", "deepseek-v4-pro"] as const;
export type AiModel = typeof AI_MODELS[number];
/** A requested thinking level. The model config turns it into that model's own `reasoning_effort`. */
export const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AiEffort = typeof AI_EFFORTS[number];

export type AiToolModelRow = {
  tool: string;
  label: string;
  /** What the tool runs on with no stored choice. */
  defaultModel: string;
  defaultEffort: AiEffort;
  /** The stored choice; null follows the default. A connected model's name is allowed. */
  model: string | null;
  effort: AiEffort | null;
  updatedAt: string | null;
};
export type AiModelSettings = { tools: AiToolModelRow[]; models: readonly AiModel[]; efforts: readonly AiEffort[]; endpoints: AiEndpoint[] };
export type AiToolModelUpdate = { model: string | null; effort: AiEffort | null };
/** A model connected from the admin. The key itself is never sent back. */
export type AiEndpoint = { name: string; url: string; thinkingLevel: AiEffort; keyHint: string; updatedAt: string };
export type AiEndpointInput = { name: string; url: string; apiKey: string; thinkingLevel: AiEffort };
