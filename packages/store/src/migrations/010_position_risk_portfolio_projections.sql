CREATE TABLE IF NOT EXISTS positions_current (
  instance_id TEXT NOT NULL,
  broker TEXT NOT NULL,
  ticket TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  entry_price REAL NOT NULL,
  current_price REAL,
  profit REAL,
  swap REAL,
  opened_at INTEGER,
  strategy_id TEXT,
  last_seen INTEGER NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT -1,
  PRIMARY KEY (instance_id, broker, ticket)
);
CREATE INDEX IF NOT EXISTS idx_positions_current_lookup
  ON positions_current (instance_id, strategy_id, symbol, last_seen);

CREATE TABLE IF NOT EXISTS position_valuations (
  instance_id TEXT NOT NULL,
  broker TEXT NOT NULL,
  ticket TEXT NOT NULL,
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  entry_price REAL NOT NULL,
  current_price REAL,
  profit REAL,
  swap REAL,
  strategy_id TEXT,
  PRIMARY KEY (instance_id, broker, ticket, ts)
);
CREATE INDEX IF NOT EXISTS idx_position_valuations_lookup
  ON position_valuations (instance_id, strategy_id, symbol, ts);

CREATE TABLE IF NOT EXISTS position_reconciliations (
  instance_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  strategy_id TEXT,
  symbol TEXT NOT NULL,
  old_qty REAL,
  new_qty REAL NOT NULL,
  old_avg_px REAL,
  new_avg_px REAL,
  source TEXT,
  reason TEXT,
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (instance_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_position_reconciliations_lookup
  ON position_reconciliations (instance_id, symbol, ts);

CREATE TABLE IF NOT EXISTS risk_events (
  instance_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  strategy_id TEXT,
  kind TEXT NOT NULL,
  reason TEXT,
  symbol TEXT,
  side TEXT,
  qty REAL,
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (instance_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_risk_events_lookup
  ON risk_events (instance_id, strategy_id, ts);

CREATE TABLE IF NOT EXISTS risk_snapshots (
  instance_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  strategy_id TEXT,
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (instance_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_risk_snapshots_lookup
  ON risk_snapshots (instance_id, strategy_id, ts);

CREATE TABLE IF NOT EXISTS portfolio_allocations (
  instance_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (instance_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_allocations_lookup
  ON portfolio_allocations (instance_id, portfolio_id, ts);

CREATE TABLE IF NOT EXISTS portfolio_exposure (
  instance_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (instance_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_exposure_lookup
  ON portfolio_exposure (instance_id, portfolio_id, ts);

CREATE TABLE IF NOT EXISTS portfolio_equity (
  instance_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  equity REAL,
  realized REAL,
  unrealized REAL,
  payload TEXT NOT NULL,
  PRIMARY KEY (instance_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_equity_lookup
  ON portfolio_equity (instance_id, portfolio_id, ts);
