-- The filing path is one self-publishing Pi session per filing (docs/filing-analysis-design.md, section 15).
-- Sessions left running by the earlier path never end; they go back to the start.
UPDATE filing_analyses SET status = 'registered', reason = NULL WHERE status = 'running' AND updated_at < '2026-11-09T10:25:00Z';
DELETE FROM filing_analyses WHERE profile = 'record-only';
UPDATE filing_analyses SET status = 'failed' WHERE status IN ('recorded', 'withheld');
DROP INDEX filing_analyses_unit;
ALTER TABLE filing_analyses DROP COLUMN unit_key;
ALTER TABLE filing_analyses DROP COLUMN profile_version;
ALTER TABLE filing_analyses DROP COLUMN attempts;
ALTER TABLE filing_analyses DROP COLUMN revision;
ALTER TABLE filing_analyses DROP COLUMN artifact_key;
DROP TABLE filing_section_notes;
