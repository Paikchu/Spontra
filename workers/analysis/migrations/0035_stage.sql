-- The stage (docs/stage-agent-design.md §3.2): reader conversations registered before any StageAgent exists for them,
-- per-reader daily allowances keyed by an anonymous id or a hashed address, the runs a reader started, and which
-- reader and conversation a model call served. A reader id is stored only as given by the gateway (`anon:<id>` or
-- `ip:<sha256>`); ai_usage stores its sha256 alone. Additive only; the two ai_usage columns cannot be dropped again.
CREATE TABLE stage_conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  locale TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX stage_conversations_user ON stage_conversations(user_id, last_at);
CREATE INDEX stage_conversations_last ON stage_conversations(last_at);

CREATE TABLE user_budget (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, feature)
);

CREATE TABLE user_runs (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ticker TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  business_key TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT,
  error TEXT,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, business_key)
);
CREATE INDEX user_runs_active ON user_runs(user_id, status);
CREATE INDEX user_runs_started ON user_runs(started_at);

ALTER TABLE ai_usage ADD COLUMN user_hash TEXT;
ALTER TABLE ai_usage ADD COLUMN conversation_id TEXT;
CREATE INDEX ai_usage_user ON ai_usage(user_hash, at);
