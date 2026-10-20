import { AI_EFFORTS, AI_MODELS, type AiEffort, type AiModel } from "../../../shared/analysis-contract/ai-models-admin.ts";
import { SEC_FALLBACK_MODEL } from "./retry-policy.ts";

export const REASONING_EFFORTS = AI_EFFORTS;
export type ReasoningEffort = AiEffort;

/**
 * Every AI tool, how hard it thinks by default, and which deployment model it defaults to: `analysis`
 * (`SEC_ANALYSIS_MODEL`) for extraction, `reasoning` (`SEC_REASONING_MODEL`, else the analysis model) for planning,
 * review and writing. The admin's model settings (`ai_tool_settings`) override both per tool. A tool not listed here
 * is not an AI tool.
 */
export const AI_TOOLS = {
  /** Index cards: a gist, verbatim entities and a topic per filing section. */
  "library-cards": { label: "索引卡片", reasoning: "low", model: "analysis" },
  /** Business-map proposals for the cross-company category of each disclosed business. */
  "library-links": { label: "业务归类", reasoning: "high", model: "reasoning" },
  /** The independent second judgment that settles a proposal's category and sections instead of a person. */
  "library-links-review": { label: "业务归类复核", reasoning: "high", model: "reasoning" },
  /** Level-two business tags for each comparable unit, each citing the passages that support it. */
  "business-tags": { label: "业务标签", reasoning: "high", model: "reasoning" },
  /** The independent check that each business tag is supported by the passages it cites. */
  "business-tags-review": { label: "业务标签复核", reasoning: "high", model: "reasoning" },
  "sec-analysis": { label: "财报摘要", reasoning: "high", model: "analysis" },
  memory: { label: "公司记忆", reasoning: "high", model: "analysis" },
  "company-analysis": { label: "公司分析", reasoning: "high", model: "reasoning" },
  guidance: { label: "业绩指引", reasoning: "high", model: "analysis" },
  explainer: { label: "业务解读", reasoning: "high", model: "reasoning" },
  tree: { label: "业务脑图", reasoning: "high", model: "reasoning" },
  findings: { label: "公司要点", reasoning: "high", model: "reasoning" },
  /** The lens agent chooses charts and layout from an already-computed observation. */
  lens: { label: "要点图表", reasoning: "low", model: "reasoning" },
  /** The analyst reads filings and composes the dossier; its harness verifies, so it reasons at the default depth. */
  analyst: { label: "分析师", reasoning: "high", model: "reasoning" },
  /** Which statement line is pretax income and which come after taxes; the harness checks the arithmetic. */
  presentation: { label: "报表结构", reasoning: "low", model: "reasoning" },
  /** Translating published English into Chinese; every translation is checked against its source. */
  translate: { label: "中文翻译", reasoning: "low", model: "analysis" },
  /** Runs one web search or reads one page for the research agents; the agents do the reading. */
  web: { label: "网页检索", reasoning: "low", model: "analysis" },
} as const satisfies Record<string, { label: string; reasoning: ReasoningEffort; model: "analysis" | "reasoning" }>;
export type AiTool = keyof typeof AI_TOOLS;
export const AI_TOOL_NAMES = Object.keys(AI_TOOLS) as AiTool[];

type ModelEnv = { SEC_ANALYSIS_MODEL?: string; SEC_REASONING_MODEL?: string };
type SettingsEnv = { AI_TOOL_SETTINGS?: string; AI_REASONING?: string };
export type AiToolSetting = { model?: AiModel; effort?: ReasoningEffort };

const isModel = (value: unknown): value is AiModel => typeof value === "string" && (AI_MODELS as readonly string[]).includes(value);
const isEffort = (value: unknown): value is ReasoningEffort => typeof value === "string" && (AI_EFFORTS as readonly string[]).includes(value);

/** The admin's stored choices, carried in the environment as `AI_TOOL_SETTINGS` (JSON) by `aiToolEnvironment`. */
export function aiToolSetting(env: SettingsEnv, tool: AiTool): AiToolSetting {
  if (!env.AI_TOOL_SETTINGS) return {};
  try {
    const value = (JSON.parse(env.AI_TOOL_SETTINGS) as Record<string, { model?: unknown; effort?: unknown }>)[tool];
    return { ...(isModel(value?.model) ? { model: value.model } : {}), ...(isEffort(value?.effort) ? { effort: value.effort } : {}) };
  } catch { return {}; }
}

/** The deployment's model for a tool, before the admin's choice. */
export function defaultModelFor(env: ModelEnv, tool: AiTool): string {
  return (AI_TOOLS[tool].model === "reasoning" ? env.SEC_REASONING_MODEL || env.SEC_ANALYSIS_MODEL : env.SEC_ANALYSIS_MODEL) || SEC_FALLBACK_MODEL;
}

/** The model a tool runs on: the admin's choice, else the deployment default. */
export function modelFor(env: ModelEnv & SettingsEnv, tool: AiTool): string {
  return aiToolSetting(env, tool).model ?? defaultModelFor(env, tool);
}

/** The deployment's effort for a tool: `AI_REASONING` (JSON such as {"library-cards":"high"}) over the built-in level. */
export function defaultReasoningFor(env: SettingsEnv, tool: AiTool): ReasoningEffort {
  if (env.AI_REASONING) {
    try {
      const value = (JSON.parse(env.AI_REASONING) as Record<string, unknown>)[tool];
      if (isEffort(value)) return value;
    } catch { /* A malformed override leaves the configured level in place. */ }
  }
  return AI_TOOLS[tool].reasoning;
}

/** A tool's effort: the admin's choice, else the deployment default. */
export function reasoningFor(env: SettingsEnv, tool: AiTool): ReasoningEffort {
  return aiToolSetting(env, tool).effort ?? defaultReasoningFor(env, tool);
}

type Row = { tool: string; model: string | null; effort: string | null };

/**
 * Resolves the admin's model settings into `AI_TOOL_SETTINGS`, once per entry point beside the feature switches. A
 * table not yet migrated, or a value no longer offered, leaves the deployment default in force.
 */
export async function aiToolEnvironment<T extends SettingsEnv & { DB?: D1Database }>(env: T): Promise<T> {
  if (!env.DB) return env;
  const rows = await env.DB.prepare("SELECT tool, model, effort FROM ai_tool_settings").bind().all<Row>().catch(() => null);
  const settings: Record<string, AiToolSetting> = {};
  for (const row of rows?.results ?? []) {
    if (!(row.tool in AI_TOOLS)) continue;
    const setting = { ...(isModel(row.model) ? { model: row.model } : {}), ...(isEffort(row.effort) ? { effort: row.effort } : {}) };
    if (setting.model || setting.effort) settings[row.tool] = setting;
  }
  return { ...env, AI_TOOL_SETTINGS: JSON.stringify(settings) };
}
