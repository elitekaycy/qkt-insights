-- The instance's latest silence longer than an outage (OUTAGE_AFTER_MS), as ingest saw it on the
-- collector's clock: silent_from is when it was last heard before, silent_to the earliest moment
-- it is known to have been alive again (the first envelope's own time when qkt replays a journal,
-- else when the collector heard it). The monitor loop turns it into an incident, so an outage the
-- collector slept through (the host was down too) is still recorded.
ALTER TABLE instances ADD COLUMN silent_from INTEGER;
ALTER TABLE instances ADD COLUMN silent_to INTEGER;

-- The exact time of the minute's last check (minute_ts alone says only the minute), so a gap in
-- checking, the collector itself being down, starts at the last check.
ALTER TABLE monitor_minutes ADD COLUMN last_ts INTEGER;
