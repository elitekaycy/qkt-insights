-- Each change of place of a member in a strategy's moving symbol set, from set.membership (contract 1.7.0): a
-- member joined, left, went sticky while it held, was released, stayed, was restored on a restart, or could not be
-- subscribed. `close_ts` is the close of the window whose evaluation made the change, `ts` the envelope's. One row
-- per envelope id; operational history pruned after the retention window, except each member's latest change
-- (retention.ts).
CREATE TABLE IF NOT EXISTS set_membership (
  instance_id TEXT NOT NULL,
  id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  set_name TEXT NOT NULL,
  member TEXT NOT NULL,
  change TEXT NOT NULL,
  rank INTEGER,
  close_ts INTEGER NOT NULL,
  reason TEXT,
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (instance_id, id)
);
CREATE INDEX IF NOT EXISTS idx_set_membership_strategy ON set_membership (instance_id, strategy_id, ts);
CREATE INDEX IF NOT EXISTS idx_set_membership_member ON set_membership (instance_id, strategy_id, set_name, member, ts);
