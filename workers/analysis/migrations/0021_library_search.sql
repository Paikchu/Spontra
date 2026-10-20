-- The filing library's recall layer (docs/sec-filing-library.md, P5): which sections are uploaded to Cloudflare
-- AI Search, under which item id and for which text, so a sync uploads only what changed and deletes what left the
-- recall scope. AI Search is never the source of truth; D1 keeps the text. Additive only.
CREATE TABLE sec_search_items (
 section_id TEXT PRIMARY KEY, ticker TEXT NOT NULL, document_id TEXT NOT NULL, item_id TEXT,
 content_sha256 TEXT NOT NULL, status TEXT NOT NULL, error TEXT, uploaded_at TEXT NOT NULL
);
CREATE INDEX sec_search_items_ticker ON sec_search_items(ticker);
