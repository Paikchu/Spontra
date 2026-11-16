-- Operator-confirmed critical events: immutable audit receipt and globally idempotent event ID.
-- Apply after 0060_public_research.sql and before enabling the invalidate admin endpoint.
CREATE TABLE IF NOT EXISTS public_research_events (
  event_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL
);
