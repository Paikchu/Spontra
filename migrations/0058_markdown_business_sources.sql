CREATE TABLE business_classifications (
  ticker TEXT NOT NULL,
  business_key TEXT NOT NULL,
  name TEXT NOT NULL,
  flow_node_id TEXT,
  xbrl_members TEXT NOT NULL DEFAULT '[]',
  sources TEXT NOT NULL DEFAULT '[]',
  industry_category TEXT,
  status TEXT NOT NULL,
  review TEXT,
  proposed_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ticker, business_key)
);
CREATE INDEX business_classifications_category ON business_classifications(industry_category, status);
ALTER TABLE sec_business_units ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sec_business_tags ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';
