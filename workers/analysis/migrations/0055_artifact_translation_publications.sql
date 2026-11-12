-- A later translation/checking attempt must not withdraw an already accepted Chinese publication.
ALTER TABLE analysis_artifact_translations ADD COLUMN published_r2_key TEXT;
ALTER TABLE analysis_artifact_translations ADD COLUMN published_hash TEXT;
ALTER TABLE analysis_artifact_translations ADD COLUMN published_at TEXT;
UPDATE analysis_artifact_translations
SET published_r2_key = r2_key, published_hash = hash, published_at = updated_at
WHERE r2_key IS NOT NULL AND (status = 'ready' OR EXISTS (
  SELECT 1 FROM analysis_artifact_checks c
  WHERE c.artifact_id = analysis_artifact_translations.artifact_id
    AND c.version = analysis_artifact_translations.source_version AND c.stage = 'translation:zh-CN'
    AND json_extract(c.result, '$.translatedHash') = analysis_artifact_translations.hash
    AND json_extract(c.result, '$.sourceHash') = analysis_artifact_translations.source_hash
    AND json_extract(c.result, '$.unavailable') IS NULL
    AND json_array_length(c.result, '$.issues') = 0
    AND COALESCE(json_array_length(c.result, '$.errors'), 0) = 0
));
