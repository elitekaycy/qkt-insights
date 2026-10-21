-- Per strategy and UTC day of the close: the day's net (closes summed in close order), its number
-- of closes, and the running realized total at the day's last close. `source` is where the closes
-- came from: 'deal' (closed_trades) or 'ledger' (trade_closes, engines without polled deals).
-- Maintained in the transaction that changed the closes; serves the calendar, daily nets, the
-- rolling stats and the deals-rebuilt end-of-day equity in O(days).
CREATE TABLE IF NOT EXISTS strategy_daily (
  instance_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  source TEXT NOT NULL,
  day TEXT NOT NULL,
  net REAL NOT NULL,
  trades INTEGER NOT NULL,
  close_cum REAL NOT NULL,
  last_ts INTEGER NOT NULL,
  PRIMARY KEY (instance_id, strategy_id, source, day)
) WITHOUT ROWID;

-- Per strategy and source: the number of closes, their total summed newest first (the order the
-- strategy list adds them in), the first close (the equity curve's anchor) and the newest one.
CREATE TABLE IF NOT EXISTS strategy_totals (
  instance_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  source TEXT NOT NULL,
  closes INTEGER NOT NULL,
  net_newest_first REAL,
  first_ts INTEGER,
  first_entry_ts INTEGER,
  last_ts INTEGER,
  PRIMARY KEY (instance_id, strategy_id, source)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS trade_closes_projection_insert AFTER INSERT ON trade_closes WHEN NEW.strategy_id IS NOT NULL BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT 'daily', NEW.instance_id, k.key FROM (SELECT 'ledger' || char(0) || NEW.strategy_id || char(0) || date(NEW.ts / 1000, 'unixepoch') key) k
  WHERE NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind='daily' AND d.instance_id=NEW.instance_id AND d.key=k.key);
END;

CREATE TRIGGER IF NOT EXISTS trade_closes_projection_update AFTER UPDATE ON trade_closes BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT 'daily', q.instance_id, q.key FROM (
    SELECT OLD.instance_id instance_id, 'ledger' || char(0) || OLD.strategy_id || char(0) || date(OLD.ts / 1000, 'unixepoch') key WHERE OLD.strategy_id IS NOT NULL
    UNION SELECT NEW.instance_id, 'ledger' || char(0) || NEW.strategy_id || char(0) || date(NEW.ts / 1000, 'unixepoch') WHERE NEW.strategy_id IS NOT NULL
  ) q
  WHERE NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind='daily' AND d.instance_id=q.instance_id AND d.key=q.key);
END;

CREATE TRIGGER IF NOT EXISTS trade_closes_projection_delete AFTER DELETE ON trade_closes WHEN OLD.strategy_id IS NOT NULL BEGIN
  INSERT INTO projection_dirty (kind, instance_id, key)
  SELECT 'daily', OLD.instance_id, k.key FROM (SELECT 'ledger' || char(0) || OLD.strategy_id || char(0) || date(OLD.ts / 1000, 'unixepoch') key) k
  WHERE NOT EXISTS (SELECT 1 FROM projection_dirty d WHERE d.kind='daily' AND d.instance_id=OLD.instance_id AND d.key=k.key);
END;

INSERT OR IGNORE INTO projections (name, version) VALUES ('strategy_daily', 0);
