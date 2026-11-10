-- Fact rows (docs/filing-analysis-optimization.md §4.11): every number a filing shows, one row each, written when the
-- library prepares the document. A tagged number carries the Inline XBRL fact's value, period and unit; an untagged
-- table cell carries what its table states. Reading them is a D1 lookup.
CREATE TABLE sec_fact_rows (
  fact_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  passage_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  row_index INTEGER,
  col_index INTEGER,
  label TEXT NOT NULL,
  concept TEXT,
  dimensions TEXT NOT NULL DEFAULT '',
  period_start TEXT,
  period_end TEXT,
  -- 0 for a balance at a date, the months covered for a flow, NULL when the table does not say.
  period_months INTEGER,
  value REAL NOT NULL,
  shown TEXT NOT NULL,
  unit TEXT NOT NULL,
  tagged INTEGER NOT NULL,
  PRIMARY KEY (document_id, fact_id)
);
CREATE INDEX sec_fact_rows_fact ON sec_fact_rows(fact_id);
CREATE INDEX sec_fact_rows_passage ON sec_fact_rows(passage_id);
CREATE INDEX sec_fact_rows_series ON sec_fact_rows(ticker, concept, dimensions, period_months, period_end);

-- The reading pass of a periodic report (§4.10): which passages were read under which checklist, and the facts the
-- reading recorded from them. Both are keyed by the passage's text, so a paragraph a later filing repeats word for word
-- is not read again and its notes are carried over.
CREATE TABLE filing_read_passages (
  ticker TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  reader_version TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (ticker, text_sha256, reader_version)
);
CREATE TABLE filing_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  reader_version TEXT NOT NULL,
  statement TEXT NOT NULL,
  quote TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX filing_evidence_passage ON filing_evidence(ticker, text_sha256, reader_version);
