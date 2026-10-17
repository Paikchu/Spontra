-- The admin's business mind map switches. Ticker '*' holds the global generation switch, over BUSINESS_TREE_ENABLED.
-- A company row says whether its tree is generated (over BUSINESS_TREE_TICKERS and the AI list, including an explicit
-- removal) and whether the map shows it. NULL keeps the deployment default. Additive only.
CREATE TABLE business_tree_settings (
 ticker TEXT PRIMARY KEY,
 generate INTEGER CHECK (generate IN (0, 1)),
 display INTEGER CHECK (display IN (0, 1)),
 updated_at TEXT NOT NULL
);
