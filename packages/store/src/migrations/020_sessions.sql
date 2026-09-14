-- Admin sessions. The cookie carries a random token; only its SHA-256 is stored, so a
-- copied database cannot be replayed as a login.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at);
