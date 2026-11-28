-- Analysis artifacts (docs/analysis-html-artifact.md): one HTML document per analysis subject, built block by block,
-- checked and published as an immutable version. The document itself lives in R2; D1 holds the pointers and the record
-- of every check, so the admin can see how each block was settled.
CREATE TABLE analysis_artifacts (
  artifact_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ticker TEXT NOT NULL,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  published_version INTEGER,
  published_hash TEXT,
  published_at TEXT,
  degraded TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE INDEX analysis_artifacts_ticker ON analysis_artifacts(ticker, kind, subject);

CREATE TABLE analysis_artifact_versions (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  hash TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

CREATE TABLE analysis_artifact_checks (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  stage TEXT NOT NULL,
  round INTEGER NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX analysis_artifact_checks_artifact ON analysis_artifact_checks(artifact_id, version);
