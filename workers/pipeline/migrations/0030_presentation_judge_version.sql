-- The judge version a filing was judged under (presentation-task.ts PRESENTATION_VERSION): a filing is not judged again
-- under the same version, and a new version judges it once more. NULL for rows judged before this column existed.
-- Additive only.
ALTER TABLE financial_presentation_profiles ADD COLUMN judge_version TEXT;
