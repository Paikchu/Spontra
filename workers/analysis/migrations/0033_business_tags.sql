-- Two-level business tags and the peers they lead to (docs/peer-similarity-design.md). A unit is one disclosed revenue
-- node of a company with the business links under it; its sector tags are its links' verified categories. Business
-- tags are written under one sector and cite the passages that support them; their vectors live in the Vectorize
-- index `business-tags`. A pair is two units of different companies sharing a sector, with each facet's best match and
-- the tier they give. Additive only.
CREATE TABLE sec_business_units (
  unit_key TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  flow_node_id TEXT NOT NULL,
  name TEXT NOT NULL,
  link_keys TEXT NOT NULL DEFAULT '[]',
  sectors TEXT NOT NULL DEFAULT '[]',
  section_ids TEXT NOT NULL DEFAULT '[]',
  fingerprint TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sec_business_units_ticker ON sec_business_units(ticker);

CREATE TABLE sec_business_tags (
  tag_id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  unit_key TEXT NOT NULL,
  sector TEXT NOT NULL,
  facet TEXT NOT NULL,
  label TEXT NOT NULL,
  label_zh TEXT NOT NULL,
  definition TEXT NOT NULL,
  passage_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sec_business_tags_unit ON sec_business_tags(ticker, unit_key);
CREATE INDEX sec_business_tags_sector ON sec_business_tags(sector, facet);

CREATE TABLE sec_peer_pairs (
  pair_key TEXT PRIMARY KEY,
  left_unit TEXT NOT NULL,
  right_unit TEXT NOT NULL,
  left_ticker TEXT NOT NULL,
  right_ticker TEXT NOT NULL,
  sectors TEXT NOT NULL,
  tier TEXT NOT NULL,
  tier_sector TEXT NOT NULL,
  matched_tier TEXT NOT NULL,
  status TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sec_peer_pairs_left ON sec_peer_pairs(left_ticker);
CREATE INDEX sec_peer_pairs_right ON sec_peer_pairs(right_ticker);
