-- Uptime monitoring. A monitor is up or down; only transitions are stored as events,
-- so the table is the incident timeline and the alert trigger in one. Per-minute
-- rollups back the uptime strip and percentages: a minute with no row is unknown
-- (the collector was not checking), never up.
CREATE TABLE IF NOT EXISTS monitor_events (
  monitor TEXT NOT NULL,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  PRIMARY KEY (monitor, ts)
);

CREATE TABLE IF NOT EXISTS monitor_minutes (
  monitor TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  checks INTEGER NOT NULL,
  downs INTEGER NOT NULL,
  latency_ms INTEGER,
  PRIMARY KEY (monitor, minute_ts)
);
