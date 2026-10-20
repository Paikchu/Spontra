-- The admin's model settings: the Claude model and effort each AI tool runs with (ai-config.ts). A NULL column follows
-- the deployment default (SEC_ANALYSIS_MODEL / SEC_REASONING_MODEL, the tool's built-in effort). Additive only.
CREATE TABLE ai_tool_settings (
 tool TEXT PRIMARY KEY,
 model TEXT,
 effort TEXT CHECK (effort IS NULL OR effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
 updated_at TEXT NOT NULL
);
