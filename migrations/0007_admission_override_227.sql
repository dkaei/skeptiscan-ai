-- Expand the bounded lease schema only. Copy every current allowance and its
-- original activation/expiry exactly; do not activate, raise or renew a lease.
-- The separately approved update must use the same existing operator user_hash.
-- Checks, spending, reservations and all ancillary counters remain untouched.
CREATE TABLE admission_overrides_227 (
  user_hash TEXT PRIMARY KEY COLLATE BINARY NOT NULL
    CHECK (typeof(user_hash) = 'text' AND length(user_hash) BETWEEN 1 AND 256),
  daily_limit INTEGER NOT NULL
    CHECK (typeof(daily_limit) = 'integer' AND daily_limit BETWEEN 20 AND 227),
  starts_at INTEGER NOT NULL
    CHECK (typeof(starts_at) = 'integer' AND starts_at BETWEEN 0 AND 9007199254740991),
  expires_at INTEGER NOT NULL
    CHECK (typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 9007199254740991),
  CHECK (expires_at > starts_at AND expires_at - starts_at <= 86400000)
);

INSERT INTO admission_overrides_227 (user_hash, daily_limit, starts_at, expires_at)
  SELECT user_hash, daily_limit, starts_at, expires_at FROM admission_overrides;
DROP TABLE admission_overrides;
ALTER TABLE admission_overrides_227 RENAME TO admission_overrides;
