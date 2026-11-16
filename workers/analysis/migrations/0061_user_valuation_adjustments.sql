-- Private hypothetical sensitivities; never replace reviewed valuation publications.
CREATE TABLE IF NOT EXISTS user_valuation_adjustments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  base_version_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  body_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS user_valuation_adjustments_owner ON user_valuation_adjustments(user_id, ticker, created_at DESC);
