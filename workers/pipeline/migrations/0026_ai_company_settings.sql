-- Which companies the AI analysis runs for, chosen in the admin (whitelist page). A row overrides the deployment's
-- SEC_AI_TICKERS default for its company, including an explicit removal, the same way financial_company_settings
-- overrides SEC_DATA_TICKERS. Additive only.
CREATE TABLE financial_ai_settings (
 ticker TEXT PRIMARY KEY,
 enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
 updated_at TEXT NOT NULL
);
