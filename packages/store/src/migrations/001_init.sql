CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  name TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT -1
);

CREATE TABLE IF NOT EXISTS strategies (
  instance_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  equity REAL,
  starting_balance REAL,
  PRIMARY KEY (instance_id, strategy_id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  type TEXT NOT NULL,
  strategy_id TEXT,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (instance_id, id)
);
CREATE INDEX IF NOT EXISTS idx_events_lookup ON events (instance_id, type, ts);
CREATE INDEX IF NOT EXISTS idx_events_strategy ON events (instance_id, strategy_id, ts);

CREATE TABLE IF NOT EXISTS orders (
  instance_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  strategy_id TEXT,
  symbol TEXT,
  side TEXT,
  type TEXT,
  state TEXT NOT NULL,
  qty REAL,
  cum_qty REAL NOT NULL DEFAULT 0,
  avg_price REAL,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  last_event_seq INTEGER NOT NULL DEFAULT -1,
  PRIMARY KEY (instance_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_lookup ON orders (instance_id, strategy_id, state, updated_ts);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  instance_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  realized REAL NOT NULL,
  unrealized REAL NOT NULL,
  equity REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_equity_lookup ON equity_snapshots (instance_id, strategy_id, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5 (
  text, instance_id UNINDEXED, event_rowid UNINDEXED, tokenize = 'porter'
);
