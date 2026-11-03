-- The stop-loss and take-profit the venue held on each open position, one row each time either changed
-- (a trailing or break-even stop moved, a target was set or removed), from state.positions. NULL is "none
-- at the venue". The trade drawer draws the stop and target as steps from these rows. Pruned with the
-- position's marks (retention.ts): rows of closed positions older than the retention window.
CREATE TABLE IF NOT EXISTS position_levels (
  instance_id TEXT NOT NULL,
  broker TEXT NOT NULL,
  ticket TEXT NOT NULL,
  ts INTEGER NOT NULL,
  stop REAL,
  target REAL,
  PRIMARY KEY (instance_id, broker, ticket, ts)
);
CREATE INDEX IF NOT EXISTS idx_position_levels_ticket ON position_levels (instance_id, ticket, ts);
