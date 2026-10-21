-- The sequence number of the newest envelope (by its own time) that carried one, of any type,
-- and that envelope's time. last_seq is the highest ever seen, which qkt's per-session sequences
-- (restarting each session, 0 on state/log envelopes) freeze at an old run's peak; it stays as
-- the ingest ack's answer.
ALTER TABLE instances ADD COLUMN latest_seq INTEGER;
ALTER TABLE instances ADD COLUMN latest_seq_ts INTEGER;
-- Seeded from the newest stored event that carried one; the next envelope keeps it current.
UPDATE instances SET
  latest_seq = (SELECT e.seq FROM events e WHERE e.instance_id = instances.id AND e.seq > 0 ORDER BY e.ts DESC, e.seq DESC LIMIT 1),
  latest_seq_ts = (SELECT e.ts FROM events e WHERE e.instance_id = instances.id AND e.seq > 0 ORDER BY e.ts DESC, e.seq DESC LIMIT 1);
