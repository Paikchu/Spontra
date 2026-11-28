-- The analysis layers (docs/spontra-architecture-upgrade.md): the SEC report feature becomes layer 2, `filings`, which
-- also owns the filing library, memory and item analysis. SQLite cannot change a CHECK in place, so the two feature
-- tables are rebuilt with their rows kept and the old key renamed.
CREATE TABLE business_feature_settings_v3 (
 ticker TEXT NOT NULL,
 feature TEXT NOT NULL CHECK (feature IN ('filings', 'findings', 'tree', 'valuation')),
 generate INTEGER CHECK (generate IN (0, 1)),
 display INTEGER CHECK (display IN (0, 1)),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (ticker, feature)
);
INSERT INTO business_feature_settings_v3 (ticker, feature, generate, display, updated_at)
 SELECT ticker, CASE feature WHEN 'reports' THEN 'filings' ELSE feature END, generate, display, updated_at
 FROM business_feature_settings WHERE feature IN ('reports', 'findings', 'tree', 'valuation');
DROP TABLE business_feature_settings;
ALTER TABLE business_feature_settings_v3 RENAME TO business_feature_settings;

CREATE TABLE admin_messages_v3 (
 id TEXT PRIMARY KEY,
 ticker TEXT NOT NULL,
 feature TEXT NOT NULL CHECK (feature IN ('filings', 'findings', 'tree', 'valuation')),
 outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
 detail TEXT,
 count INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 read_at TEXT
);
INSERT INTO admin_messages_v3 (id, ticker, feature, outcome, detail, count, created_at, updated_at, read_at)
 SELECT id, ticker, CASE feature WHEN 'reports' THEN 'filings' ELSE feature END, outcome, detail, count, created_at, updated_at, read_at
 FROM admin_messages WHERE feature IN ('reports', 'findings', 'tree', 'valuation');
DROP TABLE admin_messages;
ALTER TABLE admin_messages_v3 RENAME TO admin_messages;
CREATE INDEX admin_messages_updated ON admin_messages(updated_at);
CREATE INDEX admin_messages_feature ON admin_messages(ticker, feature, updated_at);

-- The ladder: a layer generates only while the layer below does. Companies switched on above a layer that is off stop
-- generating there; what they already show stays shown (display is kept).
UPDATE business_feature_settings SET display = coalesce(display, generate), generate = 0
 WHERE ticker <> '*' AND feature = 'filings' AND generate = 1
   AND ticker NOT IN (SELECT ticker FROM financial_company_settings WHERE enabled = 1);
UPDATE business_feature_settings SET display = coalesce(display, generate), generate = 0
 WHERE ticker <> '*' AND feature = 'findings' AND generate = 1
   AND ticker NOT IN (SELECT ticker FROM business_feature_settings WHERE feature = 'filings' AND generate = 1);
UPDATE business_feature_settings SET display = coalesce(display, generate), generate = 0
 WHERE ticker <> '*' AND feature = 'tree' AND generate = 1
   AND ticker NOT IN (SELECT ticker FROM business_feature_settings WHERE feature = 'findings' AND generate = 1);
UPDATE business_feature_settings SET display = coalesce(display, generate), generate = 0
 WHERE ticker <> '*' AND feature = 'valuation' AND generate = 1
   AND ticker NOT IN (SELECT ticker FROM business_feature_settings WHERE feature = 'tree' AND generate = 1);
