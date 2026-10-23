-- Every note the check turned down on the way to a filing's result, with its problems, so a read that took several
-- turns shows why (docs/agent-interpretation-design.md). A filing that prints no published amount in any table reports
-- no quarter; the rows written before that rule read 'unresolved' and are set to 'no-quarter'. Additive only.
ALTER TABLE filing_read_notes ADD COLUMN rejected_json TEXT NOT NULL DEFAULT '[]';
UPDATE filing_read_notes SET status = 'no-quarter'
  WHERE status = 'unresolved' AND note_json IS NULL AND issues_json = '["no table of the filing prints an already published amount"]';
