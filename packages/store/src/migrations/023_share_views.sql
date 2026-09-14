-- One row per page view on a shared link. No IP address is stored: `visitor` is a hash of the
-- client with a salt that changes every UTC day, so it counts unique visitors within a day
-- and cannot be linked across days once the salt is gone.
CREATE TABLE IF NOT EXISTS share_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  page TEXT NOT NULL,
  strategy_id TEXT,
  visitor TEXT NOT NULL,
  browser TEXT,
  os TEXT,
  device TEXT,
  country TEXT,
  referrer TEXT,
  language TEXT
);
CREATE INDEX IF NOT EXISTS share_views_instance_ts ON share_views (instance_id, ts);
CREATE INDEX IF NOT EXISTS share_views_dedupe ON share_views (visitor, kind, subject, page, ts);

CREATE TABLE IF NOT EXISTS view_salts (
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);
