-- Private transcript library and durable backfill queue, one record per reported fiscal period.
CREATE TABLE company_transcripts (
 id TEXT PRIMARY KEY, ticker TEXT NOT NULL, period_end TEXT NOT NULL,
 accession TEXT NOT NULL, form TEXT NOT NULL, filing_url TEXT NOT NULL, filed_at TEXT NOT NULL, raw_key TEXT NOT NULL,
 fiscal_year INTEGER, fiscal_quarter INTEGER,
 status TEXT NOT NULL DEFAULT 'queued', title TEXT, source_url TEXT, content TEXT,
 characters INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, next_attempt_at TEXT NOT NULL, lease_until TEXT,
 fetched_at TEXT, updated_at TEXT NOT NULL,
 UNIQUE(ticker,period_end)
);
CREATE INDEX company_transcripts_queue ON company_transcripts(status,next_attempt_at);
