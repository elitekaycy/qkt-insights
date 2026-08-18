-- The instance's currently-deployed strategy roster, replaced wholesale on each
-- instance.roster envelope. Lets /strategies mark ids that only linger from a prior
-- bench topology (e.g. after a reshard) as retired instead of counting them live.
CREATE TABLE IF NOT EXISTS instance_roster (
  instance_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (instance_id, strategy_id)
);
