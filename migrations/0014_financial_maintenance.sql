-- Authenticated, explicit one-off maintenance. Does not change data/AI tracking policy.
CREATE TABLE financial_maintenance_tasks (
 task_id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL UNIQUE,
 ticker TEXT NOT NULL,
 cik TEXT,
 action TEXT NOT NULL CHECK(action IN ('extract','analyze')),
 accession_number TEXT,
 retry_of TEXT,
 status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','partial','failed','cancel_requested','cancelled')),
 stage TEXT NOT NULL DEFAULT 'identify',
 state_json TEXT NOT NULL DEFAULT '{}',
 issues_json TEXT NOT NULL DEFAULT '[]',
 error_code TEXT,
 completed_steps INTEGER NOT NULL DEFAULT 0,
 total_steps INTEGER NOT NULL DEFAULT 4,
 attempt INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 lease_until TEXT,
 next_attempt_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 completed_at TEXT
);
CREATE UNIQUE INDEX financial_maintenance_active_ticker ON financial_maintenance_tasks(ticker)
 WHERE status IN ('queued','running','cancel_requested');
-- Different share classes still mutate one issuer's CIK-keyed history cursor.
CREATE UNIQUE INDEX financial_maintenance_active_issuer ON financial_maintenance_tasks(cik)
 WHERE cik IS NOT NULL AND status IN ('queued','running','cancel_requested');
CREATE INDEX financial_maintenance_due ON financial_maintenance_tasks(status,next_attempt_at,lease_until);
