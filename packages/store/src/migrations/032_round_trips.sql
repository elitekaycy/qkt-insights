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

-- An engine order learning its broker id links the position whose IN leg carries that ticket.
CREATE INDEX IF NOT EXISTS idx_deals_order ON deals (instance_id, order_ticket);

CREATE TRIGGER IF NOT EXISTS orders_round_trip_insert AFTER INSERT ON orders WHEN NEW.broker_order_id IS NOT NULL BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT DISTINCT 'position', d.instance_id, 'p:' || d.position_ticket FROM deals d INDEXED BY idx_deals_order
  WHERE d.instance_id=NEW.instance_id AND d.order_ticket=NEW.broker_order_id AND d.position_ticket IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM projection_dirty q WHERE q.kind='position' AND q.instance_id=d.instance_id AND q.key='p:' || d.position_ticket);
END;

CREATE TRIGGER IF NOT EXISTS orders_round_trip_update AFTER UPDATE OF broker_order_id ON orders
WHEN NEW.broker_order_id IS NOT NULL AND OLD.broker_order_id IS NOT NEW.broker_order_id BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT DISTINCT 'position', d.instance_id, 'p:' || d.position_ticket FROM deals d INDEXED BY idx_deals_order
  WHERE d.instance_id=NEW.instance_id AND d.order_ticket=NEW.broker_order_id AND d.position_ticket IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM projection_dirty q WHERE q.kind='position' AND q.instance_id=d.instance_id AND q.key='p:' || d.position_ticket);
END;

-- The engine events a round trip reads: the opening order's bracket, a close order for the ticket,
-- a `qkt bot close`, and a fill naming its broker ticket.
-- Each branch is one index seek (the position or the order-ticket index).
CREATE TRIGGER IF NOT EXISTS events_round_trip_insert AFTER INSERT ON events
WHEN NEW.type IN ('order.submit', 'order.filled', 'bot.close') BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT 'position', NEW.instance_id, 'p:' || p.ticket FROM (
    SELECT d.position_ticket ticket FROM deals d WHERE d.instance_id=NEW.instance_id AND d.position_ticket=json_extract(NEW.payload, '$.ticket')
    UNION SELECT d.position_ticket FROM deals d WHERE d.instance_id=NEW.instance_id AND d.position_ticket=json_extract(NEW.payload, '$.closesTicket')
    UNION SELECT d.position_ticket FROM deals d INDEXED BY idx_deals_order WHERE d.instance_id=NEW.instance_id AND d.order_ticket=json_extract(NEW.payload, '$.brokerOrderId')
    UNION SELECT d.position_ticket FROM orders o JOIN deals d INDEXED BY idx_deals_order ON d.instance_id=o.instance_id AND d.order_ticket=o.broker_order_id
      WHERE o.instance_id=NEW.instance_id AND o.order_id=json_extract(NEW.payload, '$.orderId')
  ) p
  WHERE p.ticket IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM projection_dirty q WHERE q.kind='position' AND q.instance_id=NEW.instance_id AND q.key='p:' || p.ticket);
END;
