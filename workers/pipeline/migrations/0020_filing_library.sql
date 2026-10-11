-- The filing library (docs/sec-filing-library.md): every archived SEC document split once into sections and
-- verbatim passages, the index cards written for its sections, and the business links that join a company's
-- disclosures across sections. Section and passage ids derive from content. Additive only.
CREATE TABLE sec_documents (
 document_id TEXT PRIMARY KEY, ticker TEXT NOT NULL, cik TEXT NOT NULL DEFAULT '', accession_number TEXT NOT NULL,
 form TEXT NOT NULL, doc_type TEXT NOT NULL, report_date TEXT NOT NULL DEFAULT '', filed_at TEXT NOT NULL DEFAULT '',
 document_url TEXT NOT NULL, source_sha256 TEXT NOT NULL, parser_version TEXT NOT NULL,
 structure TEXT NOT NULL, structure_check TEXT NOT NULL DEFAULT '{"status":"not_applicable","missing":[]}',
 status TEXT NOT NULL, failure_reason TEXT, issues TEXT NOT NULL DEFAULT '[]', previous_document_id TEXT,
 chars INTEGER NOT NULL DEFAULT 0, passages INTEGER NOT NULL DEFAULT 0, sections INTEGER NOT NULL DEFAULT 0,
 prepared_at TEXT NOT NULL
);
CREATE INDEX sec_documents_ticker_form ON sec_documents(ticker, form, filed_at);
CREATE TABLE sec_sections (
 section_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, parent_id TEXT, ordinal INTEGER NOT NULL, depth INTEGER NOT NULL,
 is_leaf INTEGER NOT NULL, canonical TEXT NOT NULL, item_key TEXT, title TEXT NOT NULL, path TEXT NOT NULL, xbrl_block TEXT,
 role TEXT NOT NULL, change TEXT NOT NULL, previous_section_id TEXT, chars INTEGER NOT NULL, text_sha256 TEXT NOT NULL
);
CREATE INDEX sec_sections_document ON sec_sections(document_id, ordinal);
CREATE INDEX sec_sections_canonical ON sec_sections(canonical, role);
CREATE TABLE sec_passages (
 passage_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, section_id TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL,
 text TEXT NOT NULL, table_json TEXT, fact_refs TEXT NOT NULL DEFAULT '[]', chars INTEGER NOT NULL, text_sha256 TEXT NOT NULL,
 change TEXT NOT NULL
);
CREATE INDEX sec_passages_document ON sec_passages(document_id, ordinal);
CREATE INDEX sec_passages_section ON sec_passages(section_id, ordinal);
CREATE TABLE sec_section_cards (
 section_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, ticker TEXT NOT NULL, card_version TEXT NOT NULL, text_sha256 TEXT NOT NULL,
 gist TEXT, entities TEXT NOT NULL DEFAULT '[]', topic TEXT, answers TEXT NOT NULL DEFAULT '[]', metrics TEXT NOT NULL DEFAULT '[]',
 notes TEXT NOT NULL DEFAULT '[]', model TEXT NOT NULL, reasoning TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX sec_section_cards_document ON sec_section_cards(document_id);
CREATE INDEX sec_section_cards_ticker_topic ON sec_section_cards(ticker, topic);
CREATE TABLE sec_business_links (
 ticker TEXT NOT NULL, business_key TEXT NOT NULL, name TEXT NOT NULL, flow_node_id TEXT, xbrl_members TEXT NOT NULL DEFAULT '[]',
 section_ids TEXT NOT NULL DEFAULT '[]', industry_category TEXT, status TEXT NOT NULL, proposed_by TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY (ticker, business_key)
);
CREATE INDEX sec_business_links_category ON sec_business_links(industry_category, status);
