-- Models an admin connects by hand: the name calls use, the Chat Completions address, the key, and the thinking level.
CREATE TABLE ai_endpoints (
  name TEXT PRIMARY KEY,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  thinking_level TEXT NOT NULL CHECK (thinking_level IN ('low', 'medium', 'high', 'xhigh', 'max')),
  updated_at TEXT NOT NULL
);
