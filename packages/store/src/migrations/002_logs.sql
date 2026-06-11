CREATE TABLE IF NOT EXISTS logs (
  id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  strategy_id TEXT,
  level TEXT NOT NULL,
  logger TEXT NOT NULL,
  message TEXT NOT NULL,
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (instance_id, id)
);
CREATE INDEX IF NOT EXISTS idx_logs_lookup ON logs (instance_id, level, ts);
CREATE INDEX IF NOT EXISTS idx_logs_strategy ON logs (instance_id, strategy_id, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5 (
  text, instance_id UNINDEXED, log_rowid UNINDEXED, tokenize = 'porter'
);
