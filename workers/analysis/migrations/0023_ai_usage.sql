-- The cost ledger for model calls (docs/analyst-agent-design.md, 前置数据工作 4): one row per provider request,
-- successful or not, with the token usage the provider reported. `kind` is the feature that made the call
-- (findings, lens, tree, explainer, guidance, sec-analysis, ...), `run_id` the Workflow instance when known.
-- `feature_budget` (0015) keeps its daily caps unchanged; this table is the record, not the gate. Additive only.
CREATE TABLE ai_usage (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 at TEXT NOT NULL,
 ticker TEXT,
 kind TEXT NOT NULL,
 run_id TEXT,
 stage TEXT NOT NULL,
 provider TEXT NOT NULL,
 model TEXT NOT NULL,
 reasoning TEXT,
 input_tokens INTEGER NOT NULL DEFAULT 0,
 cached_tokens INTEGER NOT NULL DEFAULT 0,
 output_tokens INTEGER NOT NULL DEFAULT 0,
 reasoning_tokens INTEGER,
 duration_ms INTEGER NOT NULL DEFAULT 0,
 outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'timeout')),
 search_calls INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ai_usage_ticker_at ON ai_usage(ticker, at);
CREATE INDEX ai_usage_kind_at ON ai_usage(kind, at);
