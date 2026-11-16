-- Operator source-audited corrections retain the failed/original body and require fresh review.
CREATE TABLE IF NOT EXISTS public_research_revisions (
  report_id TEXT NOT NULL,
  base_version TEXT NOT NULL,
  version TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  PRIMARY KEY (report_id, base_version),
  UNIQUE (report_id, version)
);
