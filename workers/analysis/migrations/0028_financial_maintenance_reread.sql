-- One filing read again for the revenue history (admin "重新读取此报告"): action 'reread' with its accession.
-- SQLite cannot widen a CHECK constraint in place, so the table is rebuilt with the same columns, rows and indexes.
CREATE TABLE financial_maintenance_tasks_next (
 task_id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL UNIQUE,
 ticker TEXT NOT NULL,
 cik TEXT,
 action TEXT NOT NULL CHECK(action IN ('extract','analyze','reread')),
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
 completed_at TEXT,
 CHECK(action <> 'reread' OR accession_number IS NOT NULL)
);
INSERT INTO financial_maintenance_tasks_next (task_id,request_id,ticker,cik,action,accession_number,retry_of,status,stage,state_json,issues_json,
 error_code,completed_steps,total_steps,attempt,lease_token,lease_until,next_attempt_at,created_at,updated_at,completed_at)
SELECT task_id,request_id,ticker,cik,action,accession_number,retry_of,status,stage,state_json,issues_json,
 error_code,completed_steps,total_steps,attempt,lease_token,lease_until,next_attempt_at,created_at,updated_at,completed_at
FROM financial_maintenance_tasks;
DROP TABLE financial_maintenance_tasks;
ALTER TABLE financial_maintenance_tasks_next RENAME TO financial_maintenance_tasks;
CREATE UNIQUE INDEX financial_maintenance_active_ticker ON financial_maintenance_tasks(ticker)
 WHERE status IN ('queued','running','cancel_requested');
-- Different share classes still mutate one issuer's CIK-keyed history cursor.
CREATE UNIQUE INDEX financial_maintenance_active_issuer ON financial_maintenance_tasks(cik)
 WHERE cik IS NOT NULL AND status IN ('queued','running','cancel_requested');
CREATE INDEX financial_maintenance_due ON financial_maintenance_tasks(status,next_attempt_at,lease_until);
CREATE INDEX financial_maintenance_ticker_created ON financial_maintenance_tasks(ticker,created_at DESC,task_id DESC);
