-- Envelopes /ingest acknowledged but could not project: an unknown type, a payload that fails
-- its schema, or an unsupported major `v`. Kept raw (the whole envelope as sent) so a later
-- contract can replay them; keyed by (instance, id) so a redelivered envelope is stored once.
CREATE TABLE IF NOT EXISTS quarantined_events (
  instance_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT,
  v INTEGER,
  ts INTEGER,
  received_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  envelope TEXT NOT NULL,
  PRIMARY KEY (instance_id, id)
);
CREATE INDEX IF NOT EXISTS quarantined_events_received ON quarantined_events (received_at);
