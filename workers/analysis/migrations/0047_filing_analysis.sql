-- One row per filing the unified analysis path received (docs/filing-analysis-design.md).
CREATE TABLE filing_analyses (
  ticker TEXT NOT NULL,
  accession_number TEXT NOT NULL,
  unit_key TEXT NOT NULL,
  form TEXT NOT NULL,
  filed_at TEXT NOT NULL,
  profile TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  artifact_key TEXT,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (ticker, accession_number)
);
CREATE INDEX filing_analyses_status ON filing_analyses(status, ticker);
CREATE INDEX filing_analyses_unit ON filing_analyses(ticker, unit_key);
CREATE INDEX filing_analyses_run ON filing_analyses(run_id);

-- What the section pass concluded about each section, rolled forward along previous_section_id.
CREATE TABLE filing_section_notes (
  section_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  canonical TEXT NOT NULL,
  status TEXT NOT NULL,
  carried_from TEXT,
  prior TEXT NOT NULL,
  note_json TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX filing_section_notes_document ON filing_section_notes(document_id);
