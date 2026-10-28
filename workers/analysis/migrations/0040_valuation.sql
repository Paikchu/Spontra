-- The valuation assessment (docs/valuation-assessment-design.md, docs/valuation-assessment-implementation.md §7): a fifth
-- reader-facing feature switch, its admin inbox rows, and its own immutable report versions, current pointer and evidence
-- snapshots. SQLite cannot widen a CHECK in place, so the two feature tables are rebuilt with their rows kept.
CREATE TABLE business_feature_settings_v2 (
 ticker TEXT NOT NULL,
 feature TEXT NOT NULL CHECK (feature IN ('reports', 'findings', 'explainer', 'tree', 'valuation')),
 generate INTEGER CHECK (generate IN (0, 1)),
 display INTEGER CHECK (display IN (0, 1)),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (ticker, feature)
);
INSERT INTO business_feature_settings_v2 (ticker, feature, generate, display, updated_at)
 SELECT ticker, feature, generate, display, updated_at FROM business_feature_settings;
DROP TABLE business_feature_settings;
ALTER TABLE business_feature_settings_v2 RENAME TO business_feature_settings;

CREATE TABLE admin_messages_v2 (
 id TEXT PRIMARY KEY,
 ticker TEXT NOT NULL,
 feature TEXT NOT NULL CHECK (feature IN ('reports', 'findings', 'explainer', 'tree', 'valuation')),
 outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
 detail TEXT,
 count INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 read_at TEXT
);
INSERT INTO admin_messages_v2 (id, ticker, feature, outcome, detail, count, created_at, updated_at, read_at)
 SELECT id, ticker, feature, outcome, detail, count, created_at, updated_at, read_at FROM admin_messages;
DROP TABLE admin_messages;
ALTER TABLE admin_messages_v2 RENAME TO admin_messages;
CREATE INDEX admin_messages_updated ON admin_messages(updated_at);
CREATE INDEX admin_messages_feature ON admin_messages(ticker, feature, updated_at);

-- One immutable report per content hash; a run that only differs in its timestamp writes no new version.
CREATE TABLE valuation_versions (
 version_id TEXT PRIMARY KEY,
 ticker TEXT NOT NULL,
 cik TEXT,
 generated_at TEXT NOT NULL,
 research_as_of TEXT NOT NULL,
 report_status TEXT NOT NULL CHECK (report_status IN ('ready', 'insufficient')),
 method_version TEXT NOT NULL,
 calculator_version TEXT NOT NULL,
 base_input_fingerprint TEXT NOT NULL,
 evidence_set_hash TEXT NOT NULL,
 payload_json TEXT NOT NULL
);
CREATE INDEX valuation_versions_ticker ON valuation_versions(ticker, generated_at DESC, version_id);

-- The version readers see, the newest attempt's summary (kept apart from the pruned AI run log), and the generation a
-- run must still hold to publish: it moves on every new input, explicit reassessment or switch change.
CREATE TABLE valuation_current (
 ticker TEXT PRIMARY KEY,
 version_id TEXT REFERENCES valuation_versions(version_id),
 latest_attempt_json TEXT,
 request_generation INTEGER NOT NULL DEFAULT 0,
 -- The base-input fingerprint of the last completed run, ready or insufficient, so the same input is not researched twice.
 last_fingerprint TEXT,
 updated_at TEXT NOT NULL
);

-- The source snapshots reports cite: identified by source identity plus content hash, so a page that changes or a
-- passage re-split later never rewrites what a published report quoted.
CREATE TABLE valuation_evidence (
 evidence_id TEXT PRIMARY KEY,
 ticker TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK (source_kind IN ('sec', 'web', 'fact')),
 source_url TEXT,
 document_id TEXT,
 passage_id TEXT,
 content_sha256 TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE valuation_version_evidence (
 version_id TEXT NOT NULL REFERENCES valuation_versions(version_id),
 evidence_id TEXT NOT NULL REFERENCES valuation_evidence(evidence_id),
 PRIMARY KEY (version_id, evidence_id)
);
CREATE INDEX valuation_version_evidence_evidence ON valuation_version_evidence(evidence_id);
