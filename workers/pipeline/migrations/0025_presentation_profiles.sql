-- How an issuer's income statement runs from operating income to net income, when neither its calculation linkbase
-- nor its statement rows balanced and a model proposed a structure the harness then verified
-- (docs/statement-bridge-design.md). One row per issuer: `verified` rows are read by every later collection of that
-- issuer; `unresolved` rows record that the filing named by `accession` was judged and failed, so it is not judged again.
-- Additive only.
CREATE TABLE financial_presentation_profiles (
 cik TEXT PRIMARY KEY,
 ticker TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('verified', 'unresolved')),
 structure_json TEXT,
 structure_key TEXT,
 accession TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 issues_json TEXT NOT NULL DEFAULT '[]',
 updated_at TEXT NOT NULL
);
