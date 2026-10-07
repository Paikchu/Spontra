CREATE TABLE portfolio_state (
  id TEXT PRIMARY KEY,
  report_date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at TEXT NOT NULL,
  successful_attempt_at TEXT NOT NULL
);

CREATE TABLE portfolio_history (
  date TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  net_liquidation TEXT NOT NULL,
  net_deposits TEXT NOT NULL
);

CREATE TABLE portfolio_sync_attempt (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed'))
);

CREATE TABLE portfolio_migration (
  id TEXT PRIMARY KEY,
  source_digest TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('copied', 'activating', 'active')),
  copied_at TEXT NOT NULL
);
