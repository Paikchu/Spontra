-- Retire Web Stage, User Valuation Adjustments, By-Person Insider Ledger, Findings/Analyst/Dossier, and Item-Analysis tables & cache junk.
-- Keeps filing-report artifacts, events:v1:* & insider:v1:* (Form 4 event cards), filing-impact:*, sec_memory_*, sec_business_*, and valuation_*.

-- 1. Drop the 8 retired tables (none have incoming foreign keys from retained tables).
DROP TABLE IF EXISTS stage_conversations;
DROP TABLE IF EXISTS stage_settings;
DROP TABLE IF EXISTS user_reports;
DROP TABLE IF EXISTS user_runs;
DROP TABLE IF EXISTS user_budget;
DROP TABLE IF EXISTS user_valuation_adjustments;
DROP TABLE IF EXISTS insider_transactions;
DROP TABLE IF EXISTS insider_persons;

-- 2. Remove retired artifact kinds (keeps 'filing-report').
DELETE FROM analysis_artifact_translations
  WHERE artifact_id LIKE 'dossier:%' OR artifact_id LIKE 'company-analysis:%' OR artifact_id LIKE 'stage-report:%';
DELETE FROM analysis_artifact_checks
  WHERE artifact_id LIKE 'dossier:%' OR artifact_id LIKE 'company-analysis:%' OR artifact_id LIKE 'stage-report:%';
DELETE FROM analysis_artifact_versions
  WHERE artifact_id LIKE 'dossier:%' OR artifact_id LIKE 'company-analysis:%' OR artifact_id LIKE 'stage-report:%';
DELETE FROM analysis_artifacts
  WHERE kind IN ('dossier', 'company-analysis', 'stage-report');

-- 3. Purge retired D1 sec_cache payloads (>22 MB: item-analysis, i18n items/findings, ai-version/ai-run findings/analyst, dossier, checkup, reader-pin).
DELETE FROM sec_cache
  WHERE cache_key LIKE 'item-analysis:%'
     OR cache_key LIKE 'items:%'
     OR cache_key LIKE 'dossier:%'
     OR cache_key LIKE 'findings:%'
     OR cache_key LIKE 'analyst:%'
     OR cache_key LIKE 'checkup:%'
     OR cache_key LIKE 'reader-pin:%'
     OR cache_key LIKE 'ai-version:v1:analyst:%'
     OR cache_key LIKE 'ai-version:v1:findings:%'
     OR cache_key LIKE 'ai-run:v1:analyst:%'
     OR cache_key LIKE 'ai-run:v1:findings:%'
     OR cache_key LIKE 'i18n:v1:zh-CN:item:%'
     OR cache_key LIKE 'i18n:v1:zh-CN:findings:%'
     OR (cache_key LIKE 'pipeline:workflow%' AND (
          cache_key LIKE '%:findings:%'
       OR cache_key LIKE '%:analyst:%'
       OR cache_key LIKE '%:company-analysis:%'
     ));

-- 4. Clean retired metadata and stale queue state.
DELETE FROM business_feature_settings WHERE feature = 'findings';
DELETE FROM admin_messages WHERE feature = 'findings';
DELETE FROM publication_revisions WHERE resource = 'findings';
DELETE FROM feature_budget
  WHERE feature = 'analyst-turns'
     OR feature LIKE 'stage-%'
     OR feature LIKE 'valuation-adjustment%';
DELETE FROM pipeline_due WHERE task IN ('findings', 'analyst', 'company-analysis');
DELETE FROM pipeline_dead;
DELETE FROM pipeline_log WHERE kind IN ('findings', 'analyst', 'company-analysis') OR name IN ('findings', 'analyst', 'company-analysis');
UPDATE pipeline_versions
  SET payload = json_remove(payload, '$.findings', '$.analyst', '$."company-analysis"')
  WHERE json_valid(payload);
