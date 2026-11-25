ALTER TABLE sec_filings ADD COLUMN accepted_at TEXT;
ALTER TABLE sec_filings ADD COLUMN items TEXT NOT NULL DEFAULT '';
