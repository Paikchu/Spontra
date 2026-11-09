-- The admin's project-wide switch for analysis nobody asked for. No row means on.
CREATE TABLE scheduled_analysis_setting (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);

-- When a queued run reached its turn while the switch was off; it runs once the switch is on again.
ALTER TABLE pipeline_due ADD COLUMN held_at TEXT;
