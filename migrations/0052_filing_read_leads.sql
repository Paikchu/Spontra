-- The leads a reading raised (§4.10), kept with the passage that raised them, so a second analysis of the same filing
-- opens on them without reading the passage again.
CREATE TABLE filing_read_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  reader_version TEXT NOT NULL,
  question TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL,
  item TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX filing_read_leads_passage ON filing_read_leads(ticker, text_sha256, reader_version);
