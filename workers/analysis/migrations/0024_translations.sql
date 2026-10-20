-- Translation memory (docs/i18n-design.md, phase 2): one row per English string and locale, keyed by the string's
-- SHA-256. A string is translated once and reused by every publication that carries it; `rejected` records a
-- translation that failed its checks so the same text is not paid for again until the translator version changes.
-- The per-resource tables the read API applies are built from these rows into sec_cache. Additive only.
CREATE TABLE i18n_strings (
 locale TEXT NOT NULL,
 source_sha256 TEXT NOT NULL,
 source TEXT NOT NULL,
 text TEXT,
 status TEXT NOT NULL CHECK (status IN ('ready', 'rejected')),
 problems TEXT,
 version TEXT NOT NULL,
 model TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY (locale, source_sha256)
);
