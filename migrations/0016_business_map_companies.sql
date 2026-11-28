CREATE TABLE financial_company_settings (
  ticker TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE financial_company_setting_requests (
  request_id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
);

CREATE INDEX financial_collection_ticker_generation ON financial_collection_jobs(ticker,generation DESC);
CREATE INDEX financial_maintenance_ticker_created ON financial_maintenance_tasks(ticker,created_at DESC,task_id DESC);
