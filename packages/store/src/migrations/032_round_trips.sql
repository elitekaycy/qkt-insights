-- Round trips: one row per venue position, entry to exit, kept by the closed_trades projection's
-- position reducer (projections.ts) so filters, sorts and totals over trades are index reads.
--   side: the position's direction, 'long' or 'short'. instrument: the symbol without its broker
--   profile prefix. entry_price / exit_price: size-weighted over the IN / closing legs; exit_ts the
--   latest closing leg. qty: the IN volume (the closed volume when no IN leg was stored).
--   realized = gross + commission + swap + fee over every canonical leg of the position (so the
--   round trips of closed positions add up to the net of their deals to the cent); gross is the
--   venue profit before costs. legs: canonical legs.
--   entry_order_id: the engine order whose broker id is the IN leg's order ticket (entry_order_ticket).
--   stop_price / target_price: the bracket of that order's order.submit near the entry.
--   ended: 'stop' | 'tp' | 'so' from the closing deal's venue comment ([sl / [tp / [so), else
--   'manual' for a `qkt bot close` of the ticket, 'signal' for an engine order closing the ticket,
--   NULL when nothing says (never guessed). A value read from events is kept once the events age out.
--   open: 1 for a position with an IN leg that its closing legs have not fully closed.
CREATE TABLE IF NOT EXISTS round_trips (
  instance_id TEXT NOT NULL,
  position_ticket TEXT NOT NULL,
  broker TEXT,
  strategy_id TEXT,
  instrument TEXT NOT NULL,
  symbol TEXT,
  side TEXT NOT NULL,
  entry_ts INTEGER,
  entry_price REAL,
  exit_ts INTEGER,
  exit_price REAL,
  qty REAL,
  realized REAL NOT NULL,
  gross REAL NOT NULL,
  commission REAL NOT NULL,
  swap REAL NOT NULL,
  fee REAL NOT NULL,
  legs INTEGER NOT NULL,
  entry_order_id TEXT,
  entry_order_ticket TEXT,
  stop_price REAL,
  target_price REAL,
  ended TEXT,
  hold_ms INTEGER,
  open INTEGER NOT NULL,
  PRIMARY KEY (instance_id, position_ticket)
) WITHOUT ROWID;
-- The Trades filters and sorts: newest exit first overall, per strategy, per instrument; by P&L,
-- hold time, side and how it ended.
CREATE INDEX IF NOT EXISTS idx_round_trips_exit ON round_trips (instance_id, exit_ts);
CREATE INDEX IF NOT EXISTS idx_round_trips_strategy ON round_trips (instance_id, strategy_id, exit_ts);
CREATE INDEX IF NOT EXISTS idx_round_trips_instrument ON round_trips (instance_id, instrument, exit_ts);
CREATE INDEX IF NOT EXISTS idx_round_trips_realized ON round_trips (instance_id, realized);
CREATE INDEX IF NOT EXISTS idx_round_trips_held ON round_trips (instance_id, hold_ms);
CREATE INDEX IF NOT EXISTS idx_round_trips_side ON round_trips (instance_id, side, exit_ts);
CREATE INDEX IF NOT EXISTS idx_round_trips_ended ON round_trips (instance_id, ended, exit_ts);

-- An engine order learning its broker id links the position whose IN leg carries that ticket
-- (ingest marks it, write.ts markRoundTrips).
CREATE INDEX IF NOT EXISTS idx_deals_order ON deals (instance_id, order_ticket);
