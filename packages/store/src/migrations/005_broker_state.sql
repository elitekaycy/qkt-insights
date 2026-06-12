CREATE TABLE deals (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  broker TEXT NOT NULL,
  deal_ticket TEXT NOT NULL,
  position_ticket TEXT,
  order_ticket TEXT,
  symbol TEXT,
  side TEXT,
  entry TEXT,
  qty REAL,
  price REAL,
  profit REAL,
  commission REAL,
  swap REAL,
  magic INTEGER,
  comment TEXT,
  strategy_id TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_deals_lookup ON deals (instance_id, ts);
CREATE INDEX idx_deals_strategy ON deals (instance_id, strategy_id, ts);

CREATE TABLE account_equity (
  instance_id TEXT NOT NULL,
  broker TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  balance REAL,
  equity REAL,
  open_profit REAL,
  PRIMARY KEY (instance_id, broker, minute_ts)
);
