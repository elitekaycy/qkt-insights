-- Latest health snapshot per instance. `insights.health` arrives every 30s from every
-- qkt instance and only the newest row is ever read; storing each one as a full,
-- FTS-indexed event was the single largest events-table writer.
CREATE TABLE IF NOT EXISTS instance_health (
  instance_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL
);

INSERT OR REPLACE INTO instance_health (instance_id, ts, seq, payload)
SELECT e.instance_id, e.ts, e.seq, e.payload
FROM events e
WHERE e.type = 'insights.health'
  AND e.rowid = (
    SELECT rowid FROM events x
    WHERE x.instance_id = e.instance_id AND x.type = 'insights.health'
    ORDER BY x.ts DESC LIMIT 1
  );

DELETE FROM events_fts WHERE event_rowid IN (SELECT rowid FROM events WHERE type = 'insights.health');
DELETE FROM events WHERE type = 'insights.health';

-- Excursion analytics walk valuations per ticket; the lookup index led on strategy_id.
CREATE INDEX IF NOT EXISTS idx_position_valuations_ticket
  ON position_valuations (instance_id, ticket, ts);
