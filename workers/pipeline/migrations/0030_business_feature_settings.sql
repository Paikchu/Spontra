-- The admin's per-feature switches, one row per company and reader-facing feature (docs/whitelist-feature-switches-design.md):
-- `reports` (SEC report summaries and guidance), `findings` (findings and the analyst), `explainer` (business
-- explanations) and `tree` (the business mind map). Ticker '*' holds a feature's global generation switch, over
-- SEC_AI_ENABLED / BUSINESS_TREE_ENABLED. `generate` NULL keeps the deployment default list; `display` NULL shows.
-- Replaces financial_ai_settings and business_tree_settings, which are backfilled here and kept one release. Additive only.
CREATE TABLE business_feature_settings (
 ticker TEXT NOT NULL,
 feature TEXT NOT NULL CHECK (feature IN ('reports', 'findings', 'explainer', 'tree')),
 generate INTEGER CHECK (generate IN (0, 1)),
 display INTEGER CHECK (display IN (0, 1)),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (ticker, feature)
);
-- The AI switch covered the SEC reports, the findings chain and the explainer.
INSERT INTO business_feature_settings (ticker, feature, generate, display, updated_at)
 SELECT ticker, 'reports', enabled, NULL, updated_at FROM financial_ai_settings;
INSERT INTO business_feature_settings (ticker, feature, generate, display, updated_at)
 SELECT ticker, 'findings', enabled, NULL, updated_at FROM financial_ai_settings;
INSERT INTO business_feature_settings (ticker, feature, generate, display, updated_at)
 SELECT ticker, 'explainer', enabled, NULL, updated_at FROM financial_ai_settings;
INSERT INTO business_feature_settings (ticker, feature, generate, display, updated_at)
 SELECT ticker, 'tree', generate, display, updated_at FROM business_tree_settings;
