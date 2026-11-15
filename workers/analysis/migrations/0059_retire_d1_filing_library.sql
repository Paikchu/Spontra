-- The Markdown-only Worker is already deployed. Retire the chapter storage.
DROP TABLE sec_section_cards;
DROP TABLE sec_search_items;
DROP TABLE sec_fact_rows;
DROP TABLE sec_passages;
DROP TABLE sec_sections;
DROP TABLE sec_documents;
DROP TABLE sec_business_links;
DROP TABLE filing_read_passages;
DROP TABLE filing_evidence;
DROP TABLE filing_read_leads;

DELETE FROM sec_business_tags WHERE sources = '[]';
DELETE FROM sec_business_units WHERE sources = '[]';
DELETE FROM sec_peer_pairs WHERE left_unit NOT IN (SELECT unit_key FROM sec_business_units)
  OR right_unit NOT IN (SELECT unit_key FROM sec_business_units);
ALTER TABLE sec_business_units DROP COLUMN section_ids;
ALTER TABLE sec_business_tags DROP COLUMN passage_ids;

DELETE FROM ai_tool_settings WHERE tool IN ('library-cards', 'library-links', 'library-links-review');

DELETE FROM pipeline_due
WHERE task IN ('library', 'library-cards', 'library-links', 'library-search');

DELETE FROM pipeline_outbox
WHERE type IN ('library.requested', 'library.prepared', 'library.cards.published',
  'library.links.requested', 'library.links.published')
OR task IN ('library', 'library-cards', 'library-links', 'library-search');

DELETE FROM pipeline_dead
WHERE name IN ('library', 'library-cards', 'library-links', 'library-search',
  'library.requested', 'library.prepared', 'library.cards.published',
  'library.links.requested', 'library.links.published')
OR json_extract(body, '$.task') IN ('library', 'library-cards', 'library-links', 'library-search')
OR json_extract(body, '$.type') IN ('library.requested', 'library.prepared',
  'library.cards.published', 'library.links.requested', 'library.links.published');

DELETE FROM pipeline_log
WHERE name IN ('library', 'library-cards', 'library-links', 'library-search',
  'library.requested', 'library.prepared', 'library.cards.published',
  'library.links.requested', 'library.links.published');

UPDATE pipeline_versions
SET payload = json_remove(payload, '$.library', '$."library-cards"',
  '$."library-links"', '$."library-search"')
WHERE id = 'tasks';

DELETE FROM sec_cache
WHERE cache_key LIKE 'library-cards:%'
OR cache_key LIKE 'library-links:%'
OR cache_key LIKE 'pipeline:workflow:library:%'
OR cache_key LIKE 'pipeline:workflow:library-cards:%'
OR cache_key LIKE 'pipeline:workflow:library-links:%'
OR cache_key LIKE 'pipeline:workflow:library-search:%'
OR cache_key LIKE 'pipeline:workflow-failed:library:%'
OR cache_key LIKE 'pipeline:workflow-failed:library-cards:%'
OR cache_key LIKE 'pipeline:workflow-failed:library-links:%'
OR cache_key LIKE 'pipeline:workflow-failed:library-search:%';


DELETE FROM sec_cache WHERE cache_key = 'storage-sweep:v1:cursor' OR cache_key LIKE 'acceptance:material:prior:%';

DELETE FROM sec_cache WHERE cache_key LIKE 'business-tags:v1:%';

DELETE FROM sec_cache
WHERE cache_key LIKE 'reader-pin:material:%'
  AND json_extract(payload, '$.version') IN (
    SELECT json_extract(payload, '$.ref.version') FROM sec_cache
    WHERE cache_key LIKE 'filing-material:state:v1:%'
      AND json_extract(payload, '$.status') = 'ready'
      AND json_extract(payload, '$.preparationVersion') IN (
        'filing-material.v1:material-parser.v6:source-organizer.v2:sec-directory-union.v1',
        'filing-material.v1:material-parser.v7:source-organizer.v2:sec-directory-union.v1'
      )
  );
DELETE FROM sec_cache
WHERE cache_key LIKE 'filing-material:state:v1:%'
  AND json_extract(payload, '$.status') = 'ready'
  AND json_extract(payload, '$.preparationVersion') IN (
    'filing-material.v1:material-parser.v6:source-organizer.v2:sec-directory-union.v1',
    'filing-material.v1:material-parser.v7:source-organizer.v2:sec-directory-union.v1'
  );
