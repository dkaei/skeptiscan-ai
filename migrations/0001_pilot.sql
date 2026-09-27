CREATE TABLE IF NOT EXISTS budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  spent_micro INTEGER NOT NULL DEFAULT 0 CHECK (spent_micro >= 0),
  reserved_micro INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro >= 0),
  halted INTEGER NOT NULL DEFAULT 0,
  lookup_count INTEGER NOT NULL DEFAULT 0,
  pricing_version TEXT NOT NULL DEFAULT '2026-09-26-gpt6-standard'
);
INSERT OR IGNORE INTO budget (id) VALUES (1);
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  user_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'waiting', 'complete', 'failed')),
  created_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  reserved_micro INTEGER NOT NULL,
  spent_micro INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0 CHECK (calls BETWEEN 0 AND 3),
  settled_calls INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS checks_user_created ON checks (user_hash, created_at);
CREATE INDEX IF NOT EXISTS checks_state_lease ON checks (state, lease_until);

