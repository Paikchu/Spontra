-- Event-driven pipeline (docs/pipeline-events.md). Every event is written here in the same batch as the data it
-- reports, then sent to the events queue and deleted.
CREATE TABLE pipeline_outbox (
 id TEXT PRIMARY KEY, type TEXT NOT NULL, ticker TEXT NOT NULL, cik TEXT, task TEXT, detail TEXT, cause_id TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX pipeline_outbox_created ON pipeline_outbox(created_at);

-- One pending run per company and task: further triggers push due_at back (never past first_requested_at plus the
-- task's longest wait), and a run that must try again later moves it forward. Deleted when the run finishes.
CREATE TABLE pipeline_due (
 ticker TEXT NOT NULL, task TEXT NOT NULL, due_at TEXT NOT NULL, first_requested_at TEXT NOT NULL, cause_id TEXT,
 PRIMARY KEY (ticker, task)
);

-- Messages that exhausted their retries, kept until replayed or dismissed from the admin.
CREATE TABLE pipeline_dead (
 id TEXT PRIMARY KEY, kind TEXT, name TEXT, ticker TEXT, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);

-- What happened and why: every routed event and every task run, linked by cause_id. Rows older than 30 days are
-- deleted by later writes for the same company.
CREATE TABLE pipeline_log (
 id TEXT PRIMARY KEY, message_id TEXT NOT NULL, cause_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL,
 ticker TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
);
CREATE INDEX pipeline_log_ticker ON pipeline_log(ticker, created_at);
CREATE INDEX pipeline_log_created ON pipeline_log(created_at);

-- The task versions the running code last announced; a newer deployment that changes one re-runs that task.
CREATE TABLE pipeline_versions (
 id TEXT PRIMARY KEY, payload TEXT NOT NULL, deployed_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- Archive objects replaced by a newer copy of the same document, deleted once they are a day old and unreferenced.
CREATE TABLE pipeline_superseded (
 key TEXT PRIMARY KEY, ticker TEXT NOT NULL, superseded_at TEXT NOT NULL
);
CREATE INDEX pipeline_superseded_ticker ON pipeline_superseded(ticker, superseded_at);
