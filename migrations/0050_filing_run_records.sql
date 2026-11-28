-- What a filing-analysis session did (docs/filing-analysis-optimization.md §4.9): every call of every turn, and one
-- summary row when the session ends. The session's own trail lives in its Durable Object; these rows are the copy an
-- acceptance check and the admin read from D1.
CREATE TABLE filing_run_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  action TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '',
  failed INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX filing_run_turns_run ON filing_run_turns(run_id, id);

CREATE TABLE filing_run_summary (
  run_id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  accession_number TEXT NOT NULL,
  profile TEXT NOT NULL,
  status TEXT NOT NULL,
  -- "agent" when the session called finish itself, "harness" when the harness settled what it left.
  settled_by TEXT,
  started_at TEXT,
  ended_at TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  -- {"read_sections": 12, ...}: calls by tool, compactions and replies without a call included.
  tools TEXT NOT NULL DEFAULT '{}',
  review_rounds INTEGER NOT NULL DEFAULT 0,
  render_rounds INTEGER NOT NULL DEFAULT 0,
  sections_read INTEGER NOT NULL DEFAULT 0,
  chars_read INTEGER NOT NULL DEFAULT 0,
  compactions INTEGER NOT NULL DEFAULT 0,
  blocks INTEGER NOT NULL DEFAULT 0,
  degraded TEXT NOT NULL DEFAULT '[]',
  -- Whatever a later stage adds (evidence entries, leads, reading coverage) without a migration of its own.
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX filing_run_summary_filing ON filing_run_summary(ticker, accession_number, ended_at);
