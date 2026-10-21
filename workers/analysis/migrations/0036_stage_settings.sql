-- The stage's switch and company list (docs/stage-agent-design.md §3.4), set from the admin so turning the stage off
-- needs no deploy. Ticker '*' is the global switch; a company's row adds it to or removes it from the default list
-- (the AI list). business_feature_settings cannot hold it: its feature column is checked against the four map
-- features. Additive only.
CREATE TABLE stage_settings (
  ticker TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);
