-- Reports readers asked the stage for (docs/stage-agent-design.md §6). The body is the whole verified report as JSON
-- (user-report.v1), with the passages it quotes, so it reads the same however the library changes; a revision is a
-- new row pointing at the one it revises. Readable only by the reader who asked, through the stage's gateway.
-- Additive only.
CREATE TABLE user_reports (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT,
  conversation_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  locale TEXT NOT NULL,
  question TEXT NOT NULL,
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX user_reports_ticker ON user_reports(user_id, ticker, created_at);
