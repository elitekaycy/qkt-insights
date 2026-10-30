-- Each configuration a strategy has run on, as strategy.started stated it, once per (instance, strategy, sha256 of
-- the config). config is NULL when this collector never received it: qkt left it out (omitted = 1) because it had
-- sent it before at this sha. Admin only: no public view reads this table (api publicView.ts).
CREATE TABLE IF NOT EXISTS strategy_configs (
  instance_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  config TEXT,
  omitted INTEGER NOT NULL DEFAULT 0,
  starts INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (instance_id, strategy_id, sha256)
);
