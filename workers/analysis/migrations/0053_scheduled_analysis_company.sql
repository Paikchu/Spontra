-- One company's own scheduled-analysis switch, over the project-wide one. No row means the company follows it.
CREATE TABLE scheduled_analysis_company (
  ticker TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);
