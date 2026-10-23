-- Read notes of new filings (docs/agent-interpretation-design.md): where each published line sits in one filing and
-- which period it reports, so the filing is read once. `labels` keeps each placed row's printed label for the next
-- filing to reuse; `route` says how the note was found (reuse, period, full). Additive only.
CREATE TABLE filing_read_notes (
  accession TEXT PRIMARY KEY,
  cik TEXT NOT NULL,
  ticker TEXT NOT NULL,
  form TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('read', 'no-quarter', 'unresolved')),
  period_end TEXT,
  route TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  note_json TEXT,
  labels_json TEXT,
  quarter_json TEXT,
  issues_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE INDEX filing_read_notes_issuer ON filing_read_notes(cik, form, updated_at);
