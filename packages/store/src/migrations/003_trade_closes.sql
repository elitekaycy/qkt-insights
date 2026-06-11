CREATE TABLE IF NOT EXISTS trade_closes (
  id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  strategy_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  realized REAL NOT NULL,
  entry_ts INTEGER,
  ts INTEGER NOT NULL,
  PRIMARY KEY (instance_id, id)
);
CREATE INDEX IF NOT EXISTS idx_trade_closes_lookup ON trade_closes (instance_id, strategy_id, ts);
