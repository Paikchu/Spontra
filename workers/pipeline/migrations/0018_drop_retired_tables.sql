-- Tables whose writers have been removed and that nothing reads: the autonomous research feature
-- (0012), the pre-migration analysis module snapshots (0002) and the never-populated Yahoo chart
-- spec / company profile tables (0007). Their indexes drop with them.
DROP TABLE IF EXISTS research_budget;
DROP TABLE IF EXISTS research_cases;
DROP TABLE IF EXISTS research_events;
DROP TABLE IF EXISTS research_followups;
DROP TABLE IF EXISTS research_reports;
DROP TABLE IF EXISTS research_state;
DROP TABLE IF EXISTS sec_module_snapshots;
DROP TABLE IF EXISTS fundamental_chart_specs;
DROP TABLE IF EXISTS fundamental_company_profiles;

-- Write-only audit ledgers that nothing read: published reports carry their own evidence quotes,
-- comparisons live inside the report payload, memory changes are visible on sec_memory_items, and
-- usage caps are enforced by feature_budget. Their writers go in the same change.
DROP TABLE IF EXISTS sec_filing_blocks;
DROP TABLE IF EXISTS sec_evidence;
DROP TABLE IF EXISTS sec_comparisons;
DROP TABLE IF EXISTS sec_memory_extractions;
DROP TABLE IF EXISTS sec_memory_events;
DROP TABLE IF EXISTS fundamental_observation_revisions;
DROP TABLE IF EXISTS ai_usage_log;
