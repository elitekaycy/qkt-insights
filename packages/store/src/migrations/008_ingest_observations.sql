CREATE TABLE IF NOT EXISTS ingest_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_id TEXT,
  type TEXT,
  seq INTEGER,
  previous_seq INTEGER,
  expected_seq INTEGER,
  ts INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_ingest_observations_lookup ON ingest_observations (instance_id, kind, ts);
