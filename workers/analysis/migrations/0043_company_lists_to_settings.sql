-- The deployment's company lists (wrangler vars SEC_DATA_TICKERS, SEC_AI_TICKERS, BUSINESS_TREE_TICKERS and
-- VALUATION_REASSESS_TICKERS) become admin settings. Each company those lists switched on without a stored choice gets
-- that choice written here, so nothing collected, generated or shown changes; a choice already stored is kept. From here
-- on a company is collected, generated or reassessed only where the admin says so.

-- SEC_DATA_TICKERS: the collection whitelist.
INSERT OR IGNORE INTO financial_company_settings (ticker, enabled, updated_at) VALUES
 ('ORCL', 1, '2026-11-02T00:00:00.000Z'), ('NVDA', 1, '2026-11-02T00:00:00.000Z'), ('MSFT', 1, '2026-11-02T00:00:00.000Z'),
 ('AAPL', 1, '2026-11-02T00:00:00.000Z'), ('JPM', 1, '2026-11-02T00:00:00.000Z'), ('BRK.B', 1, '2026-11-02T00:00:00.000Z'),
 ('ADSK', 1, '2026-11-02T00:00:00.000Z'), ('NET', 1, '2026-11-02T00:00:00.000Z'), ('AMZN', 1, '2026-11-02T00:00:00.000Z'),
 ('GOOGL', 1, '2026-11-02T00:00:00.000Z'), ('META', 1, '2026-11-02T00:00:00.000Z');

-- SEC_AI_TICKERS (reports, findings, explainer) and BUSINESS_TREE_TICKERS plus the AI list (tree): the feature switches.
INSERT OR IGNORE INTO business_feature_settings (ticker, feature, generate, display, updated_at) VALUES
 ('ORCL', 'reports', 1, 1, '2026-11-02T00:00:00.000Z'), ('ORCL', 'findings', 1, 1, '2026-11-02T00:00:00.000Z'),
 ('ORCL', 'explainer', 1, 1, '2026-11-02T00:00:00.000Z'), ('ORCL', 'tree', 1, 1, '2026-11-02T00:00:00.000Z'),
 ('MSFT', 'tree', 1, 1, '2026-11-02T00:00:00.000Z'), ('NVDA', 'tree', 1, 1, '2026-11-02T00:00:00.000Z'),
 ('ADSK', 'tree', 1, 1, '2026-11-02T00:00:00.000Z'), ('NET', 'tree', 1, 1, '2026-11-02T00:00:00.000Z');
-- A row whose generation was never chosen followed the default list, which had the company on.
UPDATE business_feature_settings SET generate = 1 WHERE generate IS NULL AND (ticker, feature) IN (
 VALUES ('ORCL', 'reports'), ('ORCL', 'findings'), ('ORCL', 'explainer'), ('ORCL', 'tree'), ('MSFT', 'tree'), ('NVDA', 'tree'), ('ADSK', 'tree'), ('NET', 'tree'));

-- VALUATION_REASSESS_TICKERS: whether a valuation method change alone reassesses the company.
ALTER TABLE valuation_company_inputs ADD COLUMN reassess INTEGER NOT NULL DEFAULT 0 CHECK (reassess IN (0, 1));
INSERT OR IGNORE INTO valuation_company_inputs (ticker, peers_json, targets_json, updated_at) VALUES ('ORCL', NULL, NULL, '2026-11-02T00:00:00.000Z');
UPDATE valuation_company_inputs SET reassess = 1 WHERE ticker = 'ORCL';
