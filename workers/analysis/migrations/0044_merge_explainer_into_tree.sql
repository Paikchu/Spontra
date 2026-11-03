-- The business explanation and the mind map are one reader-facing feature, `tree` (the map shows them in one panel):
-- the explainer's own switches go, and its past messages move to the tree's inbox. Every company's explainer switch
-- matched its tree switch when they merged, so no company changes what it shows.
DELETE FROM business_feature_settings WHERE feature = 'explainer';
UPDATE admin_messages SET feature = 'tree' WHERE feature = 'explainer';
