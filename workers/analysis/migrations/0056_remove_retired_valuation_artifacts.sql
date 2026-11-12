-- The former valuation-report HTML page has no reader or publisher. The current valuation
-- publication uses its own valuation tables and is unaffected by retiring this artifact kind.
-- R2 objects remain as unreachable archives; removing the D1 pointers removes the old pages
-- and their abandoned translation/preview attempts from the application.
DELETE FROM analysis_artifact_translations WHERE artifact_id LIKE 'valuation-report:%';
DELETE FROM analysis_artifact_checks WHERE artifact_id LIKE 'valuation-report:%';
DELETE FROM analysis_artifact_versions WHERE artifact_id LIKE 'valuation-report:%';
DELETE FROM analysis_artifacts WHERE kind = 'valuation-report';
