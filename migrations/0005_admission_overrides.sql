-- Empty on migration: an explicitly approved operator lease is activated later
-- using that account's existing user_hash and the actual activation time.
-- This table changes only the rolling admission limit. No usage/history reset.
CREATE TABLE IF NOT EXISTS admission_overrides (
  user_hash TEXT PRIMARY KEY COLLATE BINARY NOT NULL
    CHECK (typeof(user_hash) = 'text' AND length(user_hash) BETWEEN 1 AND 256),
  daily_limit INTEGER NOT NULL
    CHECK (typeof(daily_limit) = 'integer' AND daily_limit BETWEEN 20 AND 91),
  starts_at INTEGER NOT NULL
    CHECK (typeof(starts_at) = 'integer' AND starts_at BETWEEN 0 AND 9007199254740991),
  expires_at INTEGER NOT NULL
    CHECK (typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 9007199254740991),
  CHECK (expires_at > starts_at AND expires_at - starts_at <= 86400000)
);
