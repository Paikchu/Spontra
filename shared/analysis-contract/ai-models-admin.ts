/**
 * The admin's model settings: which Claude model and effort each AI tool of the pipeline uses. A tool without a stored
 * choice follows the deployment default (`SEC_ANALYSIS_MODEL` / `SEC_REASONING_MODEL` and the tool's built-in effort).
 */
export const AI_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"] as const;
export type AiModel = typeof AI_MODELS[number];
/** Claude `output_config.effort`; thinking is adaptive and effort sets how deep it goes. */
export const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AiEffort = typeof AI_EFFORTS[number];

export type AiToolModelRow = {
  tool: string;
  label: string;
  /** What the tool runs on with no stored choice. */
  defaultModel: string;
  defaultEffort: AiEffort;
  /** The stored choice; null follows the default. */
  model: AiModel | null;
  effort: AiEffort | null;
  updatedAt: string | null;
};
export type AiModelSettings = { tools: AiToolModelRow[]; models: readonly AiModel[]; efforts: readonly AiEffort[] };
export type AiToolModelUpdate = { model: AiModel | null; effort: AiEffort | null };
