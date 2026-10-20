-- Forward guidance from earnings releases, decks and call transcripts. Only additions; no existing rows change.

-- One row per earnings release (8-K Item 2.02). The sweep inserts, the Workflow advances.
CREATE TABLE IF NOT EXISTS earnings_events (
 ticker TEXT NOT NULL,
 accession TEXT NOT NULL,
 event_date TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','started','extracted','complete','failed')),
 workflow_instance_id TEXT,
 transcript_status TEXT NOT NULL DEFAULT 'pending' CHECK(transcript_status IN ('pending','extracted','unavailable','not_configured')),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (ticker, accession)
);
CREATE INDEX IF NOT EXISTS earnings_events_status ON earnings_events(status, event_date);

-- Every document read for an event. id is the SHA-256 of the normalized text, so identical content is
-- stored and extracted once however many times or places it is found.
CREATE TABLE IF NOT EXISTS earnings_materials (
 id TEXT PRIMARY KEY,
 ticker TEXT NOT NULL,
 event_accession TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('press_release','shareholder_letter','deck','transcript')),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('sec','transcript_api','ir')),
 title TEXT NOT NULL,
 source_url TEXT NOT NULL,
 published_at TEXT NOT NULL,
 text_key TEXT,
 characters INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL CHECK(status IN ('stored','extracted','unsupported','failed')),
 error TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS earnings_materials_event ON earnings_materials(ticker, event_accession);

-- The model-call cache: one row per material and extractor version. Raising the version is the only
-- way the same text is sent to the model again.
CREATE TABLE IF NOT EXISTS guidance_extractions (
 material_id TEXT NOT NULL,
 extractor_version TEXT NOT NULL,
 model TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('ok','empty','failed')),
 model_calls INTEGER NOT NULL,
 input_characters INTEGER NOT NULL,
 accepted INTEGER NOT NULL,
 rejected INTEGER NOT NULL,
 result_key TEXT,
 created_at TEXT NOT NULL,
 PRIMARY KEY (material_id, extractor_version)
);

-- Verified items exactly as extracted; consolidation into the public view happens at publish time.
CREATE TABLE IF NOT EXISTS guidance_items (
 id TEXT PRIMARY KEY,
 ticker TEXT NOT NULL,
 material_id TEXT NOT NULL,
 extractor_version TEXT NOT NULL,
 event_accession TEXT NOT NULL,
 event_date TEXT NOT NULL,
 payload TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS guidance_items_ticker ON guidance_items(ticker, event_date);
CREATE INDEX IF NOT EXISTS guidance_items_material ON guidance_items(material_id, extractor_version);

-- Daily usage per feature. Token counts are what the provider reported; cached_tokens is the
-- prompt-cache hit portion of input_tokens.
CREATE TABLE IF NOT EXISTS ai_usage_log (
 day TEXT NOT NULL,
 feature TEXT NOT NULL,
 provider TEXT NOT NULL,
 model TEXT NOT NULL,
 calls INTEGER NOT NULL DEFAULT 0,
 input_tokens INTEGER NOT NULL DEFAULT 0,
 cached_tokens INTEGER NOT NULL DEFAULT 0,
 output_tokens INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (day, feature, provider, model)
);

-- Hard daily caps, reserved before each paid call.
CREATE TABLE IF NOT EXISTS feature_budget (
 day TEXT NOT NULL,
 feature TEXT NOT NULL,
 units INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (day, feature)
);
