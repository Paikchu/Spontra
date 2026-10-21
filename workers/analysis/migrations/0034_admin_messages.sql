-- The admin's inbox: one row per company, feature and outcome while unread (later runs with the same outcome fold
-- into it and raise `count`), a new row once read. Succeeded rows come from the features' publication events; failed
-- rows from the failed runs, which also switch the company's feature off (generation only; what was written stays
-- shown) so switching it on again is the retry. Rows older than 30 days are deleted on write. Additive only.
CREATE TABLE admin_messages (
 id TEXT PRIMARY KEY,
 ticker TEXT NOT NULL,
 feature TEXT NOT NULL CHECK (feature IN ('reports', 'findings', 'explainer', 'tree')),
 outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
 detail TEXT,
 count INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 read_at TEXT
);
CREATE INDEX admin_messages_updated ON admin_messages(updated_at);
CREATE INDEX admin_messages_feature ON admin_messages(ticker, feature, updated_at);
