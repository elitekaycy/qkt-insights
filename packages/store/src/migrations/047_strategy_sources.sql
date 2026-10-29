-- Each version of a strategy's source as strategy.started stated it, once per (instance, strategy, sha256 of
-- the whole file). text is NULL when this collector never received it: qkt sent none (an older qkt), or left it
-- out (omitted = 1) because it had sent it before at this sha. starts counts the starts seen at this version.
CREATE TABLE IF NOT EXISTS strategy_sources (
  instance_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  path TEXT,
  dsl_version INTEGER,
  text TEXT,
  truncated INTEGER,
  omitted INTEGER NOT NULL DEFAULT 0,
  starts INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (instance_id, strategy_id, sha256)
);
