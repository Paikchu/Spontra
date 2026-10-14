/** DeepSeek `reasoning_effort` values: `low`, `high` (the provider's default) and `max`; other names map onto these. */
export const REASONING_EFFORTS = ["low", "high", "max"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

/**
 * How hard each AI tool thinks. Extracting a summary from a passage thinks briefly; analysis and writing
 * think hard. A tool not listed here is not an AI tool.
 */
export const AI_TOOL_REASONING = {
  /** Index cards: a gist, verbatim entities and a topic per filing section. */
  "library-cards": "low",
  /** Business-map proposals for the cross-company category of each disclosed business. */
  "library-links": "high",
  /** The independent second judgment that settles a proposal's category and sections instead of a person. */
  "library-links-review": "high",
  "sec-analysis": "high",
  memory: "high",
  "company-analysis": "high",
  guidance: "high",
  explainer: "high",
  tree: "high",
  findings: "high",
  /** The lens agent chooses charts and layout from an already-computed observation. */
  lens: "low",
  /** The analyst reads filings and composes the dossier; its harness verifies, so it reasons at the default depth. */
  analyst: "high",
} as const satisfies Record<string, ReasoningEffort>;
export type AiTool = keyof typeof AI_TOOL_REASONING;

/** A tool's level; `AI_REASONING` (JSON such as {"library-cards":"high"}) overrides it without a code change. */
export function reasoningFor(env: { AI_REASONING?: string }, tool: AiTool): ReasoningEffort {
  if (env.AI_REASONING) {
    try {
      const value = (JSON.parse(env.AI_REASONING) as Record<string, unknown>)[tool];
      if (typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value)) return value as ReasoningEffort;
    } catch { /* A malformed override leaves the configured level in place. */ }
  }
  return AI_TOOL_REASONING[tool];
}
