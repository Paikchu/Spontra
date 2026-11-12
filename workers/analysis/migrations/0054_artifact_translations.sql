-- Each translation belongs to one immutable source version. Publishing a translation never changes the source pointer.
CREATE TABLE analysis_artifact_translations (
  artifact_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale = 'zh-CN'),
  translator_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('translating', 'checking', 'ready', 'failed')),
  completed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  hash TEXT,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, source_version, locale)
);
