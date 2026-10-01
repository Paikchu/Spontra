-- Independent deterministic collection; existing analysis and account tables are untouched.
CREATE TABLE IF NOT EXISTS financial_collection_jobs (
 job_id TEXT PRIMARY KEY, cik TEXT NOT NULL, ticker TEXT NOT NULL,
 generation INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','retry','succeeded','unavailable')),
 cursor_json TEXT NOT NULL DEFAULT '{}', attempt INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT, lease_until TEXT, next_attempt_at TEXT NOT NULL, reasons_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
 UNIQUE(cik,generation)
);
CREATE INDEX IF NOT EXISTS financial_job_due ON financial_collection_jobs(status,next_attempt_at,lease_until);
CREATE TABLE IF NOT EXISTS financial_staged_quarters (
 job_id TEXT NOT NULL, period_end TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(job_id,period_end)
);
CREATE TABLE IF NOT EXISTS financial_complete_versions (
 version_id TEXT PRIMARY KEY, cik TEXT NOT NULL, ticker TEXT NOT NULL, generation INTEGER NOT NULL,
 payload_json TEXT NOT NULL, published_at TEXT NOT NULL, UNIQUE(cik,generation)
);
CREATE TABLE IF NOT EXISTS financial_complete_current (
 cik TEXT PRIMARY KEY, version_id TEXT NOT NULL, generation INTEGER NOT NULL
);
