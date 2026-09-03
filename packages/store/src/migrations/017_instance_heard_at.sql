-- When the collector last received anything from the instance, by the collector's own
-- clock. last_seen is the newest envelope timestamp, i.e. the instance's clock: a VPS
-- running 90s slow would read as silent forever if liveness were judged from it.
ALTER TABLE instances ADD COLUMN heard_at INTEGER;
UPDATE instances SET heard_at = last_seen;
