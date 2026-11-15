-- Proposal only. Run after the Markdown Worker is deployed and the retired
-- LIBRARY_* runs (and business-tags runs carrying the old contract) have ended.
-- This file is outside migrations and is not applied by analysis:deploy.
-- Schema removal belongs to the separate cleanup migration:
-- sec_documents, sec_sections, sec_passages, sec_section_cards, sec_fact_rows,
-- sec_search_items, sec_business_links, filing_read_passages, filing_evidence,
-- filing_read_leads. Do not drop filing_read_notes or financial publication tables.

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

-- R2 prefix deletion is a separate operation, after new material acceptance:
-- analysis/                 retired SEC analysis plans, discovery chunks and audit data
-- filings/                  retired prepared filing/discovery-cache data
-- earnings-materials/       retired earnings text packs
-- No current source code reads/writes those prefixes; preserve financial-disclosures/,
-- sec-materials/, artifacts/, artifact-translations/, company-analysis/, filing-memory/,
-- filing-semantic-audits/, financial-maintenance-backups/, web-search/ and sec-acceptance/.
-- workflow-results/v1/ is shared by current runs; do not delete it as a whole.
-- Retire the AI Search instance sec-filing-library separately (its old section index).
